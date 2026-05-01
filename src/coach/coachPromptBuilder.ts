/**
 * coachPromptBuilder.ts — Layer (b) <untrusted> wrap on items injection (v1.19.0 R1).
 *
 * Owned by the calendar/coach trust boundary — see ADR 019-revisions R1 Layer (b).
 * Edits to this file require Dev-B sign-off.
 *
 * ADR 019-revisions R1 Layer (b): when the active-items injection block is built
 * for the coach prompt, each item's user-authored text fields are wrapped in
 * <untrusted source="organize.item" itemId="..." field="...">...</untrusted> tags.
 *
 * This is the SECOND wrap layer (Layer b). Layer (a) is the sync-time sanitizer
 * in src/calendar/sync.ts that runs at ingest. Both layers are belt-and-suspenders:
 *   - Layer (a) catches the attack at ingest from hostile calendar events.
 *   - Layer (b) catches anything that reaches the LLM context regardless of origin.
 *
 * STRUCTURAL fields (id, type, status, due, tags, coachIntensity, coachNudgeCount)
 * stay OUTSIDE the <untrusted> block — those are app-controlled values.
 * ONLY user-text fields (title, notes, progress) are wrapped.
 *
 * Dependency edges (binding):
 *   coachPromptBuilder.ts → organize/types (OrganizeItem, OrganizeFrontMatter)
 *                         → coach/coachMemory (CoachEntry)
 *   NO import from coach/coachTools.ts, coach/index.ts, or any agent/webapp layer.
 */

import type { OrganizeItem } from '../organize/types.js';
import type { CoachEntry } from './coachMemory.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * An override intent that has been written to keyed memory and is active for
 * the current coach run. The builder wraps the fromMessage field in an
 * <untrusted> boundary.
 */
export interface OverrideIntent {
  itemId: string;
  kind: 'back_off' | 'push' | 'defer' | 'done_signal';
  expiresAt: string;
  fromMessage: string;
}

// ---------------------------------------------------------------------------
// Core helper: wrapUntrusted
// ---------------------------------------------------------------------------

/**
 * Single source of truth for the <untrusted> wrap format.
 *
 * Produces: <untrusted source="..." [key="value"...]>content</untrusted>
 *
 * - Sanitizes the content by stripping nested <untrusted>...</untrusted> tags
 *   to prevent boundary-breaking attacks (same stripUntrustedTags logic as
 *   src/tools/index.ts wrapUntrustedToolOutput).
 * - Attribute values are truncated to 80 chars and have `"` escaped as &quot;
 *   and `<` escaped as &lt; for XML safety (same sanitizeArgValue logic).
 *
 * Design note: We intentionally do NOT re-use wrapUntrustedToolOutput from
 * src/tools/index.ts because that function's attribute format is keyed on
 * tool names + tool call args, not on organize items. The wrap structure here
 * uses source/itemId/field which is the Layer (b) format per ADR 019-revisions.
 */
export function wrapUntrusted(
  source: string,
  attrs: Record<string, string>,
  content: string,
): string {
  // Strip nested <untrusted>...</untrusted> sequences in the content
  // to prevent boundary injection attacks.
  const safeContent = content.replace(/<\/?untrusted[^>]*>/gi, '[stripped]');

  // Build attribute string. Values are truncated + XML-escaped.
  const attrParts: string[] = [`source="${sanitizeAttrValue(source)}"`];
  for (const [k, v] of Object.entries(attrs)) {
    attrParts.push(`${k}="${sanitizeAttrValue(v)}"`);
  }
  const attrsStr = attrParts.join(' ');

  return `<untrusted ${attrsStr}>${safeContent}</untrusted>`;
}

function sanitizeAttrValue(v: string): string {
  return v.slice(0, 80).replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

// ---------------------------------------------------------------------------
// Per-field wrapping helpers
// ---------------------------------------------------------------------------

/**
 * Wrap a single user-text field from an organize item.
 * If content is empty string, we wrap with empty content (vacuous but consistent).
 */
function wrapItemField(itemId: string, field: 'title' | 'notes' | 'progress', content: string): string {
  return wrapUntrusted('organize.item', { itemId, field }, content);
}

// ---------------------------------------------------------------------------
// Main builder
// ---------------------------------------------------------------------------

/**
 * Build the active-items injection block for the coach prompt.
 *
 * For each item:
 *   - Structural fields (id, type, status, due, tags, coachIntensity,
 *     coachNudgeCount) are emitted in plain text outside <untrusted>.
 *   - User-text fields (title, notes, progress) are wrapped in
 *     <untrusted source="organize.item" itemId="..." field="...">.
 *
 * For each coach memory entry:
 *   - The entire payload is treated as user/LLM-authored content and wrapped.
 *
 * For each override intent:
 *   - The fromMessage is wrapped in <untrusted source="user.message">.
 *
 * @param items       Active organize items to inject into the prompt.
 * @param coachMemory Coach memory entries (nudge history, etc.) for these items.
 * @param overrides   Active override intents for these items.
 * @returns A multi-line string ready to be inserted into the coach prompt context.
 */
export function buildCoachPromptWithItems(
  items: OrganizeItem[],
  coachMemory: CoachEntry[],
  overrides: OverrideIntent[],
): string {
  const sections: string[] = [];

  sections.push('## Active items\n');

  for (const item of items) {
    const fm = item.frontMatter;

    // Structural fields — app-controlled; not wrapped.
    const structuralLines = [
      `id: ${fm.id}`,
      `type: ${fm.type}`,
      `status: ${fm.status}`,
      `due: ${fm.due ?? 'none'}`,
      `coachIntensity: ${fm.coachIntensity ?? 'auto'}`,
      `coachNudgeCount: ${fm.coachNudgeCount ?? 0}`,
      `tags: ${fm.tags.length > 0 ? fm.tags.join(', ') : 'none'}`,
    ];

    // User-text fields — wrapped in <untrusted>.
    const titleWrapped = wrapItemField(fm.id, 'title', fm.title);
    const notesWrapped = wrapItemField(fm.id, 'notes', item.notesBody.trim());
    const progressWrapped = wrapItemField(fm.id, 'progress', item.progressBody.trim());

    const itemBlock = [
      `### Item`,
      ...structuralLines,
      `title: ${titleWrapped}`,
      `notes: ${notesWrapped}`,
      `progress: ${progressWrapped}`,
    ].join('\n');

    sections.push(itemBlock);
  }

  // Coach memory entries — wrapped per entry.
  if (coachMemory.length > 0) {
    sections.push('\n## Coach memory\n');

    for (const entry of coachMemory) {
      const payloadStr = JSON.stringify(entry.payload);
      const wrappedPayload = wrapUntrusted(
        'coach.memory',
        { itemId: entry.itemId, event: entry.eventType },
        payloadStr,
      );
      sections.push(`- at: ${entry.at} | type: ${entry.eventType} | itemId: ${entry.itemId}`);
      sections.push(`  payload: ${wrappedPayload}`);
    }
  }

  // Override intents — fromMessage wrapped.
  if (overrides.length > 0) {
    sections.push('\n## Active overrides\n');

    for (const ov of overrides) {
      const wrappedMessage = wrapUntrusted('user.message', {}, ov.fromMessage);
      sections.push(
        `- itemId: ${ov.itemId} | kind: ${ov.kind} | expiresAt: ${ov.expiresAt} | fromMessage: ${wrappedMessage}`,
      );
    }
  }

  return sections.join('\n');
}
