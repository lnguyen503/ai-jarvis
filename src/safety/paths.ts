import fs from 'fs';
import path from 'path';
import { minimatch } from 'minimatch';
import type { AppConfig } from '../config/index.js';

/**
 * Windows-safe path sandbox (ARCH §9, C1).
 *
 * Algorithm (in order, no shortcuts):
 * 1. Reject empty, NUL-containing, UNC (\\server\), device (\\.\, \\?\) paths
 * 2. path.resolve() to absolutize relative inputs
 * 3. fs.realpathSync.native() — canonicalizes 8.3 short names, junctions, symlinks.
 *    For write targets that don't exist yet: realpath the deepest existing ancestor, append remainder.
 * 4. Lowercase + NFC normalize on Windows
 * 5. allowedPaths were already realpath+lowercase+NFC'd at config-load time
 * 6. Accept iff resolved === allowedRoot OR resolved.startsWith(allowedRoot + path.sep)
 *    (trailing sep is MANDATORY to prevent D:\ai-jarvis-evil matching D:\ai-jarvis)
 */

/** Canonicalize a path string: realpath (or ancestor-realpath), lowercase, NFC */
export function canonicalize(inputPath: string): string {
  // path.resolve handles absolutization
  const resolved = path.resolve(inputPath);

  try {
    // Try full realpath first (works for existing paths)
    return fs.realpathSync.native(resolved).toLowerCase().normalize('NFC');
  } catch {
    // Path doesn't exist — resolve deepest existing ancestor, append remainder
    const parts = resolved.split(path.sep);
    let existingPath = parts[0] ?? '';
    let firstMissing = 1;

    for (let i = 1; i < parts.length; i++) {
      const candidate = parts.slice(0, i + 1).join(path.sep);
      if (fs.existsSync(candidate)) {
        existingPath = candidate;
        firstMissing = i + 1;
      } else {
        break;
      }
    }

    const realExisting = fs.existsSync(existingPath)
      ? fs.realpathSync.native(existingPath)
      : existingPath;

    const remainder = parts.slice(firstMissing).join(path.sep);
    const full = remainder ? path.join(realExisting, remainder) : realExisting;
    return full.toLowerCase().normalize('NFC');
  }
}

/**
 * Built-in write denylist — paths that can never be overwritten by the agent,
 * even if they reside inside an allowed root.
 * Mirrors the readDenyGlobs defaults plus explicit write-critical paths.
 *
 * V-14 fix: extend to cover self-modification of config, source, and ecosystem files.
 * V-06 fix: extend .env variants.
 */
/**
 * Write-deny globs that ALWAYS apply, regardless of whether the target is
 * inside a workspace or not. These protect secrets, credentials, databases,
 * and log files — a developer has no legitimate reason to write any of
 * these, anywhere.
 */
export const ALWAYS_DENY_WRITE_GLOBS = [
  // --- Secrets and credentials ---
  '.env',
  '.env.*',
  '*.env',
  '**/.env*',
  '**/*.env',
  '.env-backup',
  '*.env-backup',
  '.env.*.local',
  'env.local',
  '**/id_rsa',
  '**/id_rsa.pub',
  '**/*.pem',
  '**/*.key',
  '**/credentials*.json',
  '**/service-account*.json',
  '**/.aws/**',
  '**/.ssh/**',
  // --- Database and log files ---
  '**/*.db',
  '**/*.sqlite',
  '**/*.sqlite3',
];

/**
 * Write-deny globs that protect the factory's OWN install (self-modification
 * guard). These are disabled INSIDE the workspaces tree — a developer in
 * their group workspace can create `config/`, `src/`, `tests/`, `package.json`,
 * etc. as part of a normal project they're building. They just can't reach
 * the FACTORY's config/src/tests/package.json/etc. because:
 *   (a) only the admin has the factory in their allowedPaths, and
 *   (b) even the admin can't write to these paths when they're under the
 *       factory root thanks to the anchored-match behavior below.
 */
