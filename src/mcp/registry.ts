/**
 * MCP Registry — loads enabled servers from config, discovers tools, and returns
 * an array of adapted Jarvis Tool objects.
 *
 * - If mcp.enabled is false, returns [] immediately. No network calls.
 * - Discovery failures are non-fatal: the server is skipped with a warn log.
 * - Connections are cached; call close() on shutdown.
 */

import type { AppConfig } from '../config/schema.js';
import type { Tool } from '../tools/types.js';
import type pino from 'pino';
import { McpClient } from './client.js';
import { adaptMcpTools } from './adapter.js';

export interface McpRegistryDeps {
  config: AppConfig;
  logger: pino.Logger;
}

export class McpRegistry {
  private _clients: McpClient[] = [];
  private _tools: Tool[] = [];

  constructor(private readonly deps: McpRegistryDeps) {}

  /**
   * Discover tools from all enabled MCP servers.
   * Non-fatal: a server that fails to connect is skipped.
   * Returns the flat list of adapted tools.
   */
  async discover(): Promise<Tool[]> {
    const { config, logger } = this.deps;
    const log = logger.child({ component: 'mcp.registry' });

    if (!config.mcp.enabled) {
      log.debug({}, 'MCP disabled — skipping discovery');
      return [];
    }

    const tools: Tool[] = [];
    const enabledServers = config.mcp.servers.filter((s) => s.enabled);

    if (enabledServers.length === 0) {
      log.info({}, 'No enabled MCP servers configured');
      return [];
    }

    log.info({ serverCount: enabledServers.length }, 'Discovering MCP tools');

    for (const serverConfig of enabledServers) {
      const client = new McpClient({ serverConfig, logger });
      try {
        const mcpTools = await client.listTools();
        const adapted = adaptMcpTools(mcpTools, client);
        // v1.7.10 — propagate adminOnly from the server config onto every
        // tool discovered from that server, so the dispatcher can hide
        // them from non-admin sessions.
        if (serverConfig.adminOnly) {
          for (const t of adapted) {
            t.adminOnly = true;
          }
        }
        tools.push(...adapted);
        this._clients.push(client);
        log.info(
          { server: serverConfig.name, toolCount: adapted.length, tools: adapted.map((t) => t.name) },
          'MCP server tools discovered',
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn(
          { server: serverConfig.name, err: message },
          'MCP server discovery failed — skipping (non-fatal)',
        );
        // Close client if we opened a partial connection
        await client.close().catch(() => undefined);
      }
    }

    this._tools = tools;
    log.info({ totalTools: tools.length }, 'MCP discovery complete');
    return tools;
  }

  /** Returns the cached list of discovered tools (empty before discover() is called). */
  getTools(): Tool[] {
    return this._tools;
  }

  /** Close all active MCP connections. */
  async close(): Promise<void> {
    await Promise.allSettled(this._clients.map((c) => c.close()));
    this._clients = [];
    this._tools = [];
  }
}
