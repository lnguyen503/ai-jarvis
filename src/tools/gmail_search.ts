/**
 * Tool: gmail_search
 *
 * Search the user's Gmail inbox using Gmail's native query syntax. Admin-only
 * — Gmail tools never appear in group chats. Returns a one-line-per-message
 * summary (sender, subject, date, snippet) plus structured `data` listing ids
 * so the LLM can follow up with gmail_read for details.
 *
 * Query examples the LLM can construct:
 *   "is:unread"
 *   "from:sam@example.com"
 *   "subject:invoice after:2026/04/01"
 *   "has:attachment newer_than:7d"
 */

import { z } from 'zod';
import type { Tool, ToolContext, ToolResult, ToolDeps } from './types.js';
import { loadGoogleAuth } from '../google/oauth.js';
import { GmailApi, type GmailMessageSummary } from '../google/gmail.js';
import type { OAuth2Client } from 'google-auth-library';

const parameters = z.object({
  query: z
    .string()
    .default('')
    .describe(
      'Gmail search syntax. Empty string lists the inbox. ' +
        'Examples: "is:unread", "from:sam@x.com", "subject:invoice after:2026/04/01", ' +
        '"has:attachment newer_than:7d". Combine with spaces (implicit AND).',
    ),
  maxResults: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(10)
    .describe('Cap on messages returned. Each message costs one API call.'),
  labelIds: z
    .array(z.string())
    .optional()
    .describe(
      'Gmail label IDs to filter on (e.g. ["INBOX"], ["UNREAD"]). ' +
        'Most queries should use the `query` field instead (is:unread, in:inbox).',
    ),
});

type GmailSearchInput = z.infer<typeof parameters>;

export function buildGmailSearchTool(deps: ToolDeps): Tool<GmailSearchInput> {
  let cachedAuth: OAuth2Client | null = null;
  let triedLoad = false;

  async function getAuth(): Promise<OAuth2Client | null> {
    if (cachedAuth) return cachedAuth;
    if (triedLoad) {
      cachedAuth = await loadGoogleAuth(deps.config, deps.logger);
      return cachedAuth;
    }
    triedLoad = true;
    cachedAuth = await loadGoogleAuth(deps.config, deps.logger);
    return cachedAuth;
  }

  return {
    name: 'gmail_search',
    description:
      'Search the user\'s Gmail inbox with Gmail\'s native query syntax ' +
      '(is:unread, from:X, subject:Y, after:YYYY/MM/DD, has:attachment, newer_than:Nd). ' +
      'Returns sender, subject, date, and snippet per message. ' +
      'Use gmail_read with the returned id to get the full body.',
    parameters,
    adminOnly: true,

    async execute(input: GmailSearchInput, ctx: ToolContext): Promise<ToolResult> {
      const log = ctx.logger.child({ component: 'tools.gmail_search' });

      const auth = await getAuth();
      if (!auth) {
        const tokenPath = ctx.config.google.oauth.tokenPath;
        const hint = ctx.config.google.oauth.clientId
          ? `Run \`npm run google-auth\` to authorise.`
          : `Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET in .env, then run \`npm run google-auth\`.`;
        return {
          ok: false,
          output: `Gmail isn't connected yet. ${hint} (token file expected at ${tokenPath})`,
          error: { code: 'GOOGLE_NOT_AUTHORISED', message: 'no oauth credentials on disk' },
        };
      }

      const cap = ctx.config.google.gmail.maxResults;
      const maxResults = Math.min(input.maxResults, cap);

      const api = new GmailApi(auth);
      let messages: GmailMessageSummary[];
      try {
        messages = await api.searchMessages({
          query: input.query,
          maxResults,
          labelIds: input.labelIds,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error({ err: message, query: input.query }, 'Gmail search failed');
        return {
          ok: false,
          output: `Gmail search failed: ${message}`,
          error: { code: 'GOOGLE_API_ERROR', message },
        };
      }

      if (messages.length === 0) {
        const q = input.query ? `matching "${input.query}"` : 'in the inbox';
        return {
          ok: true,
          output: `No messages found ${q}.`,
          data: { count: 0, ids: [] },
        };
      }

      const lines = messages.map(formatMessageLine);
      const header =
        `${messages.length} message${messages.length === 1 ? '' : 's'}` +
        (input.query ? ` matching "${input.query}":` : ':');
      const output = [header, '', ...lines].join('\n');

      log.info({ query: input.query, count: messages.length }, 'Gmail search complete');

      return {
        ok: true,
        output,
        data: {
          count: messages.length,
          ids: messages.map((m) => m.id),
        },
      };
    },
  };
}

function formatMessageLine(m: GmailMessageSummary): string {
  const unread = m.labelIds.includes('UNREAD') ? ' •' : '';
  const parts: string[] = [
    `• [${m.id}]${unread} ${m.subject}`,
    `    from: ${m.from}`,
  ];
  if (m.date) parts.push(`    date: ${m.date}`);
  if (m.snippet) parts.push(`    ${m.snippet}`);
  return parts.join('\n');
}
