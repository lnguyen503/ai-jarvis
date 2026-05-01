/** Tool: list directory entries within an allowed path, filtering out sensitive entries via the safety layer. */

import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import type { Tool, ToolResult, ToolContext } from './types.js';

const ListDirectoryInput = z.object({
  path: z.string().min(1).describe('Absolute path to directory to list'),
  recursive: z.boolean().default(false).describe('List subdirectories recursively'),
  maxDepth: z.number().int().min(1).max(10).default(3),
  showHidden: z.boolean().default(false).describe('Include hidden files (starting with .)'),
});

type ListDirectoryInputType = z.infer<typeof ListDirectoryInput>;


function listDir(
  dirPath: string,
  maxDepth: number,
  currentDepth: number,
  showHidden: boolean,
  ctx: ToolContext,
): string[] {
  if (currentDepth > maxDepth) return [];

  let entries: string[];
  try {
    entries = fs.readdirSync(dirPath);
  } catch (err) {
    ctx.logger.child({ component: 'tools.list_directory' }).debug(
      { dir: dirPath, err: err instanceof Error ? err.message : String(err) },
      'list_directory: readdirSync failed, skipping directory',
    );
    return [];
  }

  // Filter denied entries via safety sandbox
  const allowed = ctx.safety.filterDeniedEntries(dirPath, entries);

  const results: string[] = [];
  const prefix = '  '.repeat(currentDepth - 1);

  for (const entry of allowed) {
    if (!showHidden && entry.startsWith('.')) continue;

    const fullPath = path.join(dirPath, entry);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(fullPath);
    } catch (err) {
      ctx.logger.child({ component: 'tools.list_directory' }).debug(
        { fullPath, err: err instanceof Error ? err.message : String(err) },
        'list_directory: lstatSync failed, skipping entry',
      );
      continue;
    }

    if (stat.isDirectory()) {
      results.push(`${prefix}${entry}/`);
      if (maxDepth > currentDepth) {
        const sub = listDir(fullPath, maxDepth, currentDepth + 1, showHidden, ctx);
        results.push(...sub);
      }
    } else if (stat.isSymbolicLink()) {
      results.push(`${prefix}${entry} -> (symlink)`);
    } else {
      const kb = (stat.size / 1024).toFixed(1);
      results.push(`${prefix}${entry} (${kb}KB)`);
    }
  }

  return results;
}

const listDirectoryTool: Tool = {
  name: 'list_directory',
  description:
    'List the contents of a directory. Shows files and subdirectories. ' +
    'Protected files (.env, credentials, keys, logs) are automatically excluded. ' +
    'Path must be within an allowed directory.',
  parameters: ListDirectoryInput,

  async execute(input: ListDirectoryInputType, ctx: ToolContext): Promise<ToolResult> {
    const log = ctx.logger.child({ component: 'tools.list_directory' });

    if (!ctx.safety.isPathAllowed(input.path)) {
      log.warn({ path: input.path }, 'list_directory: path rejected by sandbox');
      return {
        ok: false,
        output: `Access denied: "${input.path}" is outside the allowed paths.`,
        error: { code: 'PATH_DENIED', message: `Path not allowed: ${input.path}` },
      };
    }

    // Additionally check it's a directory
    let stat: fs.Stats;
    try {
      stat = fs.statSync(input.path);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        output: `Cannot stat "${input.path}": ${message}`,
        error: { code: 'STAT_ERROR', message },
      };
    }

    if (!stat.isDirectory()) {
      return {
        ok: false,
        output: `"${input.path}" is not a directory.`,
        error: { code: 'NOT_A_DIRECTORY', message: `Not a directory: ${input.path}` },
      };
    }

    const entries = listDir(input.path, input.recursive ? input.maxDepth : 1, 1, input.showHidden, ctx);

    log.info({ path: input.path, count: entries.length }, 'list_directory completed');

    const output = entries.length > 0 ? entries.join('\n') : '(empty directory)';
    const truncated =
      output.length > ctx.config.safety.maxOutputLength
        ? `${output.slice(0, ctx.config.safety.maxOutputLength)}\n… [truncated]`
        : output;

    return {
      ok: true,
      output: `${input.path}:\n${truncated}`,
      data: { path: input.path, count: entries.length },
    };
  },
};

export default listDirectoryTool;
