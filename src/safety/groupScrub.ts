/**
 * Group-scoped scrubber (v1.3).
 *
 * Wraps the existing secret scrubber (`scrub()`) and additionally redacts:
 *  - Windows filesystem paths under config.filesystem.allowedPaths
 *  - os.hostname()
 *  - os.userInfo().username
 *
 * Does NOT modify existing `scrub()`. Side-effect free.
 */

import os from 'os';
import { scrub } from './scrubber.js';
import type { AppConfig } from '../config/index.js';

/**
 * Scrub text for group chat delivery.
 * Applies the base secret scrubber then additionally redacts allowed paths,
 * hostname, and username.
 *
 * @param text   Raw text (e.g. agent reply before sending to Telegram)
 * @param config App config (for filesystem.allowedPaths)
 * @returns      Scrubbed text safe for group chat
 */
export function scrubForGroup(text: string, config: AppConfig): string {
  // Step 1: base secret scrub
  let result = scrub(text);

  // Step 2: redact configured allowed paths (longest-first to avoid partial matches)
  const sortedPaths = [...config.filesystem.allowedPaths].sort((a, b) => b.length - a.length);
  for (const allowedPath of sortedPaths) {
    // Case-insensitive replacement (Windows paths are case-insensitive)
    // Escape special regex characters in the path string
    const escaped = allowedPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    result = result.replace(new RegExp(escaped, 'gi'), '<path>');
  }

  // Step 3: redact hostname
  try {
    const hostname = os.hostname();
    if (hostname) {
      const escapedHost = hostname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      result = result.replace(new RegExp(escapedHost, 'gi'), '<hostname>');
    }
  } catch {
    // os.hostname() shouldn't throw, but be defensive
  }

  // Step 4: redact username
  try {
    const username = os.userInfo().username;
    if (username) {
      const escapedUser = username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      result = result.replace(new RegExp(escapedUser, 'gi'), '<username>');
    }
  } catch {
    // os.userInfo() may throw in some environments
  }

  return result;
}
