/**
 * Organize hierarchy — Jarvis v1.14.3
 *
 * Pure functions for client-side grouping of flat item lists into a
 * goal-header + children structure. No DOM. No side effects. Vitest-importable.
 *
 * ES module (app.js is loaded with `type="module"`; same-origin modules are
 * allowed under CSP `script-src 'self'`). No bundler; vanilla ES modules only.
 * See CLAUDE.md "hierarchy.js ES module choice" for the decision note.
 *
 * Rendered shape:
 *   { rendered: Array<GoalEntry | ItemEntry> }
 *
 *   GoalEntry: { kind: 'goal', goal: item, children: item[] }
 *   ItemEntry: { kind: 'item', item: item }
 *
 * Edge cases:
 *   - Goal with no children: GoalEntry with children: []
 *   - Orphan child (parentId points to absent or non-goal item): ItemEntry top-level
 *   - Goal with parentId (should not exist post-R13; defensive): renders as GoalEntry at top-level
 *   - Sort: original list order is preserved (goals appear at their own list position)
 */

/**
 * Group a flat items array into a rendered hierarchy.
 *
 * @param {Array<{id: string, type: string, parentId: string|null|undefined, [key: string]: unknown}>} items
 * @returns {{ rendered: Array<{kind: 'goal', goal: object, children: object[]} | {kind: 'item', item: object}> }}
 */
export function groupByParent(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return { rendered: [] };
  }

  // Build a set of goal IDs for O(1) lookup
  const goalIds = new Set();
  for (const item of items) {
    if (item.type === 'goal') {
      goalIds.add(item.id);
    }
  }

  // First pass: build goal map and assign children
  // goalMap: id → { goal: item, children: item[] }
  const goalMap = new Map();
  for (const item of items) {
    if (item.type === 'goal') {
      goalMap.set(item.id, { kind: 'goal', goal: item, children: [] });
    }
  }

  // Second pass: assign children; collect top-level entries in original order
  // We build a parallel array tracking which list index each rendered entry maps to,
  // so we can emit entries in original list order.
  //
  // Strategy: walk items in order; for each item decide its placement:
  //   - goal: emitted as a GoalEntry at its list position (children appended later do not shift its position)
  //   - non-goal with parentId in goalMap: goes into that goal's children array
  //   - non-goal with missing/non-goal parentId: emitted as a top-level ItemEntry at its list position
  //
  // Goals with a parentId (defensive, post-R13 should not exist): emit as GoalEntry top-level;
  // DO NOT look up their parent or attempt nested rendering.

  // orderedEntries holds the final rendered sequence in list order
  const orderedEntries = [];
  // Track goals already added to orderedEntries so we don't add them twice
  const goalPlaced = new Set();

  for (const item of items) {
    if (item.type === 'goal') {
      // Goals always render at top level (even if they have a parentId — defensive)
      const entry = goalMap.get(item.id);
      orderedEntries.push(entry);
      goalPlaced.add(item.id);
    } else {
      // Non-goal: check if it has a valid parent goal in this items set
      const parentId = item.parentId ?? null;
      if (parentId && goalMap.has(parentId)) {
        // Child of a goal — append to that goal's children array.
        // The goal's position in orderedEntries was already set when we encountered the goal.
        // If the goal appears AFTER this child in the list (unusual data order), the goal
        // will be placed when we reach it; its children array already has this item.
        goalMap.get(parentId).children.push(item);
        // Do NOT add to orderedEntries — it renders under its goal
      } else {
        // Top-level item (orphan or no parent)
        orderedEntries.push({ kind: 'item', item });
      }
    }
  }

  return { rendered: orderedEntries };
}

// ------------------------------------------------------------------
// Collapse-state helpers (sessionStorage-backed, try/catch-wrapped)
// ------------------------------------------------------------------

const COLLAPSE_STATE_KEY = 'organize-collapse-state-v1';

/**
 * Load collapse state from sessionStorage.
 * @returns {Record<string, boolean>} — map of goalId → collapsed (true = collapsed)
 */
export function loadCollapseState() {
  try {
    const raw = sessionStorage.getItem(COLLAPSE_STATE_KEY);
    if (!raw) return {};
    return JSON.parse(raw) || {};
  } catch {
    // sessionStorage unavailable or JSON malformed — fail silently, default expanded
    return {};
  }
}

/**
 * Save collapse state to sessionStorage.
 * @param {Record<string, boolean>} state
 */
export function saveCollapseState(state) {
  try {
    sessionStorage.setItem(COLLAPSE_STATE_KEY, JSON.stringify(state));
  } catch {
    // sessionStorage unavailable — fail silently
  }
}

/**
 * Return true if the goal is collapsed.
 * @param {Record<string, boolean>} state
 * @param {string} goalId
 * @returns {boolean}
 */
export function isCollapsed(state, goalId) {
  return state[goalId] === true;
}

/**
 * Return a new state object with the goal's collapsed flag toggled.
 * Pure — does not mutate the input.
 * @param {Record<string, boolean>} state
 * @param {string} goalId
 * @returns {Record<string, boolean>}
 */
export function toggleCollapsed(state, goalId) {
  return { ...state, [goalId]: !state[goalId] };
}

/**
 * Remove stale goal IDs from the collapse state (goals no longer in the current list).
 * Pure — returns a new state object.
 * @param {Record<string, boolean>} state
 * @param {string[]} activeGoalIds — IDs of goals currently in the rendered list
 * @returns {Record<string, boolean>}
 */
export function pruneCollapseState(state, activeGoalIds) {
  const activeSet = new Set(activeGoalIds);
  const pruned = {};
  for (const [id, collapsed] of Object.entries(state)) {
    if (activeSet.has(id)) {
      pruned[id] = collapsed;
    }
  }
  return pruned;
}
