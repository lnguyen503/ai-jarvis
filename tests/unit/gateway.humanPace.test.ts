/**
 * Unit tests — src/gateway/humanPace.ts (v1.22.2).
 *
 * Verifies the delay calculation is content-length-scaled with bounded
 * jitter and a hard ceiling, and that sleepWithTyping pulses on the
 * expected interval.
 */

import { describe, it, expect } from 'vitest';
import {
  humanPaceDelayMs,
  sleepWithTyping,
  HUMAN_PACE_DEFAULTS,
} from '../../src/gateway/humanPace.js';

describe('humanPaceDelayMs', () => {
  it('returns base + 0 jitter for an empty reply with random=0.5', () => {
    expect(humanPaceDelayMs(0, HUMAN_PACE_DEFAULTS, () => 0.5)).toBe(HUMAN_PACE_DEFAULTS.baseMs);
  });

  it('scales with reply length', () => {
    const short = humanPaceDelayMs(10, HUMAN_PACE_DEFAULTS, () => 0.5);
    const long = humanPaceDelayMs(100, HUMAN_PACE_DEFAULTS, () => 0.5);
    expect(long).toBeGreaterThan(short);
    expect(long - short).toBe(90 * HUMAN_PACE_DEFAULTS.perCharMs);
  });

  it('caps at maxMs even for very long replies', () => {
    const huge = humanPaceDelayMs(100_000, HUMAN_PACE_DEFAULTS, () => 0.5);
    expect(huge).toBe(HUMAN_PACE_DEFAULTS.maxMs);
  });

  it('applies positive jitter when random=1', () => {
    const without = humanPaceDelayMs(20, HUMAN_PACE_DEFAULTS, () => 0.5);
    const with1 = humanPaceDelayMs(20, HUMAN_PACE_DEFAULTS, () => 1);
    expect(with1).toBeGreaterThan(without);
    // 0.5 jitter range = ± 250ms (default jitterMs/2 = 250)
    expect(with1 - without).toBe(250);
  });

  it('applies negative jitter when random=0', () => {
    const without = humanPaceDelayMs(20, HUMAN_PACE_DEFAULTS, () => 0.5);
    const with0 = humanPaceDelayMs(20, HUMAN_PACE_DEFAULTS, () => 0);
    expect(with0).toBeLessThan(without);
    expect(without - with0).toBe(250);
  });

  it('never returns negative values even with maximum negative jitter', () => {
    const cfg = { baseMs: 100, perCharMs: 0, jitterMs: 1000, maxMs: 8000 };
    expect(humanPaceDelayMs(0, cfg, () => 0)).toBe(0); // 100 - 500 = -400 → clamped to 0
  });
});

describe('sleepWithTyping', () => {
  it('sends at least one typing pulse for any non-zero delay', async () => {
    let pulses = 0;
    await sleepWithTyping(50, async () => {
      pulses++;
    });
    expect(pulses).toBeGreaterThanOrEqual(1);
  });

  it('returns immediately for zero or negative delays', async () => {
    let pulses = 0;
    const start = Date.now();
    await sleepWithTyping(0, async () => {
      pulses++;
    });
    expect(Date.now() - start).toBeLessThan(50);
    expect(pulses).toBe(0);
  });

  it('swallows pulse errors without rejecting', async () => {
    await expect(
      sleepWithTyping(50, async () => {
        throw new Error('typing failed');
      }),
    ).resolves.toBeUndefined();
  });
});
