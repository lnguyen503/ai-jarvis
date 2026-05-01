/**
 * Tests for src/debate/panelRender.ts
 *
 * Covers:
 *  - renderDebateSummary for each status variant
 *  - renderDebateDetail: 2 rounds → no elision
 *  - renderDebateDetail: 5 rounds exceeding budget → round 1 + last round preserved + middle marker
 *  - Single-turn overflow → turn truncated with …
 *  - HTML escape: <script> tag passed through escape()
 *  - renderDebateButtons per terminal/mode combinations
 */

import { describe, expect, it } from 'vitest';
import {
  renderDebateSummary,
  renderDebateDetail,
  renderDebateButtons,
  groupTurnsByRound,
} from '../../src/debate/panelRender.js';
import type { DebateState, Turn } from '../../src/debate/index.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeState(overrides: Partial<DebateState> = {}): DebateState {
  return {
    status: 'starting',
    topic: 'Should we use TypeScript or JavaScript?',
    roster: ['model-a', 'model-b', 'model-c'],
    currentRound: 0,
    totalRounds: 3,
    currentModel: null,
    transcript: [],
    verdict: null,
    cancelled: false,
    startedAt: Date.now(),
    endedAt: null,
    exchangesPerRound: 1,
    ...overrides,
  };
}

function makeTurn(model: string, text: string): Turn {
  return { model, text };
}

function makeRound(roundIdx: number, models: string[] = ['model-a', 'model-b']): Turn[] {
  return models.map((m) => makeTurn(m, `Round ${roundIdx} argument from ${m}: some detailed analysis here.`));
}

// ---------------------------------------------------------------------------
// renderDebateSummary
// ---------------------------------------------------------------------------

describe('renderDebateSummary', () => {
  it('starting status', () => {
    const s = makeState({ status: 'starting' });
    const result = renderDebateSummary(s);
    expect(result).toContain('starting...');
    expect(result).toContain('Debate:');
    expect(result).toContain('TypeScript');
  });

  it('running status — no currentModel', () => {
    const s = makeState({ status: 'running', currentRound: 2, totalRounds: 3, currentModel: null });
    const result = renderDebateSummary(s);
    expect(result).toContain('Round 2/3');
    expect(result).not.toContain('speaking...');
  });

  it('running status — with currentModel', () => {
    const s = makeState({ status: 'running', currentRound: 1, totalRounds: 3, currentModel: 'model-a' });
    const result = renderDebateSummary(s);
    expect(result).toContain('model-a speaking...');
    expect(result).toContain('Round 1/3');
  });

  it('judging status', () => {
    const s = makeState({ status: 'judging', currentRound: 2, totalRounds: 3 });
    const result = renderDebateSummary(s);
    expect(result).toContain('judging...');
    expect(result).toContain('Round 2/3 complete');
  });

  it('synthesizing-verdict status', () => {
    const s = makeState({ status: 'synthesizing-verdict' });
    const result = renderDebateSummary(s);
    expect(result).toContain('synthesizing verdict');
  });

  it('consensus status (v1.12.1: panel summary compact; full verdict goes to standalone message)', () => {
    const s = makeState({
      status: 'consensus',
      currentRound: 2,
      totalRounds: 3,
      verdict: { kind: 'consensus', summary: 'Both models agree on TypeScript.' },
    });
    const result = renderDebateSummary(s);
    expect(result).toContain('Consensus reached');
    expect(result).toContain('2 rounds');
    expect(result).toContain('🏆');
    // Verdict body is in the standalone message, NOT in the panel summary.
    expect(result).not.toContain('TypeScript');
  });

  it('final-verdict status (v1.12.1: compact summary; verdict in standalone message)', () => {
    const s = makeState({
      status: 'final-verdict',
      currentRound: 3,
      totalRounds: 3,
      verdict: {
        kind: 'final-arbiter',
        summary: 'TypeScript wins.',
        decision: 'Use TypeScript for type safety.',
        rationale: 'Better tooling.',
        dissent: 'Model B prefers JS.',
      },
    });
    const result = renderDebateSummary(s);
    expect(result).toContain('Claude verdict');
    expect(result).toContain('⚖️');
    expect(result).toContain('3 rounds');
    // Verdict body is in the standalone message, NOT in the panel summary.
    expect(result).not.toContain('TypeScript');
  });

  it('cancelled status', () => {
    const s = makeState({ status: 'cancelled', currentRound: 2, totalRounds: 3, cancelled: true });
    const result = renderDebateSummary(s);
    expect(result).toContain('cancelled');
    expect(result).toContain('round 2 of 3');
  });

  it('truncates long topics to 80 chars', () => {
    const longTopic = 'x'.repeat(200);
    const s = makeState({ topic: longTopic });
    const result = renderDebateSummary(s);
    expect(result).toContain('…');
    // The summary should not contain the full 200-char topic
    expect(result.length).toBeLessThan(300);
  });

  it('HTML-escapes topic in summary', () => {
    const s = makeState({ topic: '<b>bold</b> topic' });
    const result = renderDebateSummary(s);
    expect(result).toContain('&lt;b&gt;');
    expect(result).not.toContain('<b>');
  });
});

