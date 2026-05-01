import type { AppConfig, BlockedCommand } from '../config/schema.js';

export interface ClassifyResult {
  destructive: boolean;
  hardReject: boolean; // -EncodedCommand / iex when allowEncodedCommands=false
  matchedRule?: string;
  tokens: string[]; // post-tokenization sub-commands inspected
}

/**
 * Shape-based destructive command classification (ARCH §9, C2).
 * Runs on the final resolved command string — not on Claude's description.
 *
 * Algorithm:
 * 1. Normalize: strip backtick continuations, collapse whitespace, NFC+casefold
 * 2. Tokenize on chain operators: &&, ;, |, ||, backtick-subexpressions, $(...), @(...), &(...)
 * 3. Shape-based classification on EACH token
 * 4. Hard-reject check: -EncodedCommand, iex, Invoke-Expression forms
 */

// Patterns for hard-reject (obfuscation / indirection / network-fetch-then-exec)
// V-15 fix: extended with network-fetch downloader patterns
const HARD_REJECT_PATTERNS = [
  /-encodedcommand\b/i,
  /-enc\s/i,
  /invoke-expression\b/i,
  /\biex\b/i,
  /\biex\s*\(/i,
  /iex\s*\(/i,
  // Invoke via & operator with gcm / Get-Command
  /&\s*\(\s*gcm\b/i,
  /&\s*\(\s*get-command\b/i,
  // DownloadString / DownloadFile
  /\.\s*downloadstring\s*\(/i,
  /\.\s*downloadfile\s*\(/i,
  // --- V-15: Network-fetch-to-file patterns ---
  // Invoke-WebRequest / iwr with -OutFile
  /invoke-webrequest\s+.*-outfile\b/i,
  /\biwr\s+.*-outfile\b/i,
  // Invoke-RestMethod with -OutFile
  /invoke-restmethod\s+.*-outfile\b/i,
  // curl with -O or -o (download to file)
  /\bcurl\b.*\s-[Oo]\b/,
  /\bcurl\b.*\s--output\b/i,
  // wget (download to file)
  /\bwget\b/i,
  // bitsadmin (Windows file transfer)
  /\bbitsadmin\b/i,
  // Start-BitsTransfer
  /\bstart-bitstransfer\b/i,
  // certutil -urlcache (downloads files)
  /\bcertutil\b.*-urlcache\b/i,
  // Add-Type / Reflection.Assembly.Load (code loading)
  /\badd-type\b/i,
  /\breflection\.assembly\b/i,
  // Broader reflection / dynamic type loading — defense in depth
  /\[reflection\.[a-z]+\]/i,
  /\[type\]::gettype\b/i,
  // WMI execution (Invoke-WmiMethod, Get-WmiObject + Create)
  /\binvoke-wmimethod\b/i,
  /\bget-wmiobject\b[^\r\n]*-name\s+["']?win32_process\b/i,
  // CIM equivalents (newer PS alternative to WMI)
  /\binvoke-cimmethod\b/i,
  /\bnew-ciminstance\b/i,
  // --- Mass-kill of critical runtime processes by name ---
  // Stop-Process -Name <critical> (without -Id) kills every matching process on the host,
  // including the agent itself, the user's shells, and system services. Hard-reject
  // these names outright — there is no safe use case for them from the agent.
  /(?:\bstop-process|\\stop-process\.exe)\b[^\r\n]*\s-name\s+["']?(node|pwsh|powershell|cmd|conhost|claude|explorer|code|svchost|winlogon|csrss|lsass|services|dwm|system|wininit|smss)(\.exe)?\b/i,
  // taskkill /IM <critical>.exe — cmd equivalent of the above. Matches both
  // bare "taskkill" and full-path "C:\Windows\System32\taskkill.exe" to close
  // a LOW-severity bypass where a qualified path dodged the word-boundary.
  /(?:\btaskkill|[\\/]taskkill\.exe)\b[^\r\n]*\s\/im\s+["']?(node|pwsh|powershell|cmd|conhost|claude|explorer|code|svchost|winlogon|csrss|lsass|services|dwm|system|wininit|smss)(\.exe)?\b/i,
];

// Shape-based destructive patterns (any match = destructive)
const DESTRUCTIVE_PATTERNS = [
  // Remove-Item and aliases
  /\bremove-item\b/i,
  /\brm\b(?!dir)/i, // rm but not rmdir (handled separately)
  /\bri\b/i, // Remove-Item alias
  /\bdel\b/i,
  /\berase\b/i,
  // rmdir variants
  /\brmdir\b/i,
  /\brd\s+\/s\b/i,
  // Windows rd
  /\brd\b.*\/s\b/i,
  // Format commands
  /\bformat-volume\b/i,
  /\bformat\s+[a-z]:/i,
  /\bclear-disk\b/i,
  /\bdiskpart\b/i,
  // Registry
  /\breg\s+delete\b/i,
  // Execution policy (security-altering)
  /\bset-executionpolicy\b/i,
  // Shutdown / restart
  /\bstop-computer\b/i,
  /\brestart-computer\b/i,
  /\bshutdown\b.*\/[srfta]/i,
  /\bshutdown\b/i,
  // takeown / icacls permission changes
  /\btakeown\b/i,
  /\bicacls\b.*\/reset\b/i,
  // Unix-style rm
  /\brm\s+-r/i,
  /\brm\s+--recursive/i,
  // Process termination — require explicit confirmation. Targeted kills by -Id/PID
  // are often legitimate, but the agent should never kill silently.
  /(?:\bstop-process|[\\/]stop-process\.exe)\b/i,
  /(?:\btaskkill|[\\/]taskkill\.exe)\b/i,
  /\bkill\s+-9\b/i,
  /\bpkill\b/i,
];

/**
 * Normalize a command string for classification:
 * - Strip PowerShell backtick line continuations
 * - Expand $env:NAME / ${env:NAME} literals for pattern matching
 * - Unicode NFC + casefold
 */
export function normalizeCommand(cmd: string): string {
  let s = cmd;

  // Strip backtick line continuations (backtick + optional whitespace + newline)
  s = s.replace(/`\s*\r?\n/g, ' ');

  // Strip backtick escapes used within a token (e.g., Remove-Item `-Recurse `-Force)
  s = s.replace(/`([^\n])/g, '$1');

  // Expand $env:VAR and ${env:VAR} to literal placeholder for matching
  s = s.replace(/\$\{?env:([A-Za-z0-9_]+)\}?/gi, 'ENVVAR_$1');

  // Collapse whitespace
  s = s.replace(/\s+/g, ' ').trim();

  // NFC + casefold (lowercase)
  return s.normalize('NFC').toLowerCase();
}

/**
 * Tokenize a (normalized, lowercased) command on shell chain operators.
 * Returns individual sub-commands to inspect.
 */
export function tokenizeCommand(normalized: string): string[] {
  // Split on &&, ||, ;, |, and $(...)/&(...) subexpression forms
  // We split greedily; each token is then checked independently
  const tokens = normalized
    .split(/&&|\|\|?|;|\$\(|@\(|&\(/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  return tokens;
}

/**
 * Check a single (already normalized+lowercased) token for destructive patterns.
 */
function isTokenDestructive(token: string): boolean {
  return DESTRUCTIVE_PATTERNS.some((re) => re.test(token));
}

/**
 * Check for hard-reject patterns (obfuscation/indirection).
 * These are rejected regardless of allowEncodedCommands config
 * unless allowEncodedCommands is true.
 */
function hasHardRejectPattern(token: string): boolean {
  return HARD_REJECT_PATTERNS.some((re) => re.test(token));
}

/**
 * Whole-pipeline hard-reject patterns. Checked against the full normalized
 * command string (not per-token) so that `|` / `;` / `ForEach-Object { ... }`
 * cannot be used to launder a mass-kill of critical runtime processes.
 *
 * Regression: agent issued `Get-Process -Name node | ForEach-Object { Stop-Process -Id $_.Id -Force }`
 * — tokenization split on `|`, each half looked innocent, and only a
 * generic destructive-confirm prompted. Confirmation from the user then
 * killed every node.exe on the host (the agent itself included).
 */
const CRITICAL_PROC = '(node|pwsh|powershell|cmd|conhost|claude|explorer|code|svchost|winlogon|csrss|lsass|services|dwm|system|wininit|smss)';

const PIPELINE_HARD_REJECT_PATTERNS: RegExp[] = [
  // Get-Process -Name <critical>  ...|... Stop-Process
  new RegExp(
    `\\bget-process\\b[^\\r\\n]*\\b(?:-name\\s+)?["']?${CRITICAL_PROC}(?:\\.exe)?\\b[^\\r\\n]*\\|[^\\r\\n]*\\bstop-process\\b`,
    'i',
  ),
  // ps <critical> | ... kill
  new RegExp(
    `\\bps\\s+["']?${CRITICAL_PROC}(?:\\.exe)?\\b[^\\r\\n]*\\|[^\\r\\n]*\\b(stop-process|kill)\\b`,
    'i',
  ),
  // ForEach-Object { Stop-Process ... } — the batch-kill idiom. Any upstream
  // enumeration combined with this block is mass-kill by construction.
  /\bforeach-object\b[^{]*\{[^}]*\bstop-process\b[^}]*\}/i,
  /\b%\s*\{[^}]*\bstop-process\b[^}]*\}/i,
];

function hasPipelineHardReject(normalized: string): string | null {
  for (const re of PIPELINE_HARD_REJECT_PATTERNS) {
    if (re.test(normalized)) return re.source;
  }
  return null;
}

export class CommandClassifier {
  private readonly configBlockedCommands: BlockedCommand[];
  private readonly allowEncodedCommands: boolean;

  constructor(cfg: AppConfig) {
    this.configBlockedCommands = cfg.safety.blockedCommands;
    this.allowEncodedCommands = cfg.safety.allowEncodedCommands;
  }

  classifyCommand(cmd: string, _shell: 'powershell' | 'cmd' | 'none'): ClassifyResult {
    const normalized = normalizeCommand(cmd);
    const tokens = tokenizeCommand(normalized);

    let destructive = false;
    let hardReject = false;
    let matchedRule: string | undefined;

    // Whole-pipeline hard-reject: catches mass-kill idioms that tokenization
    // would hide (e.g. `Get-Process -Name node | ForEach-Object { Stop-Process ... }`).
    if (!this.allowEncodedCommands) {
      const pipelineMatch = hasPipelineHardReject(normalized);
      if (pipelineMatch !== null) {
        hardReject = true;
        destructive = true;
        matchedRule = `hard-reject: pipeline mass-kill pattern`;
      }
    }

    // Self-kill hard-reject: refuse any kill targeting ai-jarvis's own PID
    // BEFORE prompting the user. Port 7878 (the health endpoint) is ai-jarvis
    // itself, so `netstat | grep 7878` → `Stop-Process -Id <that>` = suicide.
    // The user can't be expected to recognize their agent's PID in a confirm.
    const ownPid = process.pid;
    const selfKillRe = new RegExp(
      `\\b(stop-process|taskkill|kill)\\b[^\\r\\n]*\\b(?:-id|/pid|-pid)?\\s*["']?${ownPid}\\b`,
      'i',
    );
    if (selfKillRe.test(normalized)) {
      hardReject = true;
      destructive = true;
      matchedRule = matchedRule ?? `hard-reject: targets ai-jarvis own pid ${ownPid}`;
    }

    for (const token of tokens) {
      // Hard-reject check (obfuscation/indirection)
      if (!this.allowEncodedCommands && hasHardRejectPattern(token)) {
        hardReject = true;
        destructive = true;
        matchedRule = matchedRule ?? `hard-reject: obfuscation pattern in "${token}"`;
      }

      // Shape-based destructive classification
      if (isTokenDestructive(token)) {
        destructive = true;
        matchedRule = matchedRule ?? `destructive-shape in "${token}"`;
      }

      // Config-supplied blocked commands
      for (const rule of this.configBlockedCommands) {
        let matches = false;
        if (rule.kind === 'regex') {
          matches = new RegExp(rule.pattern, 'i').test(token);
        } else {
          matches = token.includes(rule.pattern.toLowerCase());
        }

        if (matches) {
          if (rule.action === 'block') {
            hardReject = true;
          }
          destructive = true;
          matchedRule = matchedRule ?? `config-rule: ${rule.pattern}`;
          break;
        }
      }
    }

    return { destructive, hardReject, matchedRule, tokens };
  }
}
