/**
 * List view — Jarvis v1.15.0
 *
 * Extracted from app.js commits 0a (mechanical zero-logic-change relocation; R1 BLOCKING).
 * Contains: renderList, buildItemCard, buildGoalGroup, and multi-select rendering.
 *
 * Security invariants (ADR 009, decision 6):
 *  - ALL user-authored content uses textContent ONLY — never innerHTML.
 *  - Tags rendered as separate <span> elements with textContent.
 *
 * Callback contract:
 *   renderList(container, items, callbacks, state)
 *   callbacks: { onComplete, onSelect, onDetail }
 *   state: { multiSelectMode, selectedIds, collapseState, onToggleCollapse }
 *
 * ES module; no framework; no bundler.
 */

import { groupByParent, isCollapsed, toggleCollapsed, saveCollapseState, pruneCollapseState } from './hierarchy.js';

// ------------------------------------------------------------------
// Type icon helper (duplicated from app.js for module isolation)
// ------------------------------------------------------------------
function typeIcon(type) {
  if (type === 'task') return '📌';
  if (type === 'event') return '📅';
  if (type === 'goal') return '⚑';
  return '•';
}

/**
 * Build a standard item card <li> element.
 * Used for standalone top-level items and for children inside goal groups.
 *
 * v1.14.6 D11: In select mode, renders a square selection-checkbox (always, even for abandoned).
 * Card click toggles selection instead of navigating to detail.
 *
 * @param {object} item
 * @param {object} callbacks  — { onComplete, onSelect, onDetail }
 * @param {object} state      — { multiSelectMode, selectedIds }
 * @returns {HTMLLIElement}
 */
export function buildItemCard(item, callbacks, state) {
  const { multiSelectMode, selectedIds } = state;
  const { onComplete, onSelect, onDetail } = callbacks;

  const li = document.createElement('li');
  li.className = 'item-card';
  li.dataset.itemId = item.id;

  if (multiSelectMode) {
    // v1.14.6 D11: select mode — square checkbox replaces complete checkbox (always shown)
    const selected = selectedIds.has(item.id);
    if (selected) li.classList.add('selected');

    const selectBtn = document.createElement('button');
    selectBtn.type = 'button';
    selectBtn.className = 'select-checkbox';
    selectBtn.dataset.itemId = item.id;
    selectBtn.textContent = selected ? '☑' : '☐';
    selectBtn.setAttribute('aria-label', selected ? 'Deselect' : 'Select');
    selectBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (onSelect) onSelect(item.id);
    });
    li.appendChild(selectBtn);

    // Card-level click toggles selection (D11 — overrides navigate-to-detail)
    li.addEventListener('click', () => { if (onSelect) onSelect(item.id); });
  } else {
    // Normal mode — complete checkbox (R14: hidden for abandoned items)
    if (item.status !== 'abandoned') {
      const checkBtn = document.createElement('button');
      checkBtn.type = 'button';
      checkBtn.className = 'check-btn';
      checkBtn.dataset.itemId = item.id;
      checkBtn.dataset.done = String(item.status === 'done');
      checkBtn.textContent = item.status === 'done' ? '✅' : '⭕';
      checkBtn.setAttribute('aria-label', item.status === 'done' ? 'Mark incomplete' : 'Mark complete');
      checkBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (onComplete) onComplete(item);
      });
      li.appendChild(checkBtn);
    }
  }

  // Card content wrapper
  const content = document.createElement('div');
  content.className = 'item-card-content';

  // Icon + title row
  const titleRow = document.createElement('div');
  titleRow.className = 'item-title-row';

  const iconSpan = document.createElement('span');
  iconSpan.className = 'item-icon';
  iconSpan.textContent = typeIcon(item.type);

  const titleSpan = document.createElement('span');
  titleSpan.className = 'item-title';
  // textContent — user-authored content, never innerHTML (decision 6)
  titleSpan.textContent = item.title || '(untitled)';

  titleRow.appendChild(iconSpan);
  titleRow.appendChild(titleSpan);

  // Meta row: status + due date
  const metaRow = document.createElement('div');
  metaRow.className = 'item-meta';

  const statusBadge = document.createElement('span');
  statusBadge.className = `badge badge-${item.status || 'active'}`;
  statusBadge.textContent = item.status || 'active';

  metaRow.appendChild(statusBadge);

  // v1.18.0 ADR 018 D1: coach intensity badge (shown only for explicit intensities).
  // v1.19.0 D1: 'auto' is the implicit default — hide the badge to keep cards uncluttered
  // for users who never touched coaching. Show only for explicit gentle/moderate/persistent
  // (and 'off' is also implicit — skipped).
  const intensity = item.coachIntensity;
  if (intensity && intensity !== 'off' && intensity !== 'auto') {
    const coachBadge = document.createElement('span');
    coachBadge.className = `coach-badge coach-badge-${intensity}`;
    const icons = { gentle: '🌱', moderate: '⏰', persistent: '🔥' };
    coachBadge.textContent = icons[intensity] || intensity; // textContent — never innerHTML
    metaRow.appendChild(coachBadge);
  }

  if (item.due && item.due.length > 0) {
    const dueSpan = document.createElement('span');
    dueSpan.className = 'item-due';
    dueSpan.textContent = item.due;
    metaRow.appendChild(dueSpan);
  }

  // Tags — each tag as a separate <span> with textContent (decision 6)
  const tagsRow = document.createElement('div');
  tagsRow.className = 'item-tags';

  if (Array.isArray(item.tags)) {
    for (const tag of item.tags) {
      const tagSpan = document.createElement('span');
      tagSpan.className = 'tag';
      tagSpan.textContent = tag; // textContent — user-authored (decision 6)
      tagsRow.appendChild(tagSpan);
    }
  }

  content.appendChild(titleRow);
  content.appendChild(metaRow);
  content.appendChild(tagsRow);
  li.appendChild(content);

  // Normal-mode card click navigates to detail (D11: in select mode, handled above)
  if (!multiSelectMode) {
    li.addEventListener('click', () => { if (onDetail) onDetail(item.id); });
  }

  return li;
}

