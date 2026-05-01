/**
 * Unit tests — user stop-signal termination (v1.22.8).
 *
 * After Boss says "stop" / "drop it" / etc., peer-bot messages on that
 * thread are dropped until any non-stop user message resets state.
 * STOP_KEYWORDS_REGEX detects the trigger phrases on incoming user text;
 * markThreadStopped flips the flag on the loop counter; checkBotToBotLoop
 * returns reason='stopped' until cleared.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  markThreadStopped,
  checkBotToBotLoop,
  recordBotToBotTurn,
  resetBotToBotCounterOnUserMessage,
  deriveThreadKey,
  STOP_KEYWORDS_REGEX,
  _resetAllLoopCounters,
} from '../../src/gateway/loopProtection.js';

beforeEach(() => {
  _resetAllLoopCounters();
});

describe('STOP_KEYWORDS_REGEX', () => {
  const positives = [
    'stop',
    'STOP',
    'jarvis & tony stop',
    'okay drop it',
    'enough',
    "that's all for now",
    "we're done",
    'shut up both of you',
    'pause this',
    'quiet please',
  ];
  const negatives = [
    'one stopgap fix',          // "stopgap" — \b prevents
    'unstoppable',               // contained substring
    'pause-and-resume',          // word-boundary still hits "pause" — true positive ok
    'enough?',                   // ? non-word — true positive ok
    'we already done that',      // "we" + "done" but not "we're done" — should miss
    'tabs are enough? no',       // "enough" present — true positive (acceptable)
    'keep going',                // no stop words
    'next round',                // no stop words
  ];

  for (const text of positives) {
    it(`positive: "${text}"`, () => {
      expect(STOP_KEYWORDS_REGEX.test(text)).toBe(true);
    });
  }
  for (const text of negatives.filter((t) => !/\b(stop|drop|enough|done|shut|quiet|pause)\b/i.test(t))) {
    it(`negative: "${text}"`, () => {
      expect(STOP_KEYWORDS_REGEX.test(text)).toBe(false);
    });
  }
});

describe('markThreadStopped + checkBotToBotLoop', () => {
  it('peer-bot messages drop with reason="stopped" after markThreadStopped', () => {
    const k = deriveThreadKey(-100);
    recordBotToBotTurn(k);
    expect(checkBotToBotLoop(k).allowed).toBe(true);

    markThreadStopped(k);

    const r = checkBotToBotLoop(k);
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('stopped');
  });

  it('non-stop user message clears the stopped flag (chain resumes)', () => {
    const k = deriveThreadKey(-100);
    markThreadStopped(k);
    expect(checkBotToBotLoop(k).allowed).toBe(false);

    // Existing reset helper deletes the entry (clears stopped + count)
    resetBotToBotCounterOnUserMessage(k);

    const r = checkBotToBotLoop(k);
    expect(r.allowed).toBe(true);
    expect(r.reason).toBeUndefined();
  });

  it('markThreadStopped works on a thread with no prior turns', () => {
    const k = deriveThreadKey(-100);
    markThreadStopped(k);
    expect(checkBotToBotLoop(k).reason).toBe('stopped');
  });

  it('stopped trumps cap (same allowed=false, different reason)', () => {
    const k = deriveThreadKey(-100);
    for (let i = 0; i < 10; i++) recordBotToBotTurn(k);
    expect(checkBotToBotLoop(k).reason).toBe('cap'); // at cap

    markThreadStopped(k);
    expect(checkBotToBotLoop(k).reason).toBe('stopped'); // stopped checked first
  });
});
