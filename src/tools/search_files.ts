/** Tool: glob-based recursive file search within allowed paths, capped at depth 8 and 500 scanned entries to prevent DoS. */

import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { minimatch } from 'minimatch';
import type { Tool, ToolResult, ToolContext } from './types.js';

const SearchFilesInput = z.object({
  directory: z.string().min(1).describe('Root directory to search in'),
  pattern: z.string().min(1).describe('Glob pattern, e.g. "**/*.ts" or "*.log"'),
  maxResults: z.number().int().min(1).max(500).default(50),
  includeContents: z.boolean().default(false).describe('Include a preview of matching file contents'),
});

type SearchFilesInputType = z.infer<typeof SearchFilesInput>;

/** Hard cap on directory traversal depth (prevents runaway walks on deep trees). */
const MAX_DEPTH = 10;

/** Hard cap on total directory entries examined (prevents multi-minute walks). */
const MAX_ENTRIES_SCANNED = 50_000;

interface WalkState {
  results: string[];
  maxResults: number;
  entriesScanned: number;
  hitLimit: boolean;
}

function walkDir(
  dir: string,
  pattern: string,
  safety: { isReadAllowed(p: string): boolean },
  state: WalkState,
  depth: number,
  log: { debug(obj: Record<string, unknown>, msg: string): void },
): void {
  if (state.results.length >= state.maxResults) return;
  if (state.entriesScanned >= MAX_ENTRIES_SCANNED) {
    state.hitLimit = true;
    return;
  }
  if (depth > MAX_DEPTH) {
    state.hitLimit = true;
    return;
  }

  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch (err) {
    log.debug({ dir, err: err instanceof Error ? err.message : String(err) }, 'search_files: readdirSync failed, skipping directory');
    return;
  }

  for (const entry of entries) {
    if (state.results.length >= state.maxResults) break;
    if (state.entriesScanned >= MAX_ENTRIES_SCANNED) {
      state.hitLimit = true;
      break;
    }

    state.entriesScanned++;
    const fullPath = path.join(dir, entry);

    // Skip denied paths
    if (!safety.isReadAllowed(fullPath)) continue;

    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(fullPath);
    } catch (err) {
      log.debug({ fullPath, err: err instanceof Error ? err.message : String(err) }, 'search_files: lstatSync failed, skipping entry');
      continue;
    }

    if (stat.isDirectory()) {
      walkDir(fullPath, pattern, safety, state, depth + 1, log);
    } else if (stat.isFile()) {
      const relativeName = entry;
      const relPath = fullPath.replace(/\\/g, '/');

      // Match against the filename and the full path (forward slashes)
      if (
        minimatch(relativeName, pattern, { dot: true, nocase: true }) ||
        minimatch(relPath, `**/${pattern}`, { dot: true, nocase: true }) ||
        minimatch(relPath, pattern, { dot: true, nocase: true })
      ) {
        state.results.push(fullPath);
      }
    }
  }
}

const searchFilesTool: Tool = {
  name: 'search_files',
  description:
    'Search for files matching a glob pattern within an allowed directory. ' +
    'Examples: "**/*.ts" finds all TypeScript files, "*.log" finds logs in the root. ' +
    'Protected files are automatically excluded from results. ' +
    `Traversal is limited to depth ${MAX_DEPTH} and ${MAX_ENTRIES_SCANNED.toLocaleString()} entries scanned.`,
  parameters: SearchFilesInput,

  async execute(input: SearchFilesInputType, ctx: ToolContext): Promise<ToolResult> {
    const log = ctx.logger.child({ component: 'tools.search_files' });

    if (!ctx.safety.isPathAllowed(input.directory)) {
      return {
        ok: false,
        output: `Access denied: "${input.directory}" is outside the allowed paths.`,
        error: { code: 'PATH_DENIED', message: `Path not allowed: ${input.directory}` },
      };
    }

    const state: WalkState = {
      results: [],
      maxResults: input.maxResults,
      entriesScanned: 0,
      hitLimit: false,
    };

    walkDir(input.directory, input.pattern, ctx.safety, state, 0, log);

    log.info(
      {
        directory: input.directory,
        pattern: input.pattern,
        found: state.results.length,
        entriesScanned: state.entriesScanned,
        hitLimit: state.hitLimit,
      },
      'search_files completed',
    );

    if (state.results.length === 0) {
      const limitNote = state.hitLimit
        ? ` (traversal stopped early after scanning ${state.entriesScanned} entries)`
        : '';
      return {
        ok: true,
        output: `No files matching "${input.pattern}" found in "${input.directory}".${limitNote}`,
        data: { count: 0, pattern: input.pattern, hitLimit: state.hitLimit },
      };
    }

    let output = state.results.join('\n');
    const limitReached = state.results.length >= input.maxResults || state.hitLimit;
    if (limitReached) {
      const reason = state.hitLimit
        ? `traversal limit reached after scanning ${state.entriesScanned} entries`
        : `limited to ${input.maxResults} results`;
      output += `\n… [${reason} — results may be partial]`;
    }

    const truncated =
      output.length > ctx.config.safety.maxOutputLength
        ? `${output.slice(0, ctx.config.safety.maxOutputLength)}\n… [truncated]`
        : output;

    return {
      ok: true,
      output: `Found ${state.results.length} file(s):\n${truncated}`,
      data: { count: state.results.length, pattern: input.pattern, hitLimit: state.hitLimit },
    };
  },
};

export default searchFilesTool;
