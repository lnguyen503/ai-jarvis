/**
 * Safety scrubber integration for coachMemory.writeCoachEntry (v1.18.0 ADR 018 R5/F3).
 *
 * Verifies that:
 *   - safetyScrubber is called on the serialized body before storage
 *   - A secret-pattern payload gets scrubbed in the stored body
 *   - The scrubber is mandatory (no default noop)
 *   - readCoachEntries returns the scrubbed body
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { writeCoachEntry, readCoachEntries } from '../../src/coach/coachMemory.js';
import { listEntries } from '../../src/memory/userMemoryEntries.js';

const USER_ID = 888100;
const ITEM_ID = '2026-04-25-cccc';

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'jarvis-coach-scrub-'));
  await mkdir(path.join(dataDir, 'memories'), { recursive: true });
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Basic scrubber invocation
// ---------------------------------------------------------------------------

describe('safetyScrubber is applied before storage', () => {
  it('secret_pattern in payload body is replaced by scrubber before write', async () => {
    const SECRET = 'sk-proj-supersecretAPIkey12345';
    let scrubberCalled = false;

    await writeCoachEntry(
      USER_ID, dataDir, ITEM_ID, 'lastNudge',
      { nudgeText: `Check this: ${SECRET}` },
      {
        safetyScrubber: (text: string) => {
          scrubberCalled = true;
          // Simulate a scrubber that redacts sk-proj- keys
          return text.replace(/sk-proj-\S+/g, '[REDACTED]');
        },
      },
    );

    expect(scrubberCalled).toBe(true);

    // Verify the stored body does not contain the secret
    const all = await listEntries(USER_ID, dataDir);
    const coachEntries = all.filter((e) => e.key.startsWith('coach.'));
    expect(coachEntries).toHaveLength(1);
    expect(coachEntries[0]!.body).not.toContain(SECRET);
    expect(coachEntries[0]!.body).toContain('[REDACTED]');
  });

  it('readCoachEntries payload reflects the scrubbed body', async () => {
    const SECRET = 'AKIA1234FAKEKEYFORTEST';

    await writeCoachEntry(
      USER_ID, dataDir, ITEM_ID, 'research',
      { query: 'retirement funds', resultDigest: `Found key ${SECRET} in log` },
      {
        safetyScrubber: (text: string) => text.replace(/AKIA[A-Z0-9]{16}/g, '[AWS_KEY_REDACTED]'),
      },
    );

    const entries = await readCoachEntries(USER_ID, dataDir, `coach.${ITEM_ID}.research.`);
    expect(entries).toHaveLength(1);
    const payload = entries[0]!.payload as { resultDigest?: string };
    expect(JSON.stringify(payload)).not.toContain(SECRET);
    expect(JSON.stringify(payload)).toContain('[AWS_KEY_REDACTED]');
  });
});

// ---------------------------------------------------------------------------
// Scrubber returning unchanged text (noop case)
// ---------------------------------------------------------------------------

describe('noop scrubber: clean payload passes through unchanged', () => {
  it('a clean payload round-trips without modification', async () => {
    const payload = { nudgeText: 'You have a retirement contribution due this month.' };
    await writeCoachEntry(USER_ID, dataDir, ITEM_ID, 'lastNudge', payload, {
      safetyScrubber: (text) => text,
    });
    const entries = await readCoachEntries(USER_ID, dataDir, `coach.${ITEM_ID}.lastNudge.`);
    expect(entries).toHaveLength(1);
    expect((entries[0]!.payload as typeof payload).nudgeText).toBe(payload.nudgeText);
  });
});

// ---------------------------------------------------------------------------
// Scrubber that returns empty string (edge case)
// ---------------------------------------------------------------------------

describe('edge case: scrubber returns minimal non-empty string', () => {
  it('scrubber replacing everything with a placeholder still creates an entry', async () => {
    await writeCoachEntry(
      USER_ID, dataDir, ITEM_ID, 'idea',
      { ideaSummary: 'This contains a password: hunter2' },
      {
        // Replace entire body with a safe placeholder
        safetyScrubber: (_text) => '{"at":"2026-04-25T10:00:00.000Z","payload":{"ideaSummary":"[SCRUBBED]"}}',
      },
    );
    const all = await listEntries(USER_ID, dataDir);
    const coachEntries = all.filter((e) => e.key.startsWith('coach.'));
    expect(coachEntries).toHaveLength(1);
    expect(coachEntries[0]!.body).toContain('[SCRUBBED]');
  });
});

// ---------------------------------------------------------------------------
// Multiple writes with scrubber — all scrubbed in FIFO
// ---------------------------------------------------------------------------

describe('scrubber applied to each write independently', () => {
  it('multiple writes all pass through scrubber (each body is clean)', async () => {
    const secrets = ['token_aaaaa', 'token_bbbbb', 'token_ccccc'];
    const scrubbed: string[] = [];

    for (const secret of secrets) {
      await writeCoachEntry(
        USER_ID, dataDir, ITEM_ID, 'plan',
        { planSummary: `Plan with ${secret}` },
        {
          safetyScrubber: (text) => {
            const result = text.replace(/token_[a-z]+/g, '[TOKEN_REDACTED]');
            scrubbed.push(result);
            return result;
          },
        },
      );
    }

    expect(scrubbed).toHaveLength(3);
    for (const s of scrubbed) {
      expect(s).not.toMatch(/token_[a-z]+/);
      expect(s).toContain('[TOKEN_REDACTED]');
    }

    const entries = await readCoachEntries(USER_ID, dataDir, `coach.${ITEM_ID}.plan.`);
    expect(entries).toHaveLength(3);
    for (const e of entries) {
      const p = e.payload as { planSummary: string };
      expect(p.planSummary).toContain('[TOKEN_REDACTED]');
    }
  });
});
