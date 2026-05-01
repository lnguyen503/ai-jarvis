/**
 * Unit tests for public/webapp/organize/hierarchy.js
 *
 * Pure function tests for groupByParent — no DOM, no server.
 * Tests are numbered M-NEW1 through M-NEW10 per W4 spec.
 *
 * hierarchy.js is an ES module; Vitest handles this via the project's
 * existing vitest.config.ts (no additional setup needed — the file is
 * plain JS with import/export syntax, which Vitest transforms correctly).
 */
import { describe, it, expect } from 'vitest';
import { groupByParent, loadCollapseState, saveCollapseState, isCollapsed, toggleCollapsed, pruneCollapseState } from '../../public/webapp/organize/hierarchy.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeItem(overrides: Record<string, unknown> = {}) {
  return {
    id: `2026-04-25-${Math.random().toString(36).slice(2, 8)}`,
    type: 'task',
    title: 'Test item',
    status: 'active',
    tags: [],
    parentId: null,
    ...overrides,
  };
}

function makeGoal(overrides: Record<string, unknown> = {}) {
  return makeItem({ type: 'goal', title: 'Test goal', ...overrides });
}

// ---------------------------------------------------------------------------
// groupByParent tests
// ---------------------------------------------------------------------------
describe('groupByParent', () => {
  // M-NEW1 — empty array → empty rendered
  it('M-NEW1: empty array → empty rendered', () => {
    const result = groupByParent([]);
    expect(result.rendered).toEqual([]);
  });

  // M-NEW2 — only standalone tasks → all top-level ItemEntry
  it('M-NEW2: only standalone tasks render as top-level items', () => {
    const t1 = makeItem({ id: 'T1' });
    const t2 = makeItem({ id: 'T2' });
    const { rendered } = groupByParent([t1, t2]);
    expect(rendered).toHaveLength(2);
    expect(rendered[0]).toMatchObject({ kind: 'item', item: t1 });
    expect(rendered[1]).toMatchObject({ kind: 'item', item: t2 });
  });

  // M-NEW3 — goal with 2 children → 1 GoalEntry with 2 children, no standalone entries
  it('M-NEW3: goal with 2 children → 1 goal kind, 0 standalone items', () => {
    const g1 = makeGoal({ id: 'G1' });
    const c1 = makeItem({ id: 'C1', parentId: 'G1' });
    const c2 = makeItem({ id: 'C2', parentId: 'G1' });
    const { rendered } = groupByParent([g1, c1, c2]);
    expect(rendered).toHaveLength(1);
    expect(rendered[0].kind).toBe('goal');
    expect(rendered[0].goal).toEqual(g1);
    expect(rendered[0].children).toHaveLength(2);
    expect(rendered[0].children[0]).toEqual(c1);
    expect(rendered[0].children[1]).toEqual(c2);
  });

  // M-NEW4 — goal with no children → 1 GoalEntry with empty children
  it('M-NEW4: goal with no children → GoalEntry with empty children array', () => {
    const g1 = makeGoal({ id: 'G1' });
    const { rendered } = groupByParent([g1]);
    expect(rendered).toHaveLength(1);
    expect(rendered[0].kind).toBe('goal');
    expect(rendered[0].goal).toEqual(g1);
    expect(rendered[0].children).toEqual([]);
  });

  // M-NEW5 — orphan child (parentId points to non-existent item) → top-level ItemEntry
  it('M-NEW5: orphan child (parentId points to non-existent id) → top-level item', () => {
    const c1 = makeItem({ id: 'C1', parentId: 'DOES_NOT_EXIST' });
    const { rendered } = groupByParent([c1]);
    expect(rendered).toHaveLength(1);
    expect(rendered[0]).toMatchObject({ kind: 'item', item: c1 });
  });

  // M-NEW6 — orphan child (parentId points to a non-goal item) → top-level ItemEntry
  it('M-NEW6: orphan child (parentId points to a task, not a goal) → top-level item', () => {
    const t1 = makeItem({ id: 'T1', type: 'task' }); // not a goal
    const c1 = makeItem({ id: 'C1', parentId: 'T1' }); // parentId is a task, not a goal
    const { rendered } = groupByParent([t1, c1]);
    // t1 is a standalone task
    // c1 has parentId pointing to t1 which is not a goal → c1 is top-level too
    expect(rendered).toHaveLength(2);
    expect(rendered[0]).toMatchObject({ kind: 'item', item: t1 });
    expect(rendered[1]).toMatchObject({ kind: 'item', item: c1 });
  });

  // M-NEW7 — mixed: 2 standalone tasks + 1 goal with 2 children + 1 goal with no children
  //          → 4 entries in rendered (2 items + 2 goals)
  it('M-NEW7: mixed list → correct entry count and structure', () => {
    const t1 = makeItem({ id: 'T1' });
    const t2 = makeItem({ id: 'T2' });
    const g1 = makeGoal({ id: 'G1' });
    const g2 = makeGoal({ id: 'G2' });
    const c1 = makeItem({ id: 'C1', parentId: 'G1' });
    const c2 = makeItem({ id: 'C2', parentId: 'G1' });
    // order: t1, t2, g1, c1, c2, g2
    const { rendered } = groupByParent([t1, t2, g1, c1, c2, g2]);
    expect(rendered).toHaveLength(4);
    // t1, t2 are top-level items
    expect(rendered[0]).toMatchObject({ kind: 'item', item: t1 });
    expect(rendered[1]).toMatchObject({ kind: 'item', item: t2 });
    // g1 has 2 children
    expect(rendered[2].kind).toBe('goal');
    expect(rendered[2].goal).toEqual(g1);
    expect(rendered[2].children).toHaveLength(2);
    // g2 has no children
    expect(rendered[3].kind).toBe('goal');
    expect(rendered[3].goal).toEqual(g2);
    expect(rendered[3].children).toEqual([]);
  });

  // M-NEW8 — goal with parentId (post-R13 defensive): renders as GoalEntry top-level, no recursion
  it('M-NEW8: goal with parentId pointing to another goal → renders as top-level goal (no recursion)', () => {
    const gParent = makeGoal({ id: 'GPARENT' });
    const gChild = makeGoal({ id: 'GCHILD', parentId: 'GPARENT' }); // goal-with-parent, should not recurse
    const { rendered } = groupByParent([gParent, gChild]);
    // Both goals should render as GoalEntry at top level
    // gParent should NOT have gChild as a child (goals are not placed in other goals' children)
    expect(rendered).toHaveLength(2);
    const parentEntry = rendered.find((e) => e.kind === 'goal' && e.goal.id === 'GPARENT');
    const childEntry = rendered.find((e) => e.kind === 'goal' && e.goal.id === 'GCHILD');
    expect(parentEntry).toBeDefined();
    expect(childEntry).toBeDefined();
    // gParent must have empty children (goals don't go into another goal's children)
    expect(parentEntry!.children).toEqual([]);
  });

  // M-NEW9 — filter intersection edge: child of a goal that is NOT in items list → child becomes top-level
  // Simulates: user filtered by type=task; goal is excluded from list; tasks with that parentId are orphans
  it('M-NEW9: child whose parent goal is absent from the items list → top-level item', () => {
    // The goal is intentionally absent (e.g., filtered out)
    const c1 = makeItem({ id: 'C1', parentId: 'ABSENT_GOAL' });
    const c2 = makeItem({ id: 'C2', parentId: 'ABSENT_GOAL' });
    const { rendered } = groupByParent([c1, c2]);
    // Both children render as standalone items since their goal is not in the list
    expect(rendered).toHaveLength(2);
    expect(rendered[0]).toMatchObject({ kind: 'item', item: c1 });
    expect(rendered[1]).toMatchObject({ kind: 'item', item: c2 });
  });

  // M-NEW10 — order preservation: input list order is preserved in rendered output
  it('M-NEW10: original list order is preserved in rendered output', () => {
    const items = [
      makeItem({ id: 'A' }),
      makeGoal({ id: 'B' }),
      makeItem({ id: 'C', parentId: 'B' }),
      makeItem({ id: 'D' }),
      makeGoal({ id: 'E' }),
    ];
    const { rendered } = groupByParent(items);
    // Order: A (item), B (goal with child C), D (item), E (goal no children)
    expect(rendered).toHaveLength(4);
    expect(rendered[0]).toMatchObject({ kind: 'item' });
    expect(rendered[0].item.id).toBe('A');
    expect(rendered[1].kind).toBe('goal');
    expect(rendered[1].goal.id).toBe('B');
    expect(rendered[1].children[0].id).toBe('C');
    expect(rendered[2]).toMatchObject({ kind: 'item' });
    expect(rendered[2].item.id).toBe('D');
    expect(rendered[3].kind).toBe('goal');
    expect(rendered[3].goal.id).toBe('E');
  });

  // M-NEW11 — GoalEntry children preserve order
  it('M-NEW11: children within a goal preserve insertion order', () => {
    const g1 = makeGoal({ id: 'G1' });
    const c1 = makeItem({ id: 'C1', parentId: 'G1' });
    const c2 = makeItem({ id: 'C2', parentId: 'G1' });
    const c3 = makeItem({ id: 'C3', parentId: 'G1' });
    const { rendered } = groupByParent([g1, c1, c2, c3]);
    const goalEntry = rendered[0];
    expect(goalEntry.children.map((c: { id: string }) => c.id)).toEqual(['C1', 'C2', 'C3']);
  });
});

