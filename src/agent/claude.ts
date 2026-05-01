/**
 * Backward-compat re-export shim.
 * The canonical implementations live in src/providers/claude.ts.
 * This file is kept so existing imports (tests, agent/index.ts) don't break.
 */
export { callClaude, createClaudeClient, ClaudeProvider } from '../providers/claude.js';
