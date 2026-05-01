/**
 * F-05: Tests for gateway/health.ts
 * Verifies the health endpoint starts, serves /health, and stops cleanly.
 */
import { describe, it, expect } from 'vitest';
import { createHealthServer } from '../../src/gateway/health.js';
import { makeTestConfig } from '../fixtures/makeConfig.js';

describe('gateway/health.ts', () => {
  it('serves /health endpoint on localhost with ok:true', async () => {
    const cfg = makeTestConfig();
    // Use a random-ish high port to avoid conflicts
    cfg.health.port = 17878;
    const server = createHealthServer(cfg, '1.0.0-test');

    await server.start();
    try {
      const res = await fetch('http://127.0.0.1:17878/health');
      expect(res.ok).toBe(true);
      const body = await res.json() as { ok: boolean; version: string; uptimeSec: number };
      expect(body.ok).toBe(true);
      expect(body.version).toBe('1.0.0-test');
      expect(typeof body.uptimeSec).toBe('number');
    } finally {
      await server.stop();
    }
  });

  it('returns 404 for unknown paths', async () => {
    const cfg = makeTestConfig();
    cfg.health.port = 17879;
    const server = createHealthServer(cfg, '1.0.0-test');

    await server.start();
    try {
      const res = await fetch('http://127.0.0.1:17879/unknown');
      expect(res.status).toBe(404);
      const body = await res.json() as { ok: boolean };
      expect(body.ok).toBe(false);
    } finally {
      await server.stop();
    }
  });
});
