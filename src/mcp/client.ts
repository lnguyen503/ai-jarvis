/**
 * MCP Client — thin wrapper around the MCP SDK Client.
 * Lazy connect: the connection is opened on first use, not at construction time.
 * Supports Streamable HTTP transport (falls back to SSE if config specifies).
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { Tool as McpToolDef } from '@modelcontextprotocol/sdk/types.js';
import type { McpServerConfig } from '../config/schema.js';
import type pino from 'pino';

export type { McpToolDef };

export interface McpClientOptions {
  serverConfig: McpServerConfig;
  logger: pino.Logger;
}

export class McpClient {
  private _client: Client | null = null;
  private _connected = false;
  private _connecting: Promise<void> | null = null;

  constructor(private readonly opts: McpClientOptions) {}

  get serverName(): string {
    return this.opts.serverConfig.name;
  }

  /**
   * Ensure connection is established (lazy, idempotent).
   * Returns immediately if already connected.
   */
  private async _ensureConnected(): Promise<void> {
    if (this._connected && this._client) return;

    // Serialize concurrent connect calls
    if (this._connecting) {
      await this._connecting;
      return;
    }

    this._connecting = this._connect();
    try {
      await this._connecting;
    } finally {
      this._connecting = null;
    }
  }

  private async _connect(): Promise<void> {
    const { serverConfig, logger } = this.opts;
    const log = logger.child({ component: 'mcp.client', server: serverConfig.name });

    const client = new Client({ name: 'jarvis', version: '1.6.0' });

    const url = new URL(serverConfig.url);

    const transport =
      serverConfig.transport === 'sse'
        ? new SSEClientTransport(url)
        : new StreamableHTTPClientTransport(url);

    log.info({ url: serverConfig.url, transport: serverConfig.transport }, 'Connecting to MCP server');
    await client.connect(transport);
    this._client = client;
    this._connected = true;
    log.info({}, 'MCP server connected');
  }

  /**
   * Discover all tools the MCP server exposes.
   */
  async listTools(): Promise<McpToolDef[]> {
    await this._ensureConnected();
    const client = this._client!;

    const result = await client.listTools();
    return result.tools;
  }

  /**
   * Call a tool on the MCP server.
   * Returns the raw text content from the tool's response.
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    await this._ensureConnected();
    const client = this._client!;

    const result = await client.callTool({ name, arguments: args });

    // Extract text content from the result
    const content = result.content;
    if (!Array.isArray(content) || content.length === 0) {
      return '';
    }

    // Concatenate all text content blocks
    const textParts: string[] = [];
    for (const block of content) {
      if (block.type === 'text' && typeof block.text === 'string') {
        textParts.push(block.text);
      } else if (block.type === 'resource' && block.resource) {
        // Resource blocks: include URI and any text
        const r = block.resource as { uri?: string; text?: string };
        if (r.text) textParts.push(r.text);
        else if (r.uri) textParts.push(`[Resource: ${r.uri}]`);
      }
    }

    return textParts.join('\n');
  }

  /**
   * Disconnect from the MCP server. No-op if not connected.
   */
  async close(): Promise<void> {
    if (this._client && this._connected) {
      try {
        await this._client.close();
      } catch {
        // ignore close errors
      }
      this._connected = false;
      this._client = null;
    }
  }
}