// ---------------------------------------------------------------------------
// renderDebateDetail
// ---------------------------------------------------------------------------

describe('renderDebateDetail', () => {
  it('returns "(no turns yet)" for empty transcript', () => {
    const s = makeState({ transcript: [] });
    const result = renderDebateDetail(s);
    expect(result).toContain('no turns yet');
    expect(result).toContain('Debate:');
  });

  it('2 rounds without overflow — shows all turns, no elision marker', () => {
    const round1 = makeRound(1);
    const round2 = makeRound(2);
    const s = makeState({
      status: 'running',
      totalRounds: 2,
      roster: ['model-a', 'model-b'],
      transcript: [...round1, ...round2],
      currentRound: 2,
    });
    const result = renderDebateDetail(s);
    expect(result).toContain('Round 1 argument from model-a');
    expect(result).toContain('Round 2 argument from model-b');
    // No elision marker for 2 rounds
    expect(result).not.toContain('rounds omitted');
  });

  it('5 rounds exceeding budget — preserves round 1 and last round, elides middle', () => {
    // Create 5 rounds of turns with very long text to force overflow
    const longText = 'x'.repeat(800);
    const rounds: Turn[] = [];
    for (let r = 1; r <= 5; r++) {
      for (const m of ['model-a', 'model-b']) {
        rounds.push(makeTurn(m, `R${r}: ${longText}`));
      }
    }
    const s = makeState({
      status: 'running',
      totalRounds: 5,
      roster: ['model-a', 'model-b'],
      transcript: rounds,
      currentRound: 5,
    });
    const result = renderDebateDetail(s);

    // Round 1 must be present
    expect(result).toContain('R1:');
    // Last round (round 5) must be present
    expect(result).toContain('R5:');
    // Middle elision marker must appear
    expect(result).toContain('rounds omitted');
    // Total length must be within budget
    expect(result.length).toBeLessThanOrEqual(4000);
  });

  it('single-turn overflow — truncates that turn with …', () => {
    // One very long turn
    const s = makeState({
      status: 'running',
      totalRounds: 1,
      roster: ['model-a'],
      transcript: [makeTurn('model-a', 'x'.repeat(5000))],
      currentRound: 1,
    });
    const result = renderDebateDetail(s);
    expect(result).toContain('…');
    expect(result.length).toBeLessThanOrEqual(4100); // some headroom for header
  });

  it('includes verdict footer when present', () => {
    const s = makeState({
      status: 'consensus',
      transcript: [makeTurn('model-a', 'TypeScript is better')],
      verdict: { kind: 'consensus', summary: 'Both agree on TypeScript.' },
    });
    const result = renderDebateDetail(s);
    expect(result).toContain('Consensus reached');
    expect(result).toContain('Both agree on TypeScript.');
  });

  it('HTML-escapes transcript text', () => {
    const s = makeState({
      transcript: [makeTurn('model-a', '<script>alert(1)</script>')],
    });
    const result = renderDebateDetail(s);
    expect(result).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(result).not.toContain('<script>');
  });

  it('HTML-escapes topic in detail header', () => {
    const s = makeState({
      topic: '<script>alert(1)</script>',
      transcript: [makeTurn('model-a', 'Normal text')],
    });
    const result = renderDebateDetail(s);
    expect(result).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(result).not.toContain('<script>');
  });

  it('escapes model names in transcript', () => {
    const s = makeState({
      transcript: [makeTurn('<evil>', 'hello')],
    });
    const result = renderDebateDetail(s);
    expect(result).toContain('&lt;evil&gt;');
    expect(result).not.toContain('<evil>');
  });
});

// ---------------------------------------------------------------------------
// HTML escape security — R11 explicit fixture test
// ---------------------------------------------------------------------------

