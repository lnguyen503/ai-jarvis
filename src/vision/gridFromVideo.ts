/**
 * Build a 2x2 frame grid PNG from an animated input (MP4/GIF/WebM).
 *
 * Telegram converts animated GIFs to MP4 before delivery, and Claude vision
 * only accepts single static frames. To let Claude comment on motion, we
 * sample four frames evenly across the clip and tile them into one PNG.
 *
 * Requires ffmpeg + ffprobe on PATH. Missing binaries throw a clear error
 * so the caller can tell the user.
 */

import { execa } from 'execa';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { child } from '../logger/index.js';

const log = child({ component: 'vision.grid' });

/** Tile width per cell in px. Final PNG is 2x this wide, 2x this tall. */
const CELL_WIDTH = 480;
/** ffmpeg timeout (ms). Grids for normal GIFs finish in well under 10s. */
const FFMPEG_TIMEOUT_MS = 20_000;

export class FfmpegMissingError extends Error {
  constructor(bin: string) {
    super(`${bin} is not installed or not on PATH`);
    this.name = 'FfmpegMissingError';
  }
}

/**
 * Extract a 4-frame 2x2 grid as a single PNG.
 * @param inputPath  Absolute path to the input clip (.mp4/.gif/.webm)
 * @returns          Absolute path to a temp .png. Caller must delete it.
 */
export async function buildFrameGridPng(inputPath: string): Promise<string> {
  // 1. Probe frame count. We use packet count as a cheap approximation —
  //    it's exact for GIF/MP4 in practice and we only need it for index math.
  let totalFrames = 0;
  try {
    const probe = await execa(
      'ffprobe',
      [
        '-v', 'error',
        '-select_streams', 'v:0',
        '-count_packets',
        '-show_entries', 'stream=nb_read_packets',
        '-of', 'csv=p=0',
        inputPath,
      ],
      { timeout: FFMPEG_TIMEOUT_MS },
    );
    totalFrames = parseInt(probe.stdout.trim(), 10) || 0;
  } catch (err: unknown) {
    if (isEnoent(err)) throw new FfmpegMissingError('ffprobe');
    throw new Error(
      `ffprobe failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (totalFrames < 1) {
    throw new Error('no frames detected in animation');
  }

  // 2. Pick 4 evenly-spaced frame indexes (first, 1/3, 2/3, last-ish).
  //    For very short GIFs (< 4 frames) we clamp and dedupe.
  const picks = pickIndexes(totalFrames, 4);
  const selectExpr = picks.map((n) => `eq(n\\,${n})`).join('+');

  const outPath = path.join(
    os.tmpdir(),
    `jarvis-grid-${Date.now()}-${process.pid}.png`,
  );

  // 3. Build the grid. `tile=2x2` stitches 4 selected frames into one image.
  try {
    await execa(
      'ffmpeg',
      [
        '-v', 'error',
        '-i', inputPath,
        '-vf',
        `select='${selectExpr}',scale=${CELL_WIDTH}:-2:flags=lanczos,tile=2x2`,
        '-frames:v', '1',
        '-vsync', 'vfr',
        '-y',
        outPath,
      ],
      { timeout: FFMPEG_TIMEOUT_MS },
    );
  } catch (err: unknown) {
    if (isEnoent(err)) throw new FfmpegMissingError('ffmpeg');
    throw new Error(
      `ffmpeg failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // 4. Sanity-check the output exists and isn't empty.
  if (!fs.existsSync(outPath) || fs.statSync(outPath).size === 0) {
    throw new Error('ffmpeg produced no output');
  }

  log.info(
    { inputPath, outPath, totalFrames, picks, bytes: fs.statSync(outPath).size },
    'Frame grid built',
  );
  return outPath;
}

/**
 * Spread N picks evenly across [0, total). If total < N, return unique
 * clamped indexes (duplicates dropped).
 */
function pickIndexes(total: number, n: number): number[] {
  if (total <= n) return Array.from({ length: total }, (_, i) => i);
  const step = total / n;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const idx = Math.floor(i * step);
    if (out[out.length - 1] !== idx) out.push(idx);
  }
  return out;
}

function isEnoent(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false;
  const code = (err as { code?: unknown }).code;
  return code === 'ENOENT';
}
