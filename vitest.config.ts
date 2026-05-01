import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Forward-slash paths per KNOWN_ISSUES.md
    root: path.resolve(__dirname).replace(/\\/g, '/'),
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: [
        // Boot wiring — thin orchestration wrapper; no testable logic
        'src/index.ts',
        // System prompt template loader — tested indirectly via agent.turn tests
        'src/agent/systemPrompt.ts',
      ],
      thresholds: {
        lines: 80,
      },
    },
    testTimeout: 15000,
    pool: 'forks',
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
});
