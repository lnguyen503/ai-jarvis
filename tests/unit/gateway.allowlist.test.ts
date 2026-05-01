/**
 * Sub-Phase A/B — Allowlist middleware unit tests.
 * Verifies the allowlist predicate (B2.x): only configured user IDs progress.
 */
import { describe, it, expect, vi } from 'vitest';
import { createAllowlistMiddleware } from '../../src/gateway/allowlist.js';
import { makeTestConfig } from '../fixtures/makeConfig.js';

type MockCtx = {
  from?: { id?: number };
  chat?: { id?: number };
};

async function runMiddleware(cfg: ReturnType<typeof makeTestConfig>, ctx: MockCtx): Promise<boolean> {
  const mw = createAllowlistMiddleware(cfg);
  const next = vi.fn(async () => {});
  await mw(ctx as never, next);
  return next.mock.calls.length > 0;
}

describe('gateway.allowlist.createAllowlistMiddleware', () => {
  const cfg = makeTestConfig({
    telegram: { allowedUserIds: [12345], botToken: 'x' },
  });

  it('allows a configured user id', async () => {
    const called = await runMiddleware(cfg, { from: { id: 12345 }, chat: { id: 12345 } });
    expect(called).toBe(true);
  });

  it('silently drops a non-allowlisted user id', async () => {
    const called = await runMiddleware(cfg, { from: { id: 99999 }, chat: { id: 99999 } });
    expect(called).toBe(false);
  });

  it('drops when from.id is missing', async () => {
    const called = await runMiddleware(cfg, { chat: { id: 12345 } });
    expect(called).toBe(false);
  });

  it('drops negative / zero / boundary values that are not allowed', async () => {
    expect(await runMiddleware(cfg, { from: { id: 0 }, chat: { id: 0 } })).toBe(false);
    expect(await runMiddleware(cfg, { from: { id: -1 }, chat: { id: -1 } })).toBe(false);
  });

  it('does not escalate when from.id is NOT in allowlist regardless of chat.id', async () => {
    const called = await runMiddleware(cfg, { from: { id: 77 }, chat: { id: 12345 } });
    expect(called).toBe(false);
  });
});