/**
 * Build a goal group element: header row + collapsible children list.
 * @param {{ kind: 'goal', goal: object, children: object[] }} entry
 * @param {object} callbacks  — { onComplete, onSelect, onDetail }
 * @param {object} state      — { multiSelectMode, selectedIds, collapseState, onToggleCollapse, allItems }
 * @returns {HTMLLIElement}
 */
export function buildGoalGroup(entry, callbacks, state) {
  const { goal, children } = entry;
  const { multiSelectMode, selectedIds, collapseState, onToggleCollapse, allItems } = state;
  const { onSelect, onDetail } = callbacks;

  const collapsed = isCollapsed(collapseState, goal.id);
  const hasChildren = children.length > 0;

  const li = document.createElement('li');
  li.className = 'goal-item-wrapper';
  li.dataset.goalId = goal.id;

  // Goal header row — tappable for detail nav (D8)
  const headerRow = document.createElement('div');
  headerRow.className = 'goal-header';

  // Chevron button — separate tap target, stopPropagation (D8)
  if (hasChildren) {
    const chevronBtn = document.createElement('button');
    chevronBtn.type = 'button';
    chevronBtn.className = collapsed ? 'chevron-btn' : 'chevron-btn expanded';
    chevronBtn.setAttribute('aria-label', collapsed ? 'Expand' : 'Collapse');
    chevronBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (onToggleCollapse) onToggleCollapse(goal.id, allItems);
    });
    headerRow.appendChild(chevronBtn);
  }

  // Rest of header — taps navigate to goal detail
  const headerContent = document.createElement('div');
  headerContent.className = 'goal-header-content';

  const iconSpan = document.createElement('span');
  iconSpan.className = 'item-icon';
  iconSpan.textContent = typeIcon(goal.type);

  const titleSpan = document.createElement('span');
  titleSpan.className = 'item-title';
  titleSpan.textContent = goal.title || '(untitled)'; // textContent — user-authored (decision 6)

  headerContent.appendChild(iconSpan);
  headerContent.appendChild(titleSpan);

  // Tags on goal header
  if (Array.isArray(goal.tags) && goal.tags.length > 0) {
    const tagsRow = document.createElement('div');
    tagsRow.className = 'item-tags';
    for (const tag of goal.tags) {
      const tagSpan = document.createElement('span');
      tagSpan.className = 'tag';
      tagSpan.textContent = tag;
      tagsRow.appendChild(tagSpan);
    }
    headerContent.appendChild(tagsRow);
  }

  // Child count
  if (hasChildren) {
    const countSpan = document.createElement('span');
    countSpan.className = 'goal-child-count';
    countSpan.textContent = `(${children.length} ${children.length === 1 ? 'item' : 'items'})`;
    headerContent.appendChild(countSpan);
  }

  headerRow.appendChild(headerContent);

  // v1.14.6 D11 dual-mode: in select mode, header body tap toggles selection;
  // in normal mode, header body tap navigates to goal detail (D8).
  headerContent.addEventListener('click', () => {
    if (multiSelectMode) {
      if (onSelect) onSelect(goal.id);
    } else {
      if (onDetail) onDetail(goal.id);
    }
  });

  li.appendChild(headerRow);

  // Children list — respects [hidden] for state transitions (v1.14.1)
  if (hasChildren) {
    const childrenList = document.createElement('ul');
    childrenList.className = 'goal-children';
    if (collapsed) {
      childrenList.hidden = true;
    }

    for (const child of children) {
      childrenList.appendChild(buildItemCard(child, callbacks, state));
    }

    li.appendChild(childrenList);
  }

  return li;
}

/**
 * Render the item list, honoring the goal hierarchy.
 * Uses groupByParent from hierarchy.js; goals appear as collapsible headers.
 *
 * @param {HTMLElement} container         — the <ul> element to render into
 * @param {object[]} items                — current item list
 * @param {object} callbacks              — { onComplete, onSelect, onDetail }
 * @param {object} state                  — { multiSelectMode, selectedIds, collapseState,
 *                                           onToggleCollapse, onCollapseStateChange }
 * @returns {{ collapseState: object }}   — updated collapseState after pruning
 */
export function renderList(container, items, callbacks, state) {
  if (!container) return state;

  let { collapseState } = state;

  // Prune stale collapse-state keys (goals no longer in the list)
  const goalIds = items.filter((i) => i.type === 'goal').map((i) => i.id);
  collapseState = pruneCollapseState(collapseState, goalIds);
  if (state.onCollapseStateChange) state.onCollapseStateChange(collapseState);

  // Clear previous content — empty string innerHTML is safe (no user content)
  container.innerHTML = '';

  const { rendered } = groupByParent(items);

  for (const entry of rendered) {
    if (entry.kind === 'goal') {
      container.appendChild(buildGoalGroup(entry, callbacks, {
        ...state,
        collapseState,
        allItems: items,
      }));
    } else {
      container.appendChild(buildItemCard(entry.item, callbacks, state));
    }
  }

  return { collapseState };
}
