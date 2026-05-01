/**
 * Tool: send_file — upload a file from the filesystem to the current Telegram chat.
 *
 * Security:
 * - Path must pass ctx.safety.isReadAllowed() (same sandbox as read_file).
 * - Extension must be in the explicit allowlist.
 * - Size must be ≤ 50 MB (Telegram Bot API document limit).
 * - Errors from the Telegram API are caught, scrubbed, and returned as ok:false
 *   so they never crash the agent loop.
 *
 * Telegram Instant View note:
 * - Telegram Instant View only works for public URLs matching an IV template.
 *   Local HTML files cannot trigger IV. HTML files are sent as documents with a
 *   hint caption. No further magic is attempted.
 *
 * Group mode:
 * - The tool is enabled in groups. Path-gating via isReadAllowed() is the only
 *   gate — system files, .env, *.db, logs/**, and SSH keys are already blocked
 *   by the read denylist, so no additional group-specific logic is needed.
 */

import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { minimatch } from 'minimatch';
import type { Tool, ToolResult, ToolContext } from './types.js';

const SIZE_LIMIT_BYTES = 50 * 1024 * 1024; // 50 MB

/**
 * V-05 fix: paths that can NEVER be sent via send_file, even if they pass isReadAllowed().
 * These are structurally sensitive even if not strictly secrets.
 */
const SEND_FILE_EXFIL_DENY_GLOBS = [
  'config/**',           // config/config.json, config/system-prompt.md, etc.
  'src/**',              // source code
  'dist/**',             // build output
  'tests/**',            // test files
  '.claude/**',          // factory rules / skills
  'package.json',
  'package-lock.json',
  'ecosystem.config.*',
  'tsconfig*.json',
  'vitest.config.*',
  '.eslintrc*',
  '.github/**',
  '**/.git/**',
];

/**
 * Check whether a given absolute path matches any exfil denylist glob.
 * Normalizes the path to forward slashes for minimatch.
 */
function isExfilDenied(absPath: string): boolean {
  const normalized = absPath.replace(/\\/g, '/');
  for (const glob of SEND_FILE_EXFIL_DENY_GLOBS) {
    // Match against the full path (suffix matching for relative-style globs)
    if (minimatch(normalized, `**/${glob}`, { dot: true, nocase: true })) {
      return true;
    }
    // Also try matching as a basename or suffix pattern
    const segments = normalized.split('/');
    for (let i = 0; i < segments.length; i++) {
      const suffix = segments.slice(i).join('/');
      if (minimatch(suffix, glob, { dot: true, nocase: true })) {
        return true;
      }
    }
  }
  return false;
}

/** Extensions the tool is willing to send (all lowercase). */
const ALLOWED_EXTENSIONS = new Set([
  '.html',
  '.js',
  '.ts',
  '.json',
  '.md',
  '.txt',
  '.py',
  '.csv',
  '.pdf',
  '.png',
  '.jpg',
  '.jpeg',
  '.zip',
]);

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg']);
const HTML_SIZE_HINT_LIMIT = 10 * 1024 * 1024; // 10 MB

const SendFileInput = z.object({
  path: z.string().min(1).describe('Absolute path to the file to send.'),
  caption: z
    .string()
    .max(1024)
    .optional()
    .describe('Optional caption shown under the file in Telegram.'),
  preview: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      'If the file is an image (.png/.jpg/.jpeg), send as photo (inline preview) instead of document.',
    ),
});

type SendFileInputType = z.infer<typeof SendFileInput>;

