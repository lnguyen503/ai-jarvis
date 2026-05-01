/**
 * Tool: gmail_read
 *
 * Fetch a single Gmail message by id, with full body text and attachment
 * metadata. Admin-only — Gmail tools never appear in group chats.
 *
 * Typical flow: gmail_search returns ids, the LLM picks one and calls
 * gmail_read to get the body. Attachments are listed but not downloaded
 * (add a gmail_download_attachment tool later if needed).
 */

import { z } from 'zod';
import type { Tool, ToolContext, ToolResult, ToolDeps } from './types.js';
import { loadGoogleAuth } from '../google/oauth.js';
import { GmailApi, type GmailMessageDetail } from '../google/gmail.js';
import type { OAuth2Client } from 'google-auth-library';

const parameters = z.object({
  id: z
    .string()
    .min(1)
    .describe('Gmail message id (from gmail_search results).'),
});

type GmailReadInput = z.infer<typeof parameters>;

export function buildGmailReadTool(deps: ToolDeps): Tool<GmailReadInput> {
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
    name: 'gmail_read',
    description:
      'Fetch a single Gmail message by id (from gmail_search). ' +
      'Returns sender, recipients, subject, date, full body text, and any ' +
      'attachment metadata. Prefers text/plain over HTML.',
    parameters,
    adminOnly: true,

    async execute(input: GmailReadInput, ctx: ToolContext): Promise<ToolResult> {
      const log = ctx.logger.child({ component: 'tools.gmail_read' });

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

      const api = new GmailApi(auth);
      let message: GmailMessageDetail;
      try {
        message = await api.getMessage(input.id);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log.error({ err: errMsg, id: input.id }, 'Gmail read failed');
        return {
          ok: false,
          output: `Couldn't read message ${input.id}: ${errMsg}`,
          error: { code: 'GOOGLE_API_ERROR', message: errMsg },
        };
      }

      const output = formatMessage(message);

      log.info(
        { id: message.id, subject: message.subject, bodyKind: message.bodyKind },
        'Gmail message read',
      );

      return {
        ok: true,
        output,
        data: {
          id: message.id,
          threadId: message.threadId,
          bodyKind: message.bodyKind,
          attachmentCount: message.attachments.length,
        },
      };
    },
  };
}

function formatMessage(m: GmailMessageDetail): string {
  const lines: string[] = [
    `Subject: ${m.subject}`,
    `From: ${m.from}`,
    `To: ${m.to}`,
  ];
  if (m.cc) lines.push(`Cc: ${m.cc}`);
  if (m.replyTo) lines.push(`Reply-To: ${m.replyTo}`);
  if (m.date) lines.push(`Date: ${m.date}`);
  if (m.labelIds.length > 0) lines.push(`Labels: ${m.labelIds.join(', ')}`);
  lines.push('');

  if (m.body) {
    lines.push(m.body);
  } else {
    lines.push('(empty body)');
  }

  if (m.attachments.length > 0) {
    lines.push('');
    lines.push(`Attachments (${m.attachments.length}):`);
    for (const a of m.attachments) {
      lines.push(`  • ${a.filename} (${a.mimeType}, ${formatBytes(a.size)})`);
    }
  }

  return lines.join('\n');
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
