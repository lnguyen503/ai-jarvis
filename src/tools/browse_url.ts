/**
 * Tool: browse_url
 *
 * Load a web page in a headless Chromium browser, extract the main article
 * text (Readability), and return it to the agent. Optional screenshot saved
 * to the chat's workspace.
 *
 * Admin-only. A fresh browser context is created per call and discarded on
 * finish — there is no cookie jar, no localStorage, and no way for the
 * agent to carry login state across calls. This is the "no banking / no
 * social media" guarantee the user asked for, enforced at the architecture
 * level rather than by policy.
 *
 * Pipeline per call:
 *   1. SSRF guard on the URL (reject non-http/https, private IPs, denyHosts)
 *   2. Launch (or reuse) the shared browser
 *   3. Fresh incognito context + page
 *   4. goto() with pageTimeoutMs (default 15s)
 *   5. Extract via Readability; fall back to body text
 *   6. Optional screenshot → workspace
 *   7. Close context (everything is discarded)
 *
 * The agent is expected to chain this with web_search (Tavily): Tavily
 * returns links, browse_url reads the promising ones, the agent synthesizes.
 */

import { z } from 'zod';
import path from 'path';
import type { Tool, ToolContext, ToolResult, ToolDeps } from './types.js';
import { getBrowser, newContext } from '../browser/launcher.js';
import { extractReadable } from '../browser/extractor.js';
import { assertUrlIsSafe, SsrfBlockedError } from '../browser/ssrfGuard.js';
import { ensureWorkspace } from '../safety/workspaces.js';

const parameters = z.object({
  url: z.string().min(1).describe('Absolute URL to load. Must be http or https.'),
  waitForMs: z
    .number()
    .int()
    .min(0)
    .max(15_000)
    .default(2000)
    .describe(
      'After DOMContentLoaded, wait this many extra ms for JS to hydrate. ' +
        'Increase for heavy SPAs (e.g. 5000); 0 = take the HTML as-is.',
    ),
  screenshot: z
    .boolean()
    .default(false)
    .describe('Also save a full-page PNG screenshot to the chat workspace.'),
  includeRawHtml: z
    .boolean()
    .default(false)
    .describe(
      'Return raw HTML alongside the extracted text (debug / structured scrapes). ' +
        'Costs tokens — only set when the extracted text is unusable.',
    ),
});

type BrowseUrlInput = z.infer<typeof parameters>;

