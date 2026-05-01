/**
 * Tool: organize_list — list organize items for the current user.
 *
 * Supports filtering by status, type, and tag. Sorts by due asc (undated last).
 * On catastrophic readdir failure returns LIST_READ_FAILED.
 * No privacy filter needed (read-only).
 */

import { z } from 'zod';
import type { Tool, ToolResult, ToolContext } from './types.js';
import { listItems } from '../organize/storage.js';
import type { OrganizeItem } from '../organize/types.js';
import { OrganizeTypeSchema, getDataDir } from './organize_shared.js';

const parameters = z.object({
  filter: z
    .enum(['active', 'done', 'abandoned', 'all'])
    .default('active')
    .describe('Which status to list. Default: active.'),
  type: OrganizeTypeSchema.optional().describe('Filter by type: task, event, or goal.'),
  tag: z.string().max(40).optional().describe('Filter by tag (exact match).'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .default(50)
    .describe('Max items to return. Default 50, max 200.'),
});

type OrganizeListInput = z.infer<typeof parameters>;

/** ISO date/datetime pattern for sort purposes (YYYY-MM-DD or ISO-8601 datetime). */
const ISO_DUE_PATTERN = /^\d{4}-\d{2}-\d{2}(T.*)?$/;

/**
 * Compare two items by due date ascending. Undated and non-ISO due values
 * sort last (per ADR 003 §8: "non-ISO due → item lists but sorts as undated").
 */
function compareDueAsc(a: OrganizeItem, b: OrganizeItem): number {
  const da = a.frontMatter.due;
  const db = b.frontMatter.due;

  // Treat null AND non-ISO strings as "undated" for sort purposes.
  const aIso = da !== null && ISO_DUE_PATTERN.test(da);
  const bIso = db !== null && ISO_DUE_PATTERN.test(db);

  if (aIso && !bIso) return -1; // a is dated, b is undated → a first
  if (!aIso && bIso) return 1;  // a is undated, b is dated → b first
  if (!aIso && !bIso) return 0; // both undated

  // Both are ISO strings — lexicographic compare is correct for ISO dates.
  if (da! < db!) return -1;
  if (da! > db!) return 1;
  return 0;
}

function formatItem(item: OrganizeItem): string {
  const { id, type, status, title, due, tags } = item.frontMatter;
  const dueStr = due ? ` — due ${due}` : '';
  const tagsStr = tags.length > 0 ? ` [${tags.join(', ')}]` : '';
  const statusMark = status !== 'active' ? ` (${status})` : '';
  return `- [${type}] ${title}${dueStr}${tagsStr}${statusMark} (${id})`;
}

export const organizeListTool: Tool<OrganizeListInput> = {
  name: 'organize_list',
  description:
    'List the user\'s organize items (tasks, events, goals). ' +
    'Supports filtering by status (active/done/abandoned/all), type, and tag. ' +
    'Returns a human-readable bullet list sorted by due date.',
  parameters,
  adminOnly: false,

  async execute(input: OrganizeListInput, ctx: ToolContext): Promise<ToolResult> {
    const log = ctx.logger.child({ component: 'tools.organize_list' });

    if (!ctx.userId || !Number.isFinite(ctx.userId)) {
      return {
        ok: false,
        output: "Jarvis couldn't identify you for this action. /organize requires a DM with a user we can identify. If this came from a scheduled task created before v1.10.0 or without an owner, recreate the task via `schedule` — the new task will carry your user id automatically.",
        error: { code: 'NO_USER_ID', message: 'ctx.userId missing' },
      };
    }

    const dataDir = getDataDir(ctx);

    // Build filter
    const statusFilter = input.filter === 'all' ? undefined : input.filter;

    let items: OrganizeItem[];
    try {
      items = await listItems(ctx.userId, dataDir, {
        status: statusFilter,
        type: input.type,
        tag: input.tag,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ userId: ctx.userId, err: msg }, 'organize_list: readdir failed');
      // No audit row for listing failures — list is read-only and the error is
      // surfaced directly to the user. Emitting 'organize.update' here would be
      // a misleading audit-category mislabel.
      return {
        ok: false,
        output: `Failed to list items: ${msg}`,
        error: { code: 'LIST_READ_FAILED', message: msg },
      };
    }

    // Sort by due asc (undated last)
    items.sort(compareDueAsc);

    const total = items.length;
    const truncated = items.length > input.limit;
    const displayItems = items.slice(0, input.limit);

    if (displayItems.length === 0) {
      return {
        ok: true,
        output: 'No matching items.',
        data: { items: [], total: 0, truncated: false },
      };
    }

    const lines = displayItems.map(formatItem).join('\n');
    const footer = truncated ? `\n_(showing ${displayItems.length} of ${total} — increase limit to see more)_` : '';

    return {
      ok: true,
      output: lines + footer,
      data: {
        items: displayItems.map((i) => ({
          id: i.frontMatter.id,
          type: i.frontMatter.type,
          status: i.frontMatter.status,
          title: i.frontMatter.title,
          due: i.frontMatter.due,
          tags: i.frontMatter.tags,
        })),
        total,
        truncated,
      },
    };
  },
};
