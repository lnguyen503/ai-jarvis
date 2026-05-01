/** Tool: execute a shell command (PowerShell or cmd) and return stdout/stderr, capped at maxOutputLength. */

import { z } from 'zod';
import { execa } from 'execa';
// tree-kill is a CommonJS package; we use a dynamic import with type assertion
// to keep this ESM file compatible. The package is declared as a dependency.
import treeKillCb from 'tree-kill';
import type { Tool, ToolResult, ToolContext } from './types.js';

/** Maximum combined stdout+stderr before we truncate (hardened: 100KB). */
const MAX_OUTPUT_BYTES = 100 * 1024; // 100 KB

const RunCommandInput = z.object({
  shell: z.enum(['powershell', 'cmd', 'none']).default('powershell'),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  cwd: z.string().optional(),
});

type RunCommandInputType = z.infer<typeof RunCommandInput>;

const PREVIEW_BYTES = 1024; // max 1KB for stdout_preview / stderr_preview

/**
 * Synchronously kill a process tree using tree-kill.
 * On Windows this uses taskkill /T /F /PID.
 * Returns a Promise that resolves when the kill has been dispatched (best-effort).
 */
function killProcessTree(pid: number): Promise<void> {
  return new Promise<void>((resolve) => {
    treeKillCb(pid, 'SIGKILL', (err) => {
      if (err) {
        // Best-effort: log but do not throw. The process may have already exited.
      }
      resolve();
    });
  });
}

