/** Tool: read file contents from an allowed path, returning UTF-8 text or base64 up to maxBytes. */

import { z } from 'zod';
import fs from 'fs';
import type { Tool, ToolResult, ToolContext } from './types.js';

const ReadFileInput = z.object({
  path: z.string().min(1).describe('Absolute path to the file to read'),
  encoding: z.enum(['utf8', 'base64']).default('utf8'),
  maxBytes: z.number().int().min(1).max(1_000_000).optional(),
});

type ReadFileInputType = z.infer<typeof ReadFileInput>;

const readFileTool: Tool = {
  name: 'read_file',
  description:
    'Read the contents of a file. Path must be within an allowed directory. ' +
    '.env files, credential files, SSH keys, and log/data files are blocked. ' +
    'Large files are truncated at maxOutputLength.',
  parameters: ReadFileInput,

  async execute(input: ReadFileInputType, ctx: ToolContext): Promise<ToolResult> {
    const log = ctx.logger.child({ component: 'tools.read_file' });

    if (!ctx.safety.isReadAllowed(input.path)) {
      log.warn({ path: input.path }, 'read_file: path rejected by sandbox');
      return {
        ok: false,
        output: `Access denied: "${input.path}" is outside the allowed paths or is a protected file.`,
        error: { code: 'PATH_DENIED', message: `Path not allowed: ${input.path}` },
      };
    }

    let content: string;
    try {
      const stat = fs.statSync(input.path);
      const maxBytes = input.maxBytes ?? ctx.config.safety.maxOutputLength * 4; // rough byte estimate

      if (stat.size > maxBytes && input.encoding === 'utf8') {
        // Read only up to maxBytes
        const buf = Buffer.alloc(maxBytes);
        const fd = fs.openSync(input.path, 'r');
        const bytesRead = fs.readSync(fd, buf, 0, maxBytes, 0);
        fs.closeSync(fd);
        content = buf.subarray(0, bytesRead).toString('utf8') + `\n… [truncated at ${maxBytes} bytes]`;
      } else {
        const buf = fs.readFileSync(input.path);
        content = input.encoding === 'base64' ? buf.toString('base64') : buf.toString('utf8');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ path: input.path, err: message }, 'read_file error');
      return {
        ok: false,
        output: `Failed to read "${input.path}": ${message}`,
        error: { code: 'READ_ERROR', message },
      };
    }

    // Scrub secrets from file contents
    const scrubbed = ctx.safety.scrub(content);

    // Truncate to maxOutputLength
    const truncated =
      scrubbed.length > ctx.config.safety.maxOutputLength
        ? `${scrubbed.slice(0, ctx.config.safety.maxOutputLength)}\n… [truncated]`
        : scrubbed;

    log.info({ path: input.path, bytes: content.length }, 'read_file completed');

    return {
      ok: true,
      output: truncated,
      data: { path: input.path, bytes: content.length },
    };
  },
};

export default readFileTool;
