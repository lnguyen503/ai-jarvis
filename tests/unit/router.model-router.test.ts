/**
 * Tests for model router + task classifier.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { routeTask, resolveModelAlias } from '../../src/router/model-router.js';
import { classifyTask } from '../../src/router/task-classifier.js';
import { makeTestConfig, cleanupTmpRoot } from '../fixtures/makeConfig.js';
import { initMemory } from '../../src/memory/index.js';
import { _resetDb } from '../../src/memory/db.js';
import type { AppConfig } from '../../src/config/schema.js';

let cfg: AppConfig;

function setup() {
  _resetDb();
  cfg = makeTestConfig();
  // Enable routing for these tests
  cfg.ai.routing.enabled = true;
  cfg.ai.routing.logRoutingDecisions = false;
  const mem = initMemory(cfg);
  return { cfg, mem };
}

beforeEach(() => {
  _resetDb();
});

// ---------------------------------------------------------------------------
// classifyTask
// ---------------------------------------------------------------------------

// v1.22.21 — :cloud suffix dropped from canonical model names. Ollama Cloud's
// real names have no :cloud suffix; the prior convention silently 404'd
// every Ollama call and silently fell back to Claude. Tests below assert
// the post-v1.22.21 names returned by the classifier.
describe('classifyTask — keyword routing', () => {
  it('routes security/review/audit keywords to minimax-m2.7', () => {
    expect(classifyTask('please review this code for security issues').model).toBe('minimax-m2.7');
    expect(classifyTask('run a security audit').model).toBe('minimax-m2.7');
    expect(classifyTask('audit the system for vulnerabilities').model).toBe('minimax-m2.7');
  });

  it('routes architect/design/plan keywords to nemotron-3-super', () => {
    expect(classifyTask('architect a new system').model).toBe('nemotron-3-super');
    expect(classifyTask('design the database schema').model).toBe('nemotron-3-super');
    expect(classifyTask('help me plan the architecture').model).toBe('nemotron-3-super');
  });

  it('routes search/research/docs keywords to gemma4:31b', () => {
    expect(classifyTask('search for docs about Express').model).toBe('gemma4:31b');
    expect(classifyTask('research the best approach').model).toBe('gemma4:31b');
    expect(classifyTask('find documentation for this library').model).toBe('gemma4:31b');
  });

  it('routes code/build/implement/fix keywords to glm-5.1', () => {
    expect(classifyTask('implement the login feature').model).toBe('glm-5.1');
    expect(classifyTask('fix the bug in line 42').model).toBe('glm-5.1');
    expect(classifyTask('build the new API endpoint').model).toBe('glm-5.1');
    expect(classifyTask('write code for this function').model).toBe('glm-5.1');
  });

  it('defaults to gemma4:31b for unmatched input', () => {
    const result = classifyTask('Hello, how are you?');
    expect(result.model).toBe('gemma4:31b');
    expect(result.provider).toBe('ollama-cloud');
    expect(result.reason).toBe('default');
  });

  it('uses first matching keyword family (security has priority over code)', () => {
    // "review" matches security, even if "code" also appears
    const result = classifyTask('review this code for security');
    expect(result.model).toBe('minimax-m2.7');
  });
});

// ---------------------------------------------------------------------------
// routeTask
// ---------------------------------------------------------------------------

describe('routeTask — routing precedence', () => {
  it('uses keyword match when no session pin', () => {
    const { cfg, mem } = setup();
    const session = mem.sessions.getOrCreate(1001);
    const decision = routeTask('implement a new feature', session.id, cfg, mem);
    expect(decision.model).toBe('glm-5.1');
    expect(decision.reason).toContain('keyword');
    cleanupTmpRoot(cfg);
  });

  it('session pin overrides keyword routing', () => {
    const { cfg, mem } = setup();
    const session = mem.sessions.getOrCreate(1002);
    // Pin to Claude
    mem.sessionModelState.setModel(session.id, 'claude', 'claude-sonnet-4-6', true);
    const decision = routeTask('implement a new feature', session.id, cfg, mem);
    expect(decision.provider).toBe('claude');
    expect(decision.model).toBe('claude-sonnet-4-6');
    expect(decision.reason).toBe('session-pin');
    cleanupTmpRoot(cfg);
  });

  it('falls back to config default when routing disabled', () => {
    const { cfg, mem } = setup();
    cfg.ai.routing.enabled = false;
    cfg.ai.defaultProvider = 'ollama-cloud';
    cfg.ai.defaultModel = 'glm-5.1:cloud';
    const session = mem.sessions.getOrCreate(1003);
    const decision = routeTask('anything', session.id, cfg, mem);
    expect(decision.provider).toBe('ollama-cloud');
    expect(decision.model).toBe('glm-5.1:cloud');
    expect(decision.reason).toBe('config-default');
    cleanupTmpRoot(cfg);
  });

  it('session pin persists across multiple calls', () => {
    const { cfg, mem } = setup();
    const session = mem.sessions.getOrCreate(1004);
    mem.sessionModelState.setModel(session.id, 'claude', 'claude-sonnet-4-6', true);
    // Different input text, should still use pin
    const d1 = routeTask('implement', session.id, cfg, mem);
    const d2 = routeTask('research docs', session.id, cfg, mem);
    expect(d1.provider).toBe('claude');
    expect(d2.provider).toBe('claude');
    cleanupTmpRoot(cfg);
  });

  it('uses keyword routing after pin is cleared', () => {
    const { cfg, mem } = setup();
    const session = mem.sessions.getOrCreate(1005);
    mem.sessionModelState.setModel(session.id, 'claude', 'claude-sonnet-4-6', true);
    mem.sessionModelState.clearOverride(session.id);
    const decision = routeTask('implement a feature', session.id, cfg, mem);
    // After clearing pin, keyword routing takes over
    expect(decision.model).toBe('glm-5.1');
    cleanupTmpRoot(cfg);
  });
});

// ---------------------------------------------------------------------------
// resolveModelAlias
// ---------------------------------------------------------------------------

describe('resolveModelAlias', () => {
  it('returns null for "auto"', () => {
    const cfg = makeTestConfig();
    expect(resolveModelAlias('auto', cfg)).toBeNull();
    cleanupTmpRoot(cfg);
  });

  it('resolves "claude" to premium provider', () => {
    const cfg = makeTestConfig();
    const result = resolveModelAlias('claude', cfg);
    expect(result?.provider).toBe('claude');
    expect(result?.model).toBe('claude-sonnet-4-6');
    cleanupTmpRoot(cfg);
  });

  it('resolves "premium" to premium provider', () => {
    const cfg = makeTestConfig();
    const result = resolveModelAlias('premium', cfg);
    expect(result?.provider).toBe('claude');
    cleanupTmpRoot(cfg);
  });

  it('resolves unknown model name as ollama-cloud', () => {
    const cfg = makeTestConfig();
    const result = resolveModelAlias('gemma4:cloud', cfg);
    expect(result?.provider).toBe('ollama-cloud');
    expect(result?.model).toBe('gemma4:cloud');
    cleanupTmpRoot(cfg);
  });
});
