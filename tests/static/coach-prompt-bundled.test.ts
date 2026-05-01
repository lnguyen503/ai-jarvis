/**
 * Static test — R6(b) build script copies coachPrompt.md to dist/coach/coachPrompt.md.
 *
 * ADR 018 Decision 5 + R6(b).a binding:
 *   - dist/coach/coachPrompt.md must exist after `npm run build`
 *   - must be non-empty (>= 100 chars)
 *   - must contain the Coach Mode sentinel phrase used by loadCoachPrompt()
 *
 * Run AFTER `npm run build`. If dist/ is stale, this test will catch the regression.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const distCoachDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../dist/coach',
);
const promptDistPath = path.join(distCoachDir, 'coachPrompt.md');

describe('R6(b) — coachPrompt.md bundled in dist/coach/', () => {
  it('dist/coach/coachPrompt.md exists after build', () => {
    expect(
      existsSync(promptDistPath),
      `Expected ${promptDistPath} to exist — run \`npm run build\` first`,
    ).toBe(true);
  });

  it('dist/coach/coachPrompt.md is non-empty (>= 100 chars)', () => {
    const content = readFileSync(promptDistPath, 'utf8');
    expect(content.length).toBeGreaterThanOrEqual(100);
  });

  it('dist/coach/coachPrompt.md contains the Coach Mode sentinel phrase', () => {
    const content = readFileSync(promptDistPath, 'utf8');
    expect(content).toContain('Coach Mode');
  });

  it('src/coach/coachPrompt.md and dist/coach/coachPrompt.md have identical content', () => {
    const srcPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../src/coach/coachPrompt.md',
    );
    const srcContent = readFileSync(srcPath, 'utf8');
    const distContent = readFileSync(promptDistPath, 'utf8');
    expect(distContent).toBe(srcContent);
  });
});