export const FACTORY_SELF_DENY_GLOBS = [
  // V-14: self-modification protection (factory-internal only)
  'config/**',
  'src/**',
  'tests/**',
  'dist/**',
  '.claude/**',
  'ecosystem.config.*',
  'package.json',
  'package-lock.json',
  'tsconfig*.json',
  'vitest.config.*',
  '.eslintrc*',
  '.eslintignore',
  '.github/**',
  // Legacy top-level dirs that aren't strictly factory code but agents
  // should still not write to inside the factory root.
  'data/**',
  'logs/**',
  // Dotfiles and dotfolders
  '**/.git/**',
  '**/.config/**',
  // Repo documentation (lesser risk, still protected)
  '**/CHANGELOG.md',
  '**/README.md',
  '**/PROGRESS.md',
  '**/TODO.md',
];

/**
 * Legacy name preserved so downstream consumers that imported the old
 * union glob list still compile. This union IS the old behavior.
 */
export const BUILT_IN_WRITE_DENY_GLOBS = [
  ...ALWAYS_DENY_WRITE_GLOBS,
  ...FACTORY_SELF_DENY_GLOBS,
];

export class PathSandbox {
  private readonly canonicalAllowedRoots: string[];
  private readonly readDenyGlobs: string[];
  private readonly alwaysDenyWriteGlobs: string[];
  private readonly factorySelfDenyWriteGlobs: string[];
  private readonly canonicalWorkspacesRoot: string | null;

  constructor(cfg: AppConfig) {
    this.canonicalAllowedRoots = cfg.filesystem.allowedPaths
      .filter((p) => {
        try {
          return fs.existsSync(p);
        } catch {
          return false;
        }
      })
      .map((p) => canonicalize(p));
    this.readDenyGlobs = cfg.filesystem.readDenyGlobs;
    // v1.7.5: split the write deny globs into two lists so we can apply the
    // workspace carveout — factory-self denies only match INSIDE the factory
    // root, not inside the workspaces tree where developers build real apps.
    this.alwaysDenyWriteGlobs = [...ALWAYS_DENY_WRITE_GLOBS];
    this.factorySelfDenyWriteGlobs = [...FACTORY_SELF_DENY_GLOBS];
    // Canonical workspaces root, if workspaces are enabled. Used to detect
    // paths inside the workspaces tree and skip the factory-self denies.
    this.canonicalWorkspacesRoot = cfg.workspaces?.enabled
      ? (() => {
          try {
            // realpath may fail if workspaces root doesn't exist yet — fall
            // back to a plain lowercase+NFC normalization so the prefix
            // comparison still works.
            return canonicalize(cfg.workspaces.root);
          } catch {
            return cfg.workspaces.root.toLowerCase().normalize('NFC');
          }
        })()
      : null;
  }

  /** True if the given (already-canonicalized) path is inside the workspaces tree. */
  private isInsideWorkspaces(canonicalPath: string): boolean {
    const root = this.canonicalWorkspacesRoot;
    if (!root) return false;
    return (
      canonicalPath === root || canonicalPath.startsWith(root + path.sep)
    );
  }

  /**
   * Check if the given path is within an allowed root.
   * Returns false for symlink escapes, 8.3 short names, UNC paths, junctions, etc.
   */
  isPathAllowed(absPath: string): boolean {
    return this.isPathAllowedInRoots(absPath, this.canonicalAllowedRoots);
  }

  /**
   * v1.7.5 — session-scoped path check. Same algorithm as isPathAllowed() but
   * uses a caller-supplied root list instead of the config-wide allowed roots.
   * Used by per-chat workspace isolation so a developer in one group sees
   * only that group's workspace.
   *
   * The roots are expected to be already-canonicalized (realpath+lowercase+NFC)
   * OR raw directories that this method will canonicalize on the fly.
   */
  isPathAllowedInRoots(absPath: string, roots: readonly string[]): boolean {
    if (!absPath || absPath.includes('\0')) {
      return false;
    }
    if (absPath.startsWith('\\\\')) {
      return false;
    }

    let canonical: string;
    try {
      canonical = canonicalize(absPath);
    } catch {
      return false;
    }

    for (const rawRoot of roots) {
      let canonicalRoot: string;
      try {
        canonicalRoot = canonicalize(rawRoot);
      } catch {
        continue;
      }
      if (canonical === canonicalRoot) return true;
      if (canonical.startsWith(canonicalRoot + path.sep)) return true;
    }
    return false;
  }

