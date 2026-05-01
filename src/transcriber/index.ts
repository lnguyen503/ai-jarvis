import fs from 'fs';
import path from 'path';
import os from 'os';
import type { AppConfig } from '../config/index.js';
import { child } from '../logger/index.js';

const log = child({ component: 'transcriber' });

/** Timeout (ms) for downloading the voice file from Telegram's CDN. */
const FILE_DOWNLOAD_TIMEOUT_MS = 10_000;

/** Timeout (ms) for the Whisper API transcription call. */
const WHISPER_TIMEOUT_MS = 30_000;

export interface TranscribeResult {
  text: string;
  durationMs: number;
}

export interface Transcriber {
  /**
   * Download a voice file and transcribe it via Whisper.
   * @param fileUrl  Full download URL (may contain an auth token).
   * @param signal   Optional external AbortSignal (e.g. from a /stop command).
   *                 When signalled, any in-flight download or API call is cancelled.
   */
  transcribeVoice(fileUrl: string, signal?: AbortSignal): Promise<TranscribeResult>;
}

/**
 * Download a voice file from a URL and transcribe it via OpenAI Whisper API.
 * Uses raw fetch (Node 20 built-in) — no OpenAI SDK needed for this single endpoint.
 */
export function initTranscriber(cfg: AppConfig): Transcriber {
  const whisperUrl = `${cfg.whisper.apiBaseUrl}/audio/transcriptions`;
  const model = cfg.whisper.model;

  return {
    async transcribeVoice(fileUrl: string, signal?: AbortSignal): Promise<TranscribeResult> {
      const startMs = Date.now();
      log.info({ fileUrl: fileUrl.replace(/token=[^&]+/, 'token=REDACTED') }, 'Transcription start');

      // Download the voice file to a temp file
      const tmpDir = os.tmpdir();
      const tmpFile = path.join(tmpDir, `jarvis-voice-${Date.now()}.ogg`);

      try {
        // --- Download phase: 10s timeout + optional external signal ---
        const dlSignal = AbortSignal.any([
          AbortSignal.timeout(FILE_DOWNLOAD_TIMEOUT_MS),
          ...(signal ? [signal] : []),
        ]);

        const dlResponse = await fetchWithRetry(fileUrl, { method: 'GET', signal: dlSignal }, 2);
        if (!dlResponse.ok) {
          throw new Error(`Failed to download voice file: HTTP ${dlResponse.status}`);
        }

        const audioBuffer = await dlResponse.arrayBuffer();
        fs.writeFileSync(tmpFile, Buffer.from(audioBuffer));

        // Build multipart form for Whisper
        const formData = new FormData();
        const audioBlob = new Blob([fs.readFileSync(tmpFile)], { type: 'audio/ogg' });
        formData.append('file', audioBlob, 'voice.ogg');
        formData.append('model', model);
        formData.append('response_format', 'json');

        const apiKey = process.env['OPENAI_API_KEY'];
        if (!apiKey) {
          throw new Error('OPENAI_API_KEY environment variable not set');
        }

        // --- Whisper API phase: 30s timeout + optional external signal ---
        const whisperSignal = AbortSignal.any([
          AbortSignal.timeout(WHISPER_TIMEOUT_MS),
          ...(signal ? [signal] : []),
        ]);

        const whisperResponse = await fetchWithRetry(
          whisperUrl,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${apiKey}`,
            },
            body: formData,
            signal: whisperSignal,
          },
          2,
        );

        if (!whisperResponse.ok) {
          const body = await whisperResponse.text();
          throw new Error(`Whisper API error: HTTP ${whisperResponse.status} — ${body}`);
        }

        const json = (await whisperResponse.json()) as { text?: string };
        const text = json.text?.trim() ?? '';

        const durationMs = Date.now() - startMs;
        log.info({ durationMs, textLength: text.length }, 'Transcription complete');

        return { text, durationMs };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error({ err: message, durationMs: Date.now() - startMs }, 'Transcription failed');
        throw err;
      } finally {
        // Clean up temp file
        if (fs.existsSync(tmpFile)) {
          try {
            fs.unlinkSync(tmpFile);
          } catch {
            // Best effort cleanup
          }
        }
      }
    },
  };
}

/**
 * Fetch with retry and exponential backoff.
 * Retries on network errors and 429/5xx responses.
 * The caller is responsible for threading an AbortSignal into options.signal.
 */
async function fetchWithRetry(
  url: string,
  options: RequestInit,
  maxRetries: number,
): Promise<Response> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, options);

      // Don't retry on client errors (4xx) except 429
      if (response.status === 429 || response.status >= 500) {
        if (attempt < maxRetries) {
          const delay = Math.pow(2, attempt) * 1000 + Math.random() * 500;
          log.warn(
            { status: response.status, attempt, delay },
            'Whisper/download request failed, retrying',
          );
          await sleep(delay);
          continue;
        }
      }

      return response;
    } catch (err) {
      lastError = err;
      // Don't retry if the caller aborted (timeout or /stop signal)
      if (err instanceof Error && err.name === 'AbortError') {
        throw err;
      }
      if (attempt < maxRetries) {
        const delay = Math.pow(2, attempt) * 1000 + Math.random() * 500;
        await sleep(delay);
      }
    }
  }

  throw lastError ?? new Error('Fetch failed after retries');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
