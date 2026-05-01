import pino from 'pino';
import path from 'path';
import fs from 'fs';
import { REDACT_PATHS } from './redact.js';

// Allow override via env for tests (use 'silent' to suppress all output)
const LOG_LEVEL = process.env['LOG_LEVEL'] ?? 'info';
const LOG_FILE = process.env['LOG_FILE'] ?? path.resolve(process.cwd(), 'logs/jarvis.log');

/**
 * Max size per log file before pino-roll rotates mid-day. Keeps individual
 * files small enough to grep without loading gigabytes into memory.
 */
const LOG_MAX_SIZE = '10M';
/**
 * How many rotated log files to keep on disk. Balances history depth with
 * disk footprint. With LOG_MAX_SIZE=10M, this caps the log directory at ~70MB.
 */
const LOG_MAX_FILES = 7;

let _logger: pino.Logger | null = null;

/**
 * Initialize the pino logger with daily rotation via pino-roll.
 * Call once at boot from index.ts.
 * In test environments (NODE_ENV=test), writes to stdout only.
 */
export function initLogger(): pino.Logger {
  const isTest = process.env['NODE_ENV'] === 'test';

  let destination: pino.DestinationStream | NodeJS.WritableStream;

  if (isTest) {
    // In tests, write to a silent destination or stdout based on LOG_LEVEL
    destination = pino.destination({ dest: process.stdout.fd, sync: true });
  } else {
    // Daily rotation: pino-roll writes to logs/jarvis.YYYY-MM-DD.log
    // We use a synchronous multistream approach — pino-roll is imported dynamically
    // to avoid failing when not in production context
    // Ensure the logs directory exists so pino-roll can write on first boot.
    // pino-roll itself doesn't mkdir; a missing directory = silent stdout fallback,
    // which is how logs went missing in the past.
    try {
      fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    } catch {
      /* if we can't create it we'll fall through to stdout below */
    }

    try {
      // pino.transport spawns a worker thread that loads pino-roll.
      // pino-roll@1's default export is an async factory; pino.transport
      // is the canonical way to consume it from a sync caller (the worker
      // resolves the async setup and the main thread sees a sync stream).
      // Rotates on BOTH daily boundary AND size limit (whichever hits first),
      // and keeps the last LOG_MAX_FILES rotated files. Names look like
      // "jarvis.log.1", "jarvis.log.2", ... with the active file at LOG_FILE.
      destination = pino.transport({
        target: 'pino-roll',
        options: {
          file: LOG_FILE,
          frequency: 'daily',
          size: LOG_MAX_SIZE,
          limit: { count: LOG_MAX_FILES },
          dateFormat: 'yyyy-MM-dd',
        },
      });
      // Announce on stderr where logs are actually going so the operator
      // knows which file to tail. Small noise, huge debugging win.
      process.stderr.write(
        `[logger] Writing to ${LOG_FILE} (max ${LOG_MAX_SIZE}/file, keeping last ${LOG_MAX_FILES} files)\n`,
      );
    } catch (err) {
      // pino-roll is unavailable or the log directory is unwritable. Write a
      // prominent warning to stderr (visible in the shell and in pm2 error
      // logs) instead of silently falling back, so the user can tell that
      // file logging is OFF.
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `[logger] FILE LOGGING DISABLED — pino-roll failed: ${msg}. ` +
          `Logs will go to stdout only. Redirect via "node dist/index.js > logs/fallback.log 2>&1" to persist.\n`,
      );
      destination = pino.destination({ dest: process.stdout.fd, sync: false });
    }
  }

  const loggerInstance = pino(
    {
      level: LOG_LEVEL,
      redact: {
        paths: REDACT_PATHS,
        censor: '[REDACTED]',
      },
      formatters: {
        level(label: string) {
          return { level: label };
        },
      },
      timestamp: pino.stdTimeFunctions.isoTime,
      base: { pid: process.pid, host: undefined },
    },
    destination as pino.DestinationStream,
  );

  _logger = loggerInstance;
  return loggerInstance;
}

/**
 * Returns the initialized logger.
 * Auto-initializes with defaults if not yet initialized (for module-level use in tests).
 */
export function getLogger(): pino.Logger {
  if (!_logger) {
    _logger = initLogger();
  }
  return _logger;
}

/**
 * Create a child logger with component binding.
 * Usage: const log = child({ component: 'agent' });
 */
export function child(bindings: Record<string, unknown>): pino.Logger {
  return getLogger().child(bindings);
}

// Convenience export — behaves as the root logger
// Components should call child() instead of using this directly
export const logger = {
  get instance(): pino.Logger {
    return getLogger();
  },
  child(bindings: Record<string, unknown>): pino.Logger {
    return child(bindings);
  },
  trace: (obj: Record<string, unknown> | string, msg?: string) => getLogger().trace(obj as object, msg),
  debug: (obj: Record<string, unknown> | string, msg?: string) => getLogger().debug(obj as object, msg),
  info: (obj: Record<string, unknown> | string, msg?: string) => getLogger().info(obj as object, msg),
  warn: (obj: Record<string, unknown> | string, msg?: string) => getLogger().warn(obj as object, msg),
  error: (obj: Record<string, unknown> | string, msg?: string) => getLogger().error(obj as object, msg),
  fatal: (obj: Record<string, unknown> | string, msg?: string) => getLogger().fatal(obj as object, msg),
};
