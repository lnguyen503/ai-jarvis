import express from 'express';
import type { Server } from 'http';
import type { AppConfig } from '../config/index.js';
import { child } from '../logger/index.js';

const log = child({ component: 'gateway.health' });

export interface HealthServer {
  start(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Localhost-only health endpoint (ARCH §1, §9, ADR A2).
 * Binds to 127.0.0.1 explicitly — no remote exposure.
 * Response contains ONLY { ok, uptimeSec, version } — no session data, no PII.
 */
export function createHealthServer(cfg: AppConfig, version: string): HealthServer {
  const app = express();
  const port = cfg.health.port;
  const startTime = Date.now();

  app.get('/health', (_req, res) => {
    const uptimeSec = Math.floor((Date.now() - startTime) / 1000);
    res.json({ ok: true, uptimeSec, version });
  });

  // Default 404 for any other path (don't accidentally expose more)
  app.use((_req, res) => {
    res.status(404).json({ ok: false, error: 'Not Found' });
  });

  let server: Server | null = null;

  return {
    async start(): Promise<void> {
      return new Promise((resolve, reject) => {
        server = app.listen(port, '127.0.0.1', () => {
          log.info({ port }, 'Health endpoint listening on 127.0.0.1');
          resolve();
        });
        server.on('error', (err) => {
          log.error({ err: err.message, port }, 'Health endpoint failed to start');
          reject(err);
        });
      });
    },

    async stop(): Promise<void> {
      if (!server) return;
      return new Promise((resolve) => {
        server!.close(() => {
          log.info({}, 'Health endpoint stopped');
          resolve();
        });
      });
    },
  };
}
