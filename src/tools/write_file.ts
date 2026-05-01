/** Tool: write or append content to a file within an allowed path, creating parent directories on demand. */

import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import type { Tool, ToolResult, ToolContext } from './types.js';
import { checkAndRecordWrite } from '../safety/writeRateLimit.js';

/** Maximum content size per write call: 10MB (V-12 fix). */
const MAX_CONTENT_BYTES = 10 * 1024 * 1024; // 10 MB

const WriteFileInput = z.object({
  path: z.string().min(1).describe('Absolute path to write to'),
  content: z.string().max(MAX_CONTENT_BYTES, 'Content exceeds 10MB limit').describe('File content to write'),
  createDirs: z.boolean().default(true).describe('Create parent directories if they do not exist'),
  append: z.boolean().default(false).describe('Append to existing file instead of overwriting'),
});

type WriteFileInputType = z.infer<typeof WriteFileInput>;

const writeFileTool: Tool = {
  name: 'write_file',
  description:
    'Write or create a file. Path must be within an allowed directory. ' +
    'Set append=true to append instead of overwriting. ' +
    'Parent directories are created automatically unless createDirs=false.',
  parameters: WriteFileInput,
  destructive: false, // Overwrites are confirmed if the file exists and is large — future enhancement

  async execute(input: WriteFileInputType, ctx: ToolContext): Promise<ToolResult> {
    const log = ctx.logger.child({ component: 'tools.write_file' });

    // Filesystem write rate limit (hardening: max 10 writes/min per session)
    const rl = checkAndRecordWrite(ctx.sessionId);
    if (!rl.allowed) {
      const retryAfterSec = Math.ceil(rl.retryAfterMs / 1000);
      log.warn({ sessionId: ctx.sessionId, retryAfterSec }, 'write_file: rate limit exceeded');
      return {
        ok: false,
        output: `Write rate limit exceeded (max 10 writes per minute). Retry in ${retryAfterSec}s.`,
        error: { code: 'WRITE_RATE_LIMIT', message: `Rate limit: retry in ${retryAfterSec}s` },
      };
    }

    // Path sandbox check (write path — may not exist yet).
    // Uses isWriteAllowed which combines isPathAllowed + write denylist
    // (.env, *.db, logs/**, data/**, etc.) — F-01 fix.
    if (!ctx.safety.isWriteAllowed(input.path)) {
      log.warn({ path: input.path }, 'write_file: path rejected by write sandbox');
      return {
        ok: false,
        output: `Access denied: "${input.path}" is outside the allowed paths or matches a write-protected pattern.`,
        error: { code: 'PATH_DENIED', message: `Path not allowed for writing: ${input.path}` },
      };
    }

    try {
      const dir = path.dirname(input.path);

      if (input.createDirs && !fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const flags = input.append ? 'a' : 'w';
      fs.writeFileSync(input.path, input.content, { encoding: 'utf8', flag: flags });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ path: input.path, err: message }, 'write_file error');
      return {
        ok: false,
        output: `Failed to write "${input.path}": ${message}`,
        error: { code: 'WRITE_ERROR', message },
      };
    }

    const size = input.content.length;
    log.info({ path: input.path, bytes: size, append: input.append }, 'write_file completed');

    return {
      ok: true,
      output: `${input.append ? 'Appended' : 'Wrote'} ${size} bytes to "${input.path}".`,
      data: { path: input.path, bytes: size, append: input.append },
    };
  },
};

export default writeFileTool;