export function buildBrowseUrlTool(deps: ToolDeps): Tool<BrowseUrlInput> {
  return {
    name: 'browse_url',
    description:
      'Load a web page in a headless browser and return its extracted ' +
      'article text. Combine with web_search (Tavily) for autonomous ' +
      'research: search for links, then call browse_url on the promising ' +
      'ones. Each call uses a fresh incognito context — no login state, no ' +
      'cookies, no tracking. Use this when you need the actual content of ' +
      'a page, not just the Tavily snippet.',
    parameters,
    adminOnly: true,

    async execute(input: BrowseUrlInput, ctx: ToolContext): Promise<ToolResult> {
      const log = ctx.logger.child({ component: 'tools.browse_url' });
      const browserCfg = ctx.config.browser;

      if (!browserCfg?.enabled) {
        return {
          ok: false,
          output: 'Browser tool is disabled. Enable via config.browser.enabled.',
          error: { code: 'BROWSER_DISABLED', message: 'config.browser.enabled=false' },
        };
      }

      // --- SSRF guard --------------------------------------------------------
      let safeUrl: string;
      try {
        safeUrl = await assertUrlIsSafe(input.url, { denyHosts: browserCfg.denyHosts });
      } catch (err) {
        if (err instanceof SsrfBlockedError) {
          log.warn({ url: input.url, reason: err.reason }, 'URL rejected by SSRF guard');
          return {
            ok: false,
            output: `Can't load that URL: ${err.message}`,
            error: { code: 'SSRF_BLOCKED', message: err.reason },
          };
        }
        throw err;
      }

      // --- Browser + context -------------------------------------------------
      let browser;
      try {
        browser = await getBrowser({
          headless: browserCfg.headless,
          userAgent: browserCfg.userAgent,
          logger: deps.logger,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error({ err: msg }, 'Failed to launch Chromium');
        return {
          ok: false,
          output:
            `Couldn't launch Chromium: ${msg}. ` +
            `If this is the first run, try: npx playwright install chromium`,
          error: { code: 'BROWSER_LAUNCH_FAILED', message: msg },
        };
      }

      const context = await newContext(browser, { userAgent: browserCfg.userAgent });
      const page = await context.newPage();

      // Block large binary downloads to stay within the response-body cap.
      const MAX_BODY_BYTES = 5 * 1024 * 1024; // 5 MB
      page.route('**/*', async (route) => {
        const req = route.request();
        const resourceType = req.resourceType();
        // Main document + scripts + xhr need to run for hydration. Block the
        // heavy media types that never contribute to extractable text.
        if (resourceType === 'media' || resourceType === 'font') {
          return route.abort();
        }
        return route.continue();
      });

      try {
        const started = Date.now();
        const response = await page.goto(safeUrl, {
          timeout: browserCfg.pageTimeoutMs,
          waitUntil: 'domcontentloaded',
        });
        if (!response) {
          return {
            ok: false,
            output: `No response from ${safeUrl}`,
            error: { code: 'BROWSE_NO_RESPONSE', message: 'page.goto returned null' },
          };
        }
        const status = response.status();
        if (status >= 400) {
          return {
            ok: false,
            output: `HTTP ${status} from ${safeUrl}`,
            error: { code: 'HTTP_ERROR', message: `status=${status}` },
          };
        }

        // Quick body-size check via content-length (not authoritative — actual
        // rendered HTML may be bigger after JS hydration; the extractor cap
        // is the real safety net).
        const contentLengthHeader = response.headers()['content-length'];
        if (contentLengthHeader) {
          const n = parseInt(contentLengthHeader, 10);
          if (Number.isFinite(n) && n > MAX_BODY_BYTES) {
            return {
              ok: false,
              output: `Response too large (${n} bytes > ${MAX_BODY_BYTES} cap).`,
              error: { code: 'BODY_TOO_LARGE', message: `content-length=${n}` },
            };
          }
        }

        if (input.waitForMs > 0) {
          await page.waitForTimeout(input.waitForMs);
        }

        const finalUrl = page.url();
        const html = await page.content();

        const extracted = extractReadable(html, {
          url: finalUrl,
          maxChars: browserCfg.maxContentChars,
        });

        // --- Optional screenshot ------------------------------------------
        let screenshotPath: string | undefined;
        if (input.screenshot) {
          const workspace = ensureWorkspace(ctx.chatId, ctx.config);
          if (!workspace) {
            log.warn(
              { chatId: ctx.chatId },
              'screenshot requested but workspace is disabled — skipping',
            );
          } else {
            const filename = `browse-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`;
            screenshotPath = path.join(workspace, filename);
            try {
              await page.screenshot({ path: screenshotPath, fullPage: true });
            } catch (err) {
              log.warn(
                { err: err instanceof Error ? err.message : String(err) },
                'Screenshot failed',
              );
              screenshotPath = undefined;
            }
          }
        }

        const elapsedMs = Date.now() - started;

        const lines: string[] = [];
        lines.push(`# ${extracted.title}`);
        if (extracted.siteName) lines.push(`*${extracted.siteName}*`);
        lines.push(`URL: ${finalUrl}`);
        lines.push(
          `Extracted via ${extracted.kind} · ${extracted.wordCount} words` +
            (extracted.truncated ? ' (truncated)' : '') +
            ` · ${elapsedMs}ms`,
        );
        if (screenshotPath) lines.push(`Screenshot: ${screenshotPath}`);
        lines.push('');
        if (extracted.excerpt) {
          lines.push(`**Excerpt:** ${extracted.excerpt}`);
          lines.push('');
        }
        lines.push(extracted.text || '(no extractable text)');

        if (input.includeRawHtml) {
          lines.push('', '---', '## Raw HTML', '```html', html.slice(0, 10_000), '```');
        }

        log.info(
          { url: safeUrl, finalUrl, status, wordCount: extracted.wordCount, elapsedMs, kind: extracted.kind },
          'Page browsed successfully',
        );

        return {
          ok: true,
          output: lines.join('\n'),
          data: {
            url: finalUrl,
            title: extracted.title,
            wordCount: extracted.wordCount,
            kind: extracted.kind,
            truncated: extracted.truncated,
            screenshotPath,
          },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error({ url: safeUrl, err: msg }, 'browse_url failed');
        // Categorize timeouts vs generic errors for clearer agent output.
        if (/timeout/i.test(msg)) {
          return {
            ok: false,
            output: `Page load timed out after ${browserCfg.pageTimeoutMs}ms: ${safeUrl}`,
            error: { code: 'BROWSE_TIMEOUT', message: msg },
          };
        }
        return {
          ok: false,
          output: `Failed to load ${safeUrl}: ${msg}`,
          error: { code: 'BROWSE_FAILED', message: msg },
        };
      } finally {
        // Close context aggressively — this is the "no persistent state" guarantee.
        try {
          await context.close();
        } catch {
          // ignore — context may already be closed on error paths
        }
      }
    },
  };
}

/** Exported for the SIGTERM handler path so main.ts can close the singleton. */
export async function closeBrowserToolResources(logger: ToolDeps['logger']): Promise<void> {
  const { shutdownBrowser } = await import('../browser/launcher.js');
  await shutdownBrowser(logger);
}
