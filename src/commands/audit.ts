/**
 * /audit command (admin-only, v1.6.0).
 *
 * Shows the last 50 audit_log entries as an HTML-formatted Telegram message.
 * Only available to adminUserIds. Returns plain-text fallback if HTML parsing fails.
 */

import type { Context } from 'grammy';
import type { AppConfig } from '../config/index.js';
import type { MemoryApi } from '../memory/index.js';
import { htmlEscape } from '../gateway/html.js';
import { isGroupChat } from '../gateway/groupGate.js';
import { child } from '../logger/index.js';

const log = child({ component: 'commands.audit' });

export interface AuditCommandDeps {
  config: AppConfig;
  memory: MemoryApi;
}

/** Maximum number of entries shown in /audit output. */
const AUDIT_DISPLAY_COUNT = 50;

export async function handleAudit(ctx: Context, deps: AuditCommandDeps): Promise<void> {
  const userId = ctx.from?.id;

  // Admin-only in all contexts
  if (!deps.config.groups.adminUserIds.includes(userId ?? -1)) {
    await ctx.reply('Admin only.').catch(() => {});
    log.warn({ userId, chatId: ctx.chat?.id }, '/audit rejected: non-admin');
    return;
  }

  // In group mode, extra caution: audit log may contain DM session data
  if (isGroupChat(ctx)) {
    await ctx
      .reply('⚠️ Audit log is sensitive. Use /audit in DM only.')
      .catch(() => {});
    return;
  }

  const rows = deps.memory.auditLog.listRecent(AUDIT_DISPLAY_COUNT);
  log.info({ userId, count: rows.length }, '/audit requested');

  if (rows.length === 0) {
    await ctx.reply('No audit log entries yet.').catch(() => {});
    return;
  }

  const lines = rows.map((r) => {
    let detail = '';
    try {
      const parsed = JSON.parse(r.detail_json) as Record<string, unknown>;
      detail = Object.entries(parsed)
        .slice(0, 3) // keep it short
        .map(([k, v]) => `${k}=${String(v).slice(0, 40)}`)
        .join(' ');
    } catch {
      detail = r.detail_json.slice(0, 80);
    }
    const ts = r.ts.replace('T', ' ').slice(0, 19);
    const session = r.session_id !== null ? ` s=${r.session_id}` : '';
    return `<code>${htmlEscape(ts)}</code> [${htmlEscape(r.category)}${session}] ${htmlEscape(detail)}`;
  });

  const header = `<b>Audit Log (last ${rows.length}):</b>\n\n`;
  const body = lines.join('\n');
  const msg = header + body;

  // Telegram message limit is ~4096 chars; truncate if needed
  const truncated =
    msg.length > 4000
      ? msg.slice(0, 4000) + '\n… [truncated]'
      : msg;

  try {
    await ctx.reply(truncated, { parse_mode: 'HTML' });
  } catch {
    // Fallback to plain text if HTML fails
    await ctx.reply(rows.slice(0, 20).map((r) => `${r.ts} [${r.category}] ${r.detail_json.slice(0, 60)}`).join('\n'));
  }
}
