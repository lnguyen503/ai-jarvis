import { describe, expect, it } from 'vitest';
import { parseTaskList } from '../../src/plan/planner.js';

describe('parseTaskList', () => {
  it('parses a clean numbered list', () => {
    const text = `1. Search for recent news
2. Read top 3 articles
3. Compose summary`;
    expect(parseTaskList(text)).toEqual([
      'Search for recent news',
      'Read top 3 articles',
      'Compose summary',
    ]);
  });

  it('parses an unnumbered single-sentence-per-line list', () => {
    const text = `Search for recent news on EV charging.
Browse the top 3 results and extract facts.
Compile a one-page summary.`;
    expect(parseTaskList(text)).toEqual([
      'Search for recent news on EV charging.',
      'Browse the top 3 results and extract facts.',
      'Compile a one-page summary.',
    ]);
  });

  it('strips bullet markers (-, *, •)', () => {
    const text = `- First task
* Second task
• Third task`;
    expect(parseTaskList(text)).toEqual(['First task', 'Second task', 'Third task']);
  });

  it('handles "1)" and "1 -" style numbering', () => {
    const text = `1) Task one
2) Task two
3 - Task three`;
    const got = parseTaskList(text);
    expect(got).toEqual(['Task one', 'Task two', 'Task three']);
  });

  it('drops blank lines and very short lines', () => {
    const text = `1. Real task

ok
2. Another real task`;
    expect(parseTaskList(text)).toEqual(['Real task', 'Another real task']);
  });

  it('returns [] on empty input', () => {
    expect(parseTaskList('')).toEqual([]);
    expect(parseTaskList('   \n  \n')).toEqual([]);
  });
});