const runCommandTool: Tool = {
  name: 'run_command',
  description:
    'Execute a shell command on the Windows host. ' +
    'Use shell=powershell for PowerShell commands, shell=cmd for cmd.exe, ' +
    'shell=none for direct argv execution (safer, no shell injection). ' +
    'Returns stdout + stderr, truncated to 100KB. ' +
    'Commands are logged to the audit trail.',
  parameters: RunCommandInput,
  destructive: false, // destructive classification happens in dispatcher via safety.classifyCommand

  async execute(input: RunCommandInputType, ctx: ToolContext): Promise<ToolResult> {
    const log = ctx.logger.child({ component: 'tools.run_command' });
    const timeout = ctx.config.safety.commandTimeoutMs;

    // V-09: validate cwd against the path sandbox before executing
    if (input.cwd !== undefined) {
      if (!ctx.safety.isPathAllowed(input.cwd)) {
        log.warn({ cwd: input.cwd }, 'run_command: cwd rejected by path sandbox');
        return {
          ok: false,
          output: `Access denied: cwd "${input.cwd}" is outside the allowed paths.`,
          error: { code: 'PATH_DENIED', message: `cwd not in allowed paths: ${input.cwd}` },
        };
      }
    }

    const cwd = input.cwd ?? process.cwd();

    // Self-kill guard: refuse any command that targets ai-jarvis's own PID.
    // Regression: agent ran `netstat | grep 7878`, got its own PID back (since
    // 7878 is the health port), then asked to `Stop-Process -Id <ownPid>`. The
    // destructive-confirm prompt is not enough — the user can't be expected to
    // recognize their own agent's PID in a kill command. This runs even after
    // confirmation, because no confirmation should authorize suicide.
    const ownPid = process.pid;
    const selfKillPattern = new RegExp(
      `\\b(stop-process|taskkill|kill)\\b[^\\r\\n]*\\b(?:-id|/pid|-pid)?\\s*["']?${ownPid}\\b`,
      'i',
    );
    if (selfKillPattern.test(input.command)) {
      log.warn(
        { command: input.command, ownPid },
        'run_command: refusing to kill ai-jarvis own process',
      );
      return {
        ok: false,
        output:
          `Refused: command targets ai-jarvis's own PID (${ownPid}). ` +
          `If you need to restart ai-jarvis, do it from outside the agent (Task Manager or a separate shell).`,
        error: { code: 'SELF_KILL_BLOCKED', message: `refused to kill own pid ${ownPid}` },
      };
    }

    // Safety classification is the sole responsibility of the agent (agent/index.ts).
    // The agent gates hardReject and destructive BEFORE calling dispatch(), so by the
    // time execute() is reached the command has already been approved. A second
    // classifyCommand() call here would create two divergent gate points that can
    // disagree on timing-sensitive config changes and mislead future maintainers.

    const startMs = Date.now();
    let stdout = '';
    let stderr = '';
    let exitCode: number | null = null;
    let killed = false;
    let childPid: number | undefined;

    try {
      log.info({ command: input.command, shell: input.shell, cwd }, 'Running command');

      // Result shape from execa (types are loose due to overloads — we treat as unknown-ish).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let result: any;

      if (input.shell === 'none' && input.args) {
        result = await execa(input.command, input.args, {
          cwd,
          timeout,
          cancelSignal: ctx.abortSignal,
          reject: false,
        });
      } else {
        const shellExe =
          input.shell === 'powershell'
            ? 'powershell.exe'
            : input.shell === 'cmd'
              ? 'cmd.exe'
              : undefined;

        result = await execa(input.command, {
          shell: shellExe ?? true,
          cwd,
          timeout,
          cancelSignal: ctx.abortSignal,
          reject: false,
        });
      }

      childPid = typeof result?.pid === 'number' ? result.pid : undefined;
      stdout = typeof result?.stdout === 'string' ? result.stdout : '';
      stderr = typeof result?.stderr === 'string' ? result.stderr : '';
      exitCode = typeof result?.exitCode === 'number' ? result.exitCode : null;
    } catch (err: unknown) {
      if (ctx.abortSignal.aborted) {
        killed = true;
        // V-18: tree-kill the process tree on /stop
        if (childPid !== undefined) {
          await killProcessTree(childPid);
        }
        stdout = '';
        stderr = 'Process killed by /stop command.';
        exitCode = -1;
      } else if (
        err !== null &&
        typeof err === 'object' &&
        'timedOut' in err &&
        (err as { timedOut?: boolean }).timedOut
      ) {
        killed = true;
        // V-18: tree-kill the process tree on timeout
        const pid =
          err !== null &&
          typeof err === 'object' &&
          'pid' in err &&
          typeof (err as { pid?: unknown }).pid === 'number'
            ? (err as { pid: number }).pid
            : childPid;
        if (pid !== undefined) {
          await killProcessTree(pid);
        }
        stdout = '';
        stderr = `Command timed out after ${timeout}ms.`;
        exitCode = -1;
      } else {
        const message = err instanceof Error ? err.message : String(err);
        stdout = '';
        stderr = message;
        exitCode = -1;
      }
    }

    const durationMs = Date.now() - startMs;

    // Scrub secrets from output before logging or returning
    const scrubbedStdout = ctx.safety.scrub(stdout);
    const scrubbedStderr = ctx.safety.scrub(stderr);

    // Audit log (after scrubbing)
    ctx.memory.commandLog.insert({
      session_id: ctx.sessionId,
      command: input.command,
      working_dir: cwd,
      exit_code: exitCode,
      stdout_preview: scrubbedStdout.slice(0, PREVIEW_BYTES),
      stderr_preview: scrubbedStderr.slice(0, PREVIEW_BYTES),
      duration_ms: durationMs,
      killed,
    });

    log.info(
      { command: input.command, exitCode, durationMs, killed },
      'Command completed',
    );

    if (killed) {
      const reason = ctx.abortSignal.aborted ? 'Stopped by /stop command.' : 'Timed out.';
      return {
        ok: false,
        output: `Command killed: ${reason}\n${scrubbedStderr}`,
        data: { exitCode, durationMs, killed: true },
        error: { code: 'CMD_TIMEOUT', message: reason },
      };
    }

    const combined = [
      scrubbedStdout.trim() ? `stdout:\n${scrubbedStdout}` : '',
      scrubbedStderr.trim() ? `stderr:\n${scrubbedStderr}` : '',
    ]
      .filter(Boolean)
      .join('\n\n');

    // Hardened output cap: 100KB (V-18 hardening item)
    let truncated: string;
    if (combined.length > MAX_OUTPUT_BYTES) {
      truncated =
        combined.slice(0, MAX_OUTPUT_BYTES) +
        `\n\n⚠️ [Output truncated: exceeded 100KB limit (${combined.length} bytes total)]`;
    } else if (combined.length > ctx.config.safety.maxOutputLength) {
      truncated = `${combined.slice(0, ctx.config.safety.maxOutputLength)}\n… [truncated]`;
    } else {
      truncated = combined;
    }

    return {
      ok: exitCode === 0 || exitCode === null,
      output: truncated || '(no output)',
      data: { exitCode, durationMs },
    };
  },
};

export default runCommandTool;
