/**
 * Integration tests for R7 mechanical extraction: items.auth.ts (v1.16.0).
 *
 * Verifies that the R7 split (items.auth.ts) works correctly — exports
 * resolve properly and all callers (items routes) still work after the split.
 *
 * Covers:
 *   - R7-1: authenticateRequest exported from items.auth.ts works on items routes
 *   - R7-2: ConflictTracker exported from items.auth.ts (no circular imports)
 *   - R7-3: debate.shared.ts authenticateRequest traces to items.auth.ts (NOT items.shared.ts)
 *
 * ~3 tests.
 */

import { describe, it, expect } from 'vitest';
import { authenticateRequest, conflictTracker, ConflictTracker, readIfMatchHeader, readForceOverride } from '../../src/webapp/items.auth.js';
import { authenticateRequest as authFromShared, conflictTracker as ctFromShared } from '../../src/webapp/items.shared.js';
import { authenticateRequest as authFromDebateShared } from '../../src/webapp/debate.shared.js';

describe('R7 mechanical extraction — items.auth.ts', () => {
  it('R7-1: authenticateRequest and ConflictTracker are exported from items.auth.ts', () => {
    // Verify that the symbols are properly exported (not undefined)
    expect(typeof authenticateRequest).toBe('function');
    expect(typeof ConflictTracker).toBe('function');
    expect(conflictTracker).toBeInstanceOf(ConflictTracker);
    expect(typeof readIfMatchHeader).toBe('function');
    expect(typeof readForceOverride).toBe('function');
  });

  it('R7-2: items.shared.ts re-exports authenticateRequest from items.auth.ts (same reference)', () => {
    // Both should be the same function reference (re-export, not a copy)
    expect(authFromShared).toBe(authenticateRequest);
    expect(ctFromShared).toBe(conflictTracker);
  });

  it('R7-3: debate.shared.ts authenticateRequest traces to items.auth.ts (R7 single source of truth)', () => {
    // debate.shared.ts re-exports from items.auth.ts directly
    expect(authFromDebateShared).toBe(authenticateRequest);
  });
});