// ---------------------------------------------------------------------------
// Collapse state helpers
// ---------------------------------------------------------------------------
describe('collapse state helpers', () => {
  it('isCollapsed returns false for unknown goalId (default expanded)', () => {
    expect(isCollapsed({}, 'G1')).toBe(false);
  });

  it('isCollapsed returns true when explicitly set', () => {
    expect(isCollapsed({ G1: true }, 'G1')).toBe(true);
  });

  it('toggleCollapsed flips false → true', () => {
    const next = toggleCollapsed({ G1: false }, 'G1');
    expect(next.G1).toBe(true);
  });

  it('toggleCollapsed flips true → false', () => {
    const next = toggleCollapsed({ G1: true }, 'G1');
    expect(next.G1).toBe(false);
  });

  it('toggleCollapsed does not mutate the input', () => {
    const original = { G1: true };
    toggleCollapsed(original, 'G1');
    expect(original.G1).toBe(true); // unchanged
  });

  it('pruneCollapseState removes stale IDs', () => {
    const state = { G1: true, G2: false, STALE: true };
    const pruned = pruneCollapseState(state, ['G1', 'G2']);
    expect(Object.keys(pruned)).toEqual(['G1', 'G2']);
    expect(pruned['STALE']).toBeUndefined();
  });

  it('pruneCollapseState preserves values for retained IDs', () => {
    const state = { G1: true, G2: false };
    const pruned = pruneCollapseState(state, ['G1', 'G2']);
    expect(pruned.G1).toBe(true);
    expect(pruned.G2).toBe(false);
  });

  it('loadCollapseState returns empty object when sessionStorage is unavailable', () => {
    // In Vitest (Node), sessionStorage is not available — should return {}
    const state = loadCollapseState();
    expect(state).toEqual({});
  });

  it('saveCollapseState does not throw when sessionStorage is unavailable', () => {
    // Should fail silently in Node
    expect(() => saveCollapseState({ G1: true })).not.toThrow();
  });
});
