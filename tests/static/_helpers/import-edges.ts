/**
 * Shared helper for module-edge static tests.
 *
 * BINDING: ADR 020 D16 + 020-revisions W2 + CLAUDE.md v1.18.0 invariant 1
 * (one-way edge organize → coach) and v1.20.0 invariant 1 (multi-coach
 * profile module isolation).
 *
 * v1.18.0 introduced `coach-no-reverse-import.test.ts` (organize → coach).
 * v1.19.0 introduced `calendar-no-reverse-import.test.ts` (calendar leaf module).
 * v1.20.0 introduces 3 new module-edge tests for the multi-coach + event-trigger
 * surface. To avoid duplication of file-walking + import-extraction logic,
 * those tests share this helper.
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * Recursively list all `.ts` files under `dir` (excluding `.d.ts` and
 * `__tests__` subdirectories). Returns absolute paths.
 */
export function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Extract every `from '...'` or `from "..."` specifier from a TypeScript file.
 * Returns the raw module specifiers (no resolution). Comments are stripped.
 */
export function extractImportSpecifiers(filePath: string): string[] {
  const source = fs.readFileSync(filePath, 'utf-8');
  // Strip block + line comments to avoid matching specifiers inside JSDoc.
  const noBlockComments = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const noLineComments = noBlockComments
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
  const importRegex = /\bfrom\s+['"]([^'"]+)['"]/g;
  const specs: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = importRegex.exec(noLineComments)) !== null) {
    specs.push(match[1]!);
  }
  return specs;
}

/**
 * Assert that no file under `sourceRoot` imports a specifier matching
 * `forbiddenPattern` (substring match against the module specifier).
 *
 * `allowedSuffixes` is a list of specifier suffixes that are explicitly
 * allowed (e.g. `'/coach/intensityTypes.js'` is a leaf type module that
 * organize/ may import; the rest of `coach/` is forbidden).
 *
 * Returns a list of `{ file, specifier }` violations. If empty, the edge
 * is clean.
 */
export function findForbiddenImports(
  sourceRoot: string,
  forbiddenPattern: RegExp,
  allowedSuffixes: string[] = [],
): Array<{ file: string; specifier: string }> {
  const violations: Array<{ file: string; specifier: string }> = [];
  for (const file of listTsFiles(sourceRoot)) {
    const specs = extractImportSpecifiers(file);
    for (const spec of specs) {
      if (!forbiddenPattern.test(spec)) continue;
      // Check allowed suffix list — if any matches, skip.
      const isAllowed = allowedSuffixes.some((suffix) => spec.endsWith(suffix));
      if (isAllowed) continue;
      violations.push({ file: path.relative(process.cwd(), file), specifier: spec });
    }
  }
  return violations;
}
