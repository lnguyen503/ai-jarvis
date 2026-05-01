/**
 * Static test — .env.example documents BOT_TOKEN_AI_JARVIS + BOT_TOKEN_AI_TONY (v1.21.0).
 *
 * Assertions:
 *   1. .env.example contains the key BOT_TOKEN_AI_JARVIS.
 *   2. .env.example contains the key BOT_TOKEN_AI_TONY.
 *   3. Both keys appear as line-start assignments (KEY=...) per dotenv convention.
 *
 * Part of ADR 021 Pillar 3 (D11 + D12) — ensures the operator setup guide
 * documents every token env var that BOT_MARKER_BY_NAME references.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_EXAMPLE_PATH = path.resolve(__dirname, '../../.env.example');

describe('.env.example bot token documentation (ADR 021 Pillar 3)', () => {
  let content: string;

  it('.env.example is readable', () => {
    content = fs.readFileSync(ENV_EXAMPLE_PATH, 'utf8');
    expect(content.length).toBeGreaterThan(0);
  });

  it('documents BOT_TOKEN_AI_JARVIS', () => {
    if (!content) content = fs.readFileSync(ENV_EXAMPLE_PATH, 'utf8');
    expect(content).toContain('BOT_TOKEN_AI_JARVIS');
  });

  it('documents BOT_TOKEN_AI_TONY', () => {
    if (!content) content = fs.readFileSync(ENV_EXAMPLE_PATH, 'utf8');
    expect(content).toContain('BOT_TOKEN_AI_TONY');
  });

  it('BOT_TOKEN_AI_JARVIS appears as a line-start key assignment', () => {
    if (!content) content = fs.readFileSync(ENV_EXAMPLE_PATH, 'utf8');
    const lines = content.split('\n');
    const found = lines.some((line) => line.startsWith('BOT_TOKEN_AI_JARVIS='));
    expect(found).toBe(true);
  });

  it('BOT_TOKEN_AI_TONY appears as a line-start key assignment', () => {
    if (!content) content = fs.readFileSync(ENV_EXAMPLE_PATH, 'utf8');
    const lines = content.split('\n');
    const found = lines.some((line) => line.startsWith('BOT_TOKEN_AI_TONY='));
    expect(found).toBe(true);
  });
});
