/**
 * Tool: recall_archive
 *
 * Search the pre-compaction conversation archive stored in SQLite.
 * The model uses this when the user references something that was
 * compacted away and isn't visible in the current context window.
 *
 * No filesystem or network access — reads only from SQLite via the
 * ConversationArchiveRepo. Safe in group mode (output scrubbed by dispatch()).
 */

import { z } from 'zod';
import type { Tool, ToolResult, ToolContext } from './types.js';

const RecallArchiveInput = z.object({
  query: z
    .string()
    .min(2)
    .describe(
      'Keywords to search for in the archived history. Use specific terms: file paths, command names, decisions, etc.',
    ),
  archive_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'Limit search to a specific archive (from the summary header). Omit to search all archives for this session.',
    ),
  max_results: z.number().int().min(1).max(10).default(5),
});

type RecallArchiveInputType = z.infer<typeof RecallArchiveInput>;

const recallArchiveTool: Tool = {
  name: 'recall_archive',
  description:
    'Search the archived pre-compaction conversation history for relevant context. ' +
    'Use this when the user references something you don\'t see in your current context — ' +
    'for example "that file we edited earlier" or "the command from yesterday". ' +
    'Returns up to 5 matching snippets with message IDs and timestamps.',
  parameters: RecallArchiveInput,

  async execute(input: RecallArchiveInputType, ctx: ToolContext): Promise<ToolResult> {
    const log = ctx.logger.child({ component: 'tools.recall_archive' });

    const hits = ctx.memory.conversationArchive.search(
      ctx.sessionId,
      input.archive_id ?? null,
      input.query,
      { maxMatches: input.max_results },
    );

    if (hits.length === 0) {
      log.info({ query: input.query, archiveId: input.archive_id }, 'recall_archive: no matches');
      return {
        ok: true,
        output: `No matches in archive for '${input.query}'.`,
        data: { matches: 0, archivesSearched: input.archive_id !== undefined ? 1 : -1 },
      };
    }

    // Scrub each snippet individually
    const scrubbedHits = hits.map((h) => ({
      ...h,
      snippet: ctx.safety.scrub(h.snippet),
    }));

    // Count distinct archives that contributed results
    const distinctArchives = new Set(scrubbedHits.map((h) => h.archive_id));

    // Format a header line for each distinct archive that appears in results
    // Group hits by archive_id for a cleaner header
    const archiveIds = [...distinctArchives].sort((a, b) => a - b);

    const lines: string[] = [
      `Found ${scrubbedHits.length} match${scrubbedHits.length !== 1 ? 'es' : ''} across ${distinctArchives.size} archive${distinctArchives.size !== 1 ? 's' : ''}:`,
      '',
    ];

    for (const archId of archiveIds) {
      const archiveHits = scrubbedHits.filter((h) => h.archive_id === archId);
      if (archiveHits.length === 0) continue;
      lines.push(`Archive #${archId}:`);
      for (const hit of archiveHits) {
        // Format timestamp to a short datetime string (ISO → readable)
        const ts = hit.created_at
          ? hit.created_at.replace('T', ' ').replace(/\.\d+Z$/, '').replace('Z', '')
          : 'unknown';
        lines.push(`[msg ${hit.message_id}, ${hit.role}, ${ts}] ${hit.snippet}`);
      }
      lines.push('');
    }

    const output = lines.join('\n').trimEnd();

    log.info(
      { query: input.query, archiveId: input.archive_id, matches: scrubbedHits.length },
      'recall_archive: results returned',
    );

    return {
      ok: true,
      output,
      data: { matches: scrubbedHits.length, archivesSearched: distinctArchives.size },
    };
  },
};

export default recallArchiveTool;