const sendFileTool: Tool = {
  name: 'send_file',
  description:
    'Upload a file from the filesystem to the current Telegram chat as a document. ' +
    'Use this when the user asks for a file, or when you\'ve generated a file they need to download. ' +
    'Supports .html .js .ts .json .md .txt .py .csv .pdf .png .jpg .zip up to 50MB. ' +
    'HTML files are sent as documents (tap to open in browser) — Telegram Instant View is not ' +
    'available for local files. ' +
    'Only files inside filesystem.allowedPaths can be sent.',

  parameters: SendFileInput,

  async execute(input: SendFileInputType, ctx: ToolContext): Promise<ToolResult> {
    const log = ctx.logger.child({ component: 'tools.send_file' });

    // Step 1a: sandbox gate (reuses read denylist — prevents .env, keys, .db exfiltration)
    if (!ctx.safety.isReadAllowed(input.path)) {
      log.warn({ path: input.path }, 'send_file: path rejected by sandbox');
      return {
        ok: false,
        output: `Access denied: "${input.path}" is outside the allowed paths or is a protected file.`,
        error: { code: 'PATH_DENIED', message: `Path not allowed: ${input.path}` },
      };
    }

    // Step 1b: V-05 exfil denylist — block structurally sensitive paths even if readable
    if (isExfilDenied(input.path)) {
      log.warn({ path: input.path }, 'send_file: path rejected by exfil denylist');
      return {
        ok: false,
        output: `Access denied: "${input.path}" cannot be sent (structurally sensitive path).`,
        error: { code: 'PATH_DENIED', message: `Path blocked by exfil denylist: ${input.path}` },
      };
    }

    // Step 2: stat — must be a regular file
    let stat: fs.Stats;
    try {
      stat = fs.statSync(input.path);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn({ path: input.path, err: message }, 'send_file: stat failed');
      return {
        ok: false,
        output: `File not found or inaccessible: "${input.path}": ${message}`,
        error: { code: 'STAT_ERROR', message },
      };
    }

    if (!stat.isFile()) {
      log.warn({ path: input.path }, 'send_file: path is not a regular file');
      return {
        ok: false,
        output: `"${input.path}" is not a regular file (it may be a directory or symlink).`,
        error: { code: 'NOT_A_FILE', message: 'Path is not a regular file' },
      };
    }

    // Step 3: extension allowlist (case-insensitive)
    const ext = path.extname(input.path).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      log.warn({ path: input.path, ext }, 'send_file: extension not in allowlist');
      return {
        ok: false,
        output:
          `File extension "${ext}" is not supported. Allowed extensions: ` +
          [...ALLOWED_EXTENSIONS].join(', '),
        error: {
          code: 'UNSUPPORTED_EXTENSION',
          message: `Extension "${ext}" not in allowlist`,
        },
      };
    }

    // Step 4: size limit
    if (stat.size > SIZE_LIMIT_BYTES) {
      const sizeMB = (stat.size / (1024 * 1024)).toFixed(1);
      log.warn({ path: input.path, bytes: stat.size }, 'send_file: file too large');
      return {
        ok: false,
        output: `File is too large to send via Telegram (${sizeMB} MB). Maximum is 50 MB.`,
        error: {
          code: 'FILE_TOO_LARGE',
          message: `File size ${stat.size} bytes exceeds 50 MB limit`,
        },
      };
    }

    if (!ctx.telegram) {
      log.error({}, 'send_file: ctx.telegram adapter not available');
      return {
        ok: false,
        output: 'File upload is not available in this context (Telegram adapter not configured).',
        error: { code: 'NO_TELEGRAM_ADAPTER', message: 'ctx.telegram is not set' },
      };
    }

    const basename = path.basename(input.path);
    const isImage = IMAGE_EXTENSIONS.has(ext);
    const isPhoto = input.preview && isImage;

    // Build caption
    let caption = input.caption;
    if (ext === '.html' && stat.size <= HTML_SIZE_HINT_LIMIT) {
      // Inform the user that this is an HTML file opened in the browser viewer
      const hint = 'HTML file — tap to open';
      caption = caption ? `${caption}\n${hint}` : hint;
    }

    // Step 5/6: send via Telegram
    let messageId: number | undefined;
    let kind: 'document' | 'photo';

    try {
      if (isPhoto) {
        const result = await ctx.telegram.sendPhoto(ctx.chatId, input.path, { caption });
        messageId = result.messageId;
        kind = 'photo';
      } else {
        const opts: { caption?: string; disableContentTypeDetection?: boolean } = { caption };
        if (ext === '.html') {
          opts.disableContentTypeDetection = false;
        }
        const result = await ctx.telegram.sendDocument(ctx.chatId, input.path, opts);
        messageId = result.messageId;
        kind = 'document';
      }
    } catch (err) {
      const rawMessage = err instanceof Error ? err.message : String(err);
      // Scrub secrets from the error message before persisting or returning
      const scrubbedMessage = ctx.safety.scrub(rawMessage);
      log.error({ path: input.path, err: scrubbedMessage }, 'send_file: Telegram API error');

      // Step 7: audit row (failure)
      try {
        ctx.memory.fileSends.insert({
          session_id: ctx.sessionId,
          chat_id: ctx.chatId,
          path: input.path,
          basename,
          bytes: stat.size,
          ext,
          kind: 'document',
          telegram_message_id: null,
          ok: false,
          error: scrubbedMessage,
        });
      } catch (dbErr) {
        log.warn(
          { err: dbErr instanceof Error ? dbErr.message : String(dbErr) },
          'send_file: failed to insert audit row (failure case)',
        );
      }

      return {
        ok: false,
        output: `Failed to send "${basename}" via Telegram: ${scrubbedMessage}`,
        error: { code: 'TELEGRAM_ERROR', message: scrubbedMessage },
      };
    }

    // Step 7: audit row (success)
    try {
      ctx.memory.fileSends.insert({
        session_id: ctx.sessionId,
        chat_id: ctx.chatId,
        path: input.path,
        basename,
        bytes: stat.size,
        ext,
        kind,
        telegram_message_id: messageId ?? null,
        ok: true,
        error: null,
      });
    } catch (dbErr) {
      log.warn(
        { err: dbErr instanceof Error ? dbErr.message : String(dbErr) },
        'send_file: failed to insert audit row (success case)',
      );
    }

    const sizeKB = Math.ceil(stat.size / 1024);
    const sizeDisplay = sizeKB >= 1024
      ? `${(sizeKB / 1024).toFixed(1)} MB`
      : `${sizeKB} KB`;

    log.info(
      { path: input.path, bytes: stat.size, kind, messageId },
      'send_file: file sent successfully',
    );

    // Step 8: return success
    return {
      ok: true,
      output: `Sent '${basename}' (${sizeDisplay})`,
      data: {
        path: input.path,
        bytes: stat.size,
        kind,
        messageId: messageId ?? null,
      },
    };
  },
};

export default sendFileTool;