  /**
   * v1.7.5 — session-scoped read check. Enforces the caller's root list
   * in place of the config-wide roots, then applies the same deny globs.
   */
  isReadAllowedInRoots(absPath: string, roots: readonly string[]): boolean {
    if (!this.isPathAllowedInRoots(absPath, roots)) return false;
    return this._passesReadDenyGlobs(absPath);
  }

  /**
   * v1.7.5 — session-scoped write check.
   */
  isWriteAllowedInRoots(absPath: string, roots: readonly string[]): boolean {
    if (!this.isPathAllowedInRoots(absPath, roots)) return false;
    return this._passesWriteDenyGlobs(absPath);
  }

  /**
   * Check if the given path is allowed for READ operations.
   * isPathAllowed must pass first, then denylist globs are checked.
   */
  isReadAllowed(absPath: string): boolean {
    if (!this.isPathAllowed(absPath)) return false;
    return this._passesReadDenyGlobs(absPath);
  }

  /** Shared deny-glob check used by both scoped and non-scoped read variants. */
  private _passesReadDenyGlobs(absPath: string): boolean {
    const basename = path.basename(absPath);
    const normalizedSlash = absPath.replace(/\\/g, '/');

    for (const glob of this.readDenyGlobs) {
      if (minimatch(basename, glob, { dot: true, nocase: true })) return false;
      if (minimatch(normalizedSlash, `**/${glob}`, { dot: true, nocase: true })) return false;
      const segments = normalizedSlash.split('/');
      for (let i = 0; i < segments.length; i++) {
        const suffix = segments.slice(i).join('/');
        if (minimatch(suffix, glob, { dot: true, nocase: true })) return false;
      }
    }
    return true;
  }

  /**
   * Check if the given path is allowed for WRITE operations.
   * isPathAllowed must pass first, then write-denylist globs are checked.
   * This prevents the agent from overwriting .env, *.db, logs/*, data/*, etc.
   */
  isWriteAllowed(absPath: string): boolean {
    if (!this.isPathAllowed(absPath)) return false;
    return this._passesWriteDenyGlobs(absPath);
  }

  private _passesWriteDenyGlobs(absPath: string): boolean {
    // v1.7.5: two-tier deny list. "Always" denies (secrets, databases)
    // apply everywhere. "Factory-self" denies apply only OUTSIDE the
    // workspaces tree so developers can build real projects inside their
    // group workspace without tripping config/**, src/**, etc.
    let canonical: string;
    try {
      canonical = canonicalize(absPath);
    } catch {
      canonical = absPath.toLowerCase().normalize('NFC');
    }
    const insideWorkspaces = this.isInsideWorkspaces(canonical);

    const basename = path.basename(absPath);
    const normalizedSlash = absPath.replace(/\\/g, '/');

    const matchAny = (glob: string): boolean => {
      if (minimatch(basename, glob, { dot: true, nocase: true })) return true;
      if (minimatch(normalizedSlash, `**/${glob}`, { dot: true, nocase: true })) return true;
      const segments = normalizedSlash.split('/');
      for (let i = 0; i < segments.length; i++) {
        const suffix = segments.slice(i).join('/');
        if (minimatch(suffix, glob, { dot: true, nocase: true })) return true;
      }
      return false;
    };

    for (const glob of this.alwaysDenyWriteGlobs) {
      if (matchAny(glob)) return false;
    }
    if (!insideWorkspaces) {
      for (const glob of this.factorySelfDenyWriteGlobs) {
        if (matchAny(glob)) return false;
      }
    }
    return true;
  }

  /** Filter a list of directory entries to exclude denied paths */
  filterDeniedEntries(dirPath: string, entries: string[]): string[] {
    return entries.filter((entry) => {
      const fullPath = path.join(dirPath, entry);
      return this.isReadAllowed(fullPath);
    });
  }
}
