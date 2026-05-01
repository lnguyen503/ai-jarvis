/**
 * Unit tests for DebateEventBus singleton (v1.16.0).
 *
 * Covers:
 *   - publish + subscribe basic flow
 *   - unsubscribe via returned function
 *   - listenerCountFor
 *   - R1-5: 100 subscribe + force-unsubscribe leak guard
 *
 * Uses the module-scoped singleton (debateEventBus) with namespaced runIds
 * to avoid cross-test contamination.
 *
 * ~5 tests.
 */

import { describe, it, expect } from 'vitest';
import { debateEventBus, type DebateEvent } from '../../src/debate/eventbus.js';

// Use unique prefixes per test group to avoid cross-contamination with other tests.
const PREFIX = `test-eb-${Date.now()}-`;

describe('DebateEventBus — basic pub/sub', () => {
  it('EB-1: subscribe receives published events', () => {
    const runId = `${PREFIX}1`;
    const received: DebateEvent[] = [];
    const unsub = debateEventBus.subscribe(runId, (e) => received.push(e));
    debateEventBus.publish(runId, { type: 'error', reason: 'test' });
    unsub();
    expect(received.length).toBe(1);
    expect(received[0]).toMatchObject({ type: 'error', reason: 'test' });
  });

  it('EB-2: unsubscribe stops receiving events', () => {
    const runId = `${PREFIX}2`;
    const received: DebateEvent[] = [];
    const unsub = debateEventBus.subscribe(runId, (e) => received.push(e));
    debateEventBus.publish(runId, { type: 'error', reason: 'first' });
    unsub();
    debateEventBus.publish(runId, { type: 'error', reason: 'second' });
    expect(received.length).toBe(1);
  });

  it('EB-3: listenerCountFor returns 0 after unsubscribe', () => {
    const runId = `${PREFIX}3`;
    const before = debateEventBus.listenerCountFor(runId);
    const unsub = debateEventBus.subscribe(runId, () => {});
    expect(debateEventBus.listenerCountFor(runId)).toBe(before + 1);
    unsub();
    expect(debateEventBus.listenerCountFor(runId)).toBe(before);
  });

  it('EB-4: events are scoped to runId — different runs do not cross-contaminate', () => {
    const runIdA = `${PREFIX}A`;
    const runIdB = `${PREFIX}B`;
    const receivedA: DebateEvent[] = [];
    const receivedB: DebateEvent[] = [];
    const unsubA = debateEventBus.subscribe(runIdA, (e) => receivedA.push(e));
    const unsubB = debateEventBus.subscribe(runIdB, (e) => receivedB.push(e));
    debateEventBus.publish(runIdA, { type: 'error', reason: 'for A' });
    expect(receivedA.length).toBe(1);
    expect(receivedB.length).toBe(0);
    unsubA();
    unsubB();
  });

  it('EB-5 (R1-5): 100 subscribe + force-unsubscribe — listenerCount returns to baseline', () => {
    const runId = `${PREFIX}leak`;
    const baseline = debateEventBus.listenerCountFor(runId);
    const unsubFns: Array<() => void> = [];
    // Subscribe 100 listeners
    for (let i = 0; i < 100; i++) {
      unsubFns.push(debateEventBus.subscribe(runId, () => {}));
    }
    expect(debateEventBus.listenerCountFor(runId)).toBe(baseline + 100);
    // Force-unsubscribe all (simulating 100 SSE close events)
    for (const unsub of unsubFns) unsub();
    // Assert back to baseline — 0 leaked listeners
    expect(debateEventBus.listenerCountFor(runId)).toBe(baseline);
  });
});
