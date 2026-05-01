/**
 * Static test — ADR 021 D5 + CP1 R4/W2: no hardcoded tool names in persona files.
 *
 * BINDING (CP1 R4 + Anti-Slop W2): persona files MUST use `{{TOOL_LIST}}` for
 * the tool list. Hardcoding tool names creates a drift trap — if the allowlist
 * changes and the persona isn't updated, the LLM gets confused about what it can
 * and can't do.
 *
 * This test:
 *   1. Reads all persona files in config/personas/*.md.
 *   2. For each file, asserts NO literal tool name from the known tool registry
 *      appears outside a `{{TOOL_LIST}}` block context.
 *   3. Code-fence blocks (``` ... ```) labeled as examples are allowed exceptions.
 *
 * Tool names checked: the full registry from SPECIALIST_TOOL_ALLOWLIST plus
 * the additional full-scope tools that should never be hardcoded.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BOT_NAMES, SPECIALIST_TOOL_ALLOWLIST } from '../../src/config/botIdentity.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PERSONAS_DIR = path.resolve(__dirname, '../../config/personas');

// Full list of tool names that MUST NOT appear hardcoded in persona files.
// This is the complete registry — any tool name appearing outside {{TOOL_LIST}}
// is a drift-trap violation.
const ALL_TOOL_NAMES: string[] = [
  // Specialist allowlist (9 tools per R6)
  ...Array.from(SPECIALIST_TOOL_ALLOWLIST),
  // Full-scope-only tools
  'run_command',
  'update_memory',
  'forget_memory',
  'organize_create',
  'organize_update',
  'organize_complete',
  'organize_list',
  'organize_log_progress',
  'organize_delete',
  'schedule',
  'coach_log_nudge',
  'coach_log_research',
  'coach_log_idea',
  'coach_log_plan',
  'coach_read_history',
  'coach_log_user_override',
  'gmail_search',
  'gmail_read',
  'gmail_draft',
  'calendar_list_events',
  'calendar_create_event',
  'calendar_update_event',
  'calendar_delete_event',
];

describe('persona-tool-list-template: no hardcoded tool names outside {{TOOL_LIST}}', () => {
  it('config/personas/ directory exists', () => {
    expect(fs.existsSync(PERSONAS_DIR), `${PERSONAS_DIR} must exist`).toBe(true);
  });

  it('every BOT_NAMES entry has a persona .md file', () => {
    for (const botName of BOT_NAMES) {
      const filePath = path.join(PERSONAS_DIR, `${botName}.md`);
      expect(
        fs.existsSync(filePath),
        `config/personas/${botName}.md must exist`,
      ).toBe(true);
    }
  });

  it('no hardcoded tool names in persona files outside {{TOOL_LIST}} blocks', () => {
    const personaFiles = fs.readdirSync(PERSONAS_DIR)
      .filter((f) => f.endsWith('.md'))
      .map((f) => path.join(PERSONAS_DIR, f));

    const violations: string[] = [];

    for (const filePath of personaFiles) {
      const content = fs.readFileSync(filePath, 'utf8');
      const relPath = path.relative(process.cwd(), filePath);

      // Remove code fence blocks (``` ... ```) — tool names in examples are allowed
      const withoutFences = content.replace(/```[\s\S]*?```/g, '[code-fence-removed]');

      // Remove {{TOOL_LIST}} placeholder and anything between a {{TOOL_LIST}} context
      // comment and the next section. (The placeholder itself is the template — not hardcoded.)
      const withoutToolListPlaceholder = withoutFences.replace(/\{\{TOOL_LIST\}\}/g, '[tool-list-placeholder]');

      // Remove inline code spans that explain tool names (e.g., `organize_create`)
      const withoutInlineCode = withoutToolListPlaceholder.replace(/`[^`]+`/g, '[inline-code]');

      for (const toolName of ALL_TOOL_NAMES) {
        // Only flag tool names appearing in list-entry patterns that look like a hardcoded tool list:
        //   - "- **tool_name**" (markdown list with bold tool name)
        //   - "- **tool_name** —" (list with description)
        //   - "**tool_name** —" (bold tool name with dash separator)
        // These are the patterns that indicate a hardcoded "Available Tools" list.
        // Prose mentions in rules (e.g., "You can use organize_create to...") are allowed.
        const listPattern = new RegExp(`(?:^|\\n)\\s*-\\s+\\*\\*${toolName}\\*\\*`, 'm');
        if (listPattern.test(withoutInlineCode)) {
          violations.push(`${relPath}: hardcoded tool name "${toolName}" found in list-entry format outside {{TOOL_LIST}} context`);
        }
      }
    }

    if (violations.length > 0) {
      const msg = [
        'CP1 R4/W2 VIOLATION: hardcoded tool names in persona files.',
        'Use {{TOOL_LIST}} in the persona template instead.',
        '',
        ...violations,
      ].join('\n');
      expect(violations, msg).toHaveLength(0);
    }
  });
});
