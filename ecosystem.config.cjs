/**
 * PM2 process manifest for the Avengers ensemble (v1.21.0; v1.21.1 expanded
 * to 4 bots).
 *
 * CommonJS — PM2 doesn't natively load ESM config files.
 *
 * Each bot runs as a separate pm2 process with its own BOT_NAME env var.
 * BOT_NAME is consumed by resolveBotIdentity() at boot to select the
 * correct Telegram token, persona, data directory, tool allowlist, webapp
 * port, and health endpoint port. It must be a member of the BOT_NAMES
 * closed set defined in src/config/botIdentity.ts — currently:
 *   ['ai-jarvis', 'ai-tony', 'ai-natasha', 'ai-bruce']
 *
 * Per-bot log directories (data/<botName>/logs/) are written under the
 * per-bot data root so sandbox narrowing (data/<botName>/) captures them.
 * The directories are auto-created by pm2 on first start.
 *
 * Adding a new bot (v1.22.0+):
 *   1. Append a new entry to the apps array below.
 *   2. Set env.BOT_NAME to the new name (must match BOT_NAMES entry).
 *   3. Point out_file + error_file under data/<newBotName>/logs/.
 *   4. Add BOT_TOKEN_<NEWNAME> to .env and .env.example.
 *   5. Add the corresponding webapp + health port to BOT_WEBAPP_PORT /
 *      BOT_HEALTH_PORT in src/config/botIdentity.ts.
 *   6. `npm run build && pm2 reload ecosystem.config.cjs`
 */

'use strict';

module.exports = {
  apps: [
    {
      name: 'ai-jarvis',
      script: 'dist/index.js',
      env: {
        BOT_NAME: 'ai-jarvis',
        LOG_FILE: 'data/ai-jarvis/logs/jarvis.log',
      },
      out_file: 'data/ai-jarvis/logs/out.log',
      error_file: 'data/ai-jarvis/logs/err.log',
      autorestart: true,
      max_restarts: 10,
    },
    {
      name: 'ai-tony',
      script: 'dist/index.js',
      env: {
        BOT_NAME: 'ai-tony',
        LOG_FILE: 'data/ai-tony/logs/jarvis.log',
      },
      out_file: 'data/ai-tony/logs/out.log',
      error_file: 'data/ai-tony/logs/err.log',
      autorestart: true,
      max_restarts: 10,
    },
    {
      name: 'ai-natasha',
      script: 'dist/index.js',
      env: {
        BOT_NAME: 'ai-natasha',
        LOG_FILE: 'data/ai-natasha/logs/jarvis.log',
      },
      out_file: 'data/ai-natasha/logs/out.log',
      error_file: 'data/ai-natasha/logs/err.log',
      autorestart: true,
      max_restarts: 10,
    },
    {
      name: 'ai-bruce',
      script: 'dist/index.js',
      env: {
        BOT_NAME: 'ai-bruce',
        LOG_FILE: 'data/ai-bruce/logs/jarvis.log',
      },
      out_file: 'data/ai-bruce/logs/out.log',
      error_file: 'data/ai-bruce/logs/err.log',
      autorestart: true,
      max_restarts: 10,
    },
  ],
};