describe('R11 HTML escape enforcement', () => {
  it('<script>alert(1)</script> in topic → &lt;script&gt; in renderDetail output', () => {
    const state = makeState({
      topic: '<script>alert(1)</script>',
      transcript: [makeTurn('model-x', '<script>xss()</script>')],
    });
    const result = renderDebateDetail(state);
    // Both topic and transcript turn must be escaped
    expect(result).not.toContain('<script>');
    expect(result).toMatch(/&lt;script&gt;/);
  });

  it('<script> in transcript text → &lt;script&gt; in renderDetail', () => {
    const state = makeState({
      transcript: [
        makeTurn('model-x', '<script>alert("injected")</script>'),
      ],
    });
    const result = renderDebateDetail(state);
    expect(result).not.toContain('<script>');
    expect(result).toContain('&lt;script&gt;');
  });

  it('<script> in topic → &lt;script&gt; in renderSummary output', () => {
    const state = makeState({ topic: '<script>alert(1)</script>' });
    const result = renderDebateSummary(state);
    expect(result).not.toContain('<script>');
    expect(result).toContain('&lt;script&gt;');
  });
});

  it('2 rounds × exchangesPerRound=2 × 3 debaters — groups 12 turns as 2 rounds of 6 (Fix 2)', () => {
    // With 3 debaters and 2 exchanges per round, each round has 3×2=6 turns.
    // 2 rounds = 12 turns total.
    const turns: Turn[] = [];
    for (let round = 1; round <= 2; round++) {
      for (let exchange = 1; exchange <= 2; exchange++) {
        for (const model of ['model-a', 'model-b', 'model-c']) {
          turns.push(makeTurn(model, `R${round}E${exchange} from ${model}`));
        }
      }
    }
    // 12 turns, 2 rounds, exchangesPerRound=2, roster=3 models
    const s = makeState({
      status: 'final-verdict',
      totalRounds: 2,
      roster: ['model-a', 'model-b', 'model-c'],
      transcript: turns,
      currentRound: 2,
      exchangesPerRound: 2,
    });

    // Verify groupTurnsByRound produces 2 groups of 6
    const turnsPerRound = 3 * 2; // roster × exchangesPerRound
    const groups = groupTurnsByRound(turns, 2, turnsPerRound);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toHaveLength(6);
    expect(groups[1]).toHaveLength(6);

    // Verify renderDebateDetail uses the correct grouping
    const result = renderDebateDetail(s);
    // Round 1 and Round 2 turns should both appear (no elision needed — 2 < 3 rounds)
    expect(result).toContain('R1E1 from model-a');
    expect(result).toContain('R2E2 from model-c');
    // No middle elision marker for 2 rounds
    expect(result).not.toContain('rounds omitted');
  });

// ---------------------------------------------------------------------------
// renderDebateButtons
// ---------------------------------------------------------------------------

describe('renderDebateButtons', () => {
  const panelId = 'test-panel-abc';
  const s = makeState();

  it('non-terminal collapsed — expand + cancel buttons', () => {
    const kb = renderDebateButtons(panelId, s, 'collapsed', false);
    expect(kb).toHaveLength(1);
    const row = kb[0]!;
    expect(row).toHaveLength(2);
    expect(row[0]!.label).toContain('Expand');
    expect(row[0]!.data).toBe(`debate.expand:${panelId}`);
    expect(row[1]!.label).toContain('Cancel');
    expect(row[1]!.data).toBe(`debate.cancel:${panelId}`);
  });

  it('non-terminal expanded — collapse + cancel buttons', () => {
    const kb = renderDebateButtons(panelId, s, 'expanded', false);
    const row = kb[0]!;
    expect(row[0]!.label).toContain('Collapse');
    expect(row[0]!.data).toBe(`debate.collapse:${panelId}`);
    expect(row[1]!.label).toContain('Cancel');
  });

  it('terminal collapsed — show transcript button only', () => {
    const kb = renderDebateButtons(panelId, s, 'collapsed', true);
    expect(kb).toHaveLength(1);
    const row = kb[0]!;
    expect(row).toHaveLength(1);
    expect(row[0]!.label).toContain('Show full transcript');
    expect(row[0]!.data).toBe(`debate.expand:${panelId}`);
  });

  it('terminal expanded — collapse button only', () => {
    const kb = renderDebateButtons(panelId, s, 'expanded', true);
    const row = kb[0]!;
    expect(row).toHaveLength(1);
    expect(row[0]!.label).toContain('Collapse');
    expect(row[0]!.data).toBe(`debate.collapse:${panelId}`);
  });

  it('callback_data format: <namespace>.<action>:<panelId>', () => {
    const kb = renderDebateButtons(panelId, s, 'collapsed', false);
    for (const row of kb) {
      for (const btn of row) {
        expect(btn.data).toMatch(/^debate\.(expand|collapse|cancel):[A-Za-z0-9_-]{4,31}$/);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// groupTurnsByRound
// ---------------------------------------------------------------------------

describe('groupTurnsByRound', () => {
  it('groups 6 turns into 3 rounds of 2', () => {
    const turns: Turn[] = Array.from({ length: 6 }, (_, i) => makeTurn(`m-${i}`, `text-${i}`));
    const groups = groupTurnsByRound(turns, 3, 2);
    expect(groups).toHaveLength(3);
    expect(groups[0]).toHaveLength(2);
    expect(groups[2]).toHaveLength(2);
  });

  it('returns empty array for empty transcript', () => {
    expect(groupTurnsByRound([], 3, 2)).toHaveLength(0);
  });

  it('clamps to totalRounds when there are extra turns', () => {
    const turns: Turn[] = Array.from({ length: 10 }, (_, i) => makeTurn(`m-${i}`, `t-${i}`));
    // 4 turns per round, totalRounds=2 — expect 2 groups
    const groups = groupTurnsByRound(turns, 2, 4);
    expect(groups).toHaveLength(2);
  });
});
