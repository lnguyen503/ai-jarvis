import type { Context } from 'grammy';
import type { AppConfig } from '../config/index.js';
import type { MemoryApi } from '../memory/index.js';
import type { ChatQueueManager } from './chatQueue.js';
import { htmlEscape } from './html.js';
import os from 'os';

/**
 * Gateway command router (ARCH §5, §8).
 *
 * All replies use parse_mode=HTML. Dynamic values (hostnames, paths, commands,
 * project names) are HTML-escaped. Underscores in hostnames like "The_Beast"
 * don't confuse the HTML parser (unlike Markdown).
 *
 * /start    — welcome + capabilities
 * /status   — system info (uptime/CPU/RAM/disk)
 * /stop     — abort active turn + clear THIS chat's userQueue (schedulerQueue preserved)
 * /stop all — abort active turn + clear BOTH queues
 * /projects — list configured projects
 * /history  — recent command history
 * /clear    — archive current session (start fresh)
 * /help     — list all commands
 */

function formatBytes(bytes: number): string {
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(2)} GB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export interface CommandDeps {
  config: AppConfig;
  memory: MemoryApi;
  queueManager: ChatQueueManager;
  processStart: number;
  version: string;
}

export async function handleStart(ctx: Context, deps: CommandDeps): Promise<void> {
  const tools = [
    'run_command',
    'read_file',
    'write_file',
    'list_directory',
    'search_files',
    'system_info',
  ];
  const msg =
    `<b>Jarvis online</b> (v${htmlEscape(deps.version)})\n\n` +
    `I'm your personal AI assistant. I can run commands, manage files, and help with development tasks.\n\n` +
    `<b>Available tools:</b>\n${tools.map((t) => `• <code>${t}</code>`).join('\n')}\n\n` +
    `<b>Commands:</b> /status /stop /projects /history /clear /help\n\n` +
    `Send me a text or voice message to get started.`;
  await ctx.reply(msg, { parse_mode: 'HTML' });
}

export async function handleStatus(ctx: Context, deps: CommandDeps): Promise<void> {
  const uptimeSec = Math.floor((Date.now() - deps.processStart) / 1000);
  const h = Math.floor(uptimeSec / 3600);
  const m = Math.floor((uptimeSec % 3600) / 60);
  const s = uptimeSec % 60;

  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const memPct = ((usedMem / totalMem) * 100).toFixed(1);

  const cpus = os.cpus();
  const loadAvg = os.loadavg();

  const msg =
    `<b>Jarvis Status</b>\n` +
    `• Uptime: ${h}h ${m}m ${s}s\n` +
    `• CPU: ${cpus.length} cores, load ${(loadAvg[0] ?? 0).toFixed(2)}\n` +
    `• Memory: ${formatBytes(usedMem)} / ${formatBytes(totalMem)} (${memPct}%)\n` +
    `• Node: ${htmlEscape(process.version)}\n` +
    `• Host: ${htmlEscape(os.hostname())}`;
  await ctx.reply(msg, { parse_mode: 'HTML' });
}

export async function handleStop(ctx: Context, deps: CommandDeps): Promise<void> {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) return;

  const text = ctx.message?.text ?? '';
  const isStopAll = /\/stop\s+all/i.test(text);

  const cleared = isStopAll
    ? deps.queueManager.stopAll(chatId)
    : deps.queueManager.stop(chatId);

  const suffix = isStopAll ? ' (both queues cleared)' : ' (scheduled tasks preserved)';
  await ctx.reply(`Stopped ${cleared} task(s)${suffix}.`);
}

export async function handleProjects(ctx: Context, deps: CommandDeps): Promise<void> {
  const projects = deps.memory.projects.list();
  if (projects.length === 0) {
    await ctx.reply('No projects configured.');
    return;
  }
  const lines = projects.map(
    (p) => `• <b>${htmlEscape(p.name)}</b> — <code>${htmlEscape(p.path)}</code>`,
  );
  await ctx.reply(`<b>Projects:</b>\n${lines.join('\n')}`, { parse_mode: 'HTML' });
}

export async function handleHistory(ctx: Context, deps: CommandDeps): Promise<void> {
  // Intentionally uses the global listRecent (not listForSession) — this is a
  // single-user system so global == user-scoped. Explicit exception to W3 session-
  // scoping invariant; multi-user builds should switch to listForSession(sessionId, 10).
  const entries = deps.memory.commandLog.listRecent(10);
  if (entries.length === 0) {
    await ctx.reply('No command history.');
    return;
  }
  const lines = entries
    .filter((e) => !e.command.startsWith('__')) // skip synthetic confirmation/scheduler rows
    .map((e) => {
      const cmd = e.command.length > 60 ? `${e.command.slice(0, 60)}…` : e.command;
      const status = e.exit_code === 0 ? '✓' : e.killed ? '⏹' : '✗';
      return `${status} <code>${htmlEscape(cmd)}</code> (${e.duration_ms ?? '?'}ms)`;
    });
  await ctx.reply(`<b>Recent commands:</b>\n${lines.join('\n')}`, { parse_mode: 'HTML' });
}

export async function handleClear(ctx: Context, deps: CommandDeps): Promise<void> {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) return;
  const session = deps.memory.sessions.getOrCreate(chatId);
  deps.memory.sessions.archive(session.id, chatId);
  await ctx.reply('Session cleared. Starting fresh.');
}

export async function handleHelp(ctx: Context, deps: CommandDeps): Promise<void> {
  const isAdmin =
    ctx.from?.id !== undefined && deps.config.groups.adminUserIds.includes(ctx.from.id);

  let msg =
    `<b>Jarvis Commands</b>\n\n` +
    `/start — welcome\n` +
    `/status — system info\n` +
    `/stop — abort current task + clear user queue\n` +
    `/stop all — abort + clear all queues\n` +
    `/projects — list projects\n` +
    `/history — recent commands\n` +
    `/clear — reset conversation\n` +
    `/model — show or set the AI model for this session\n` +
    `/cost — show token usage and cost estimate for this session\n` +
    `/search &lt;query&gt; — fast web search (bypasses agent, powered by Tavily)\n` +
    `/compact — manually compact conversation context\n` +
    `/help — this message\n\n` +
    `Send text or voice messages to interact with the agent.\n` +
    `Destructive commands require <code>YES &lt;actionId&gt;</code> confirmation.`;

  if (isAdmin) {
    msg +=
      `\n\n<b>Admin commands (groups):</b>\n` +
      `/jarvis_enable — enable Jarvis in this group\n` +
      `/jarvis_disable — disable Jarvis in this group\n` +
      `/jarvis_users — show per-user stats for this group\n` +
      `/jarvis_limit &lt;user_id&gt; &lt;n&gt; — set per-user rate limit override`;
  }

  await ctx.reply(msg, { parse_mode: 'HTML' });
}
