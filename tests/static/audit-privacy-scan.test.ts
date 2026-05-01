/**
 * Static audit privacy scan — deterministic Gate H (v1.17.0).
 *
 * ADR 017 W3 BINDING:
 * Scans the audit/memory/scheduled shared modules for raw field-value patterns
 * that would violate the privacy posture (no content in audit detail_json).
 *
 * Pattern: identifier followed by colon and whitespace (e.g., `value: `, `body: `)
 * inside audit helper files. These patterns would indicate a developer injected
 * actual content values into the audit rows.
 *
 * Exceptions are allowed via inline `// ALLOWED: <reason>` comments.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const FILES = [
  'src/webapp/audit.list.ts',
  'src/webapp/audit.shared.ts',
  'src/webapp/memory.shared.ts',
  'src/webapp/scheduled.shared.ts',
  // v1.18.0 P2 fix Item 4 (QA M1): coachTools is the only coach module that
  // emits audit rows directly (via auditDetail → ctx.memory.auditLog.insert).
  // Audit rows MUST contain hash+length only — never raw nudge/research/idea
  // text. coachMemory.ts does NOT emit audit rows (it writes to keyed-memory
  // entries; the audit emission lives in coachTools.ts via the hashAndLen()
  // helper) so it is intentionally not scanned here.
  'src/coach/coachTools.ts',
  // v1.19.0 ADR 019 F3: calendar sync module + coach override tool added to scan.
  // Both emit audit rows — calendar sync via SyncDeps.audit* callbacks;
  // coachOverrideTool via ctx.memory.auditLog.insert. Raw event text MUST NOT
  // appear in audit detail rows.
  'src/calendar/sync.ts',
  'src/coach/coachOverrideTool.ts',
];

describe('Gate H — audit privacy field-name scan (W3)', () => {
  it('audit emission contains no raw field values in shared modules', () => {
    const violations: string[] = [];

    for (const relPath of FILES) {
      const fullPath = path.join(PROJECT_ROOT, relPath);
      expect(fs.existsSync(fullPath), `${relPath} must exist`).toBe(true);

      const src = fs.readFileSync(fullPath, 'utf-8');
      const lines = src.split('\n');

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? '';
        // Skip lines with explicit allow-list comment
        if (line.includes('// ALLOWED:')) continue;

        // Forbidden pattern: `value:`, `content:`, `title:`, `body:` as object
        // property assignments in object literals (matches `  value: ` etc.)
        const forbidden = /\b(value|content|title|body):\s/g;
        let match: RegExpExecArray | null;
        while ((match = forbidden.exec(line)) !== null) {
          violations.push(`${relPath}:${i + 1}: "${match[0].trim()}" — raw field value in audit module (W3)`);
        }
      }
    }

    if (violations.length > 0) {
      // Format the error clearly so the developer knows what to fix
      const msg = [
        'ADR 017 Gate H (W3): audit privacy violation — raw field values in audit shared modules.',
        'To suppress a legitimate use, add `// ALLOWED: <reason>` to the same line.',
        '',
        ...violations,
      ].join('\n');
      expect(violations.length, msg).toBe(0);
    }
  });
});
