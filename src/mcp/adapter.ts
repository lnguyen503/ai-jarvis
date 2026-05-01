/**
 * MCP tool adapter — converts an MCP tool definition into the Jarvis Tool interface.
 *
 * - Prefixes the tool name with "{serverName}__" to prevent collisions with built-in tools.
 * - Uses z.record(z.any()) for parameters since MCP tools ship JSON Schema, not Zod.
 * - Calls the MCP client's callTool() and returns a ToolResult.
 * - Output is scrubbed through ctx.safety.scrub() before returning.
 */

import { z } from 'zod';
import type { Tool, ToolContext, ToolResult } from '../tools/types.js';
import type { McpClient, McpToolDef } from './client.js';

/**
 * Adapt a single MCP tool definition into a Jarvis Tool.
 */
export function adaptMcpTool(mcpTool: McpToolDef, client: McpClient): Tool {
  const prefixedName = `${client.serverName}__${mcpTool.name}`;

  return {
    name: prefixedName,
    description: `[MCP:${client.serverName}] ${mcpTool.description ?? mcpTool.name}`,
    // MCP tools ship JSON Schema for their input, not Zod schemas.
    // We accept any record here; the actual validation is delegated to the MCP server.
    parameters: z.record(z.any()),

    async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      const log = ctx.logger.child({ component: 'mcp.adapter', tool: prefixedName });

      try {
        log.info({ toolName: prefixedName }, 'MCP tool call start');
        const raw = await client.callTool(mcpTool.name, input);
        log.info({ toolName: prefixedName, outputLen: raw.length }, 'MCP tool call complete');

        // Scrub secrets from MCP output (same path as all other tools)
        const scrubbed = ctx.safety.scrub(raw);

        return {
          ok: true,
          output: scrubbed,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error({ toolName: prefixedName, err: message }, 'MCP tool call failed');
        return {
          ok: false,
          output: `MCP tool "${prefixedName}" failed: ${message}`,
          error: { code: 'MCP_TOOL_ERROR', message },
        };
      }
    },
  };
}

/**
 * Adapt an array of MCP tool definitions into Jarvis Tools.
 */
export function adaptMcpTools(mcpTools: McpToolDef[], client: McpClient): Tool[] {
  return mcpTools.map((t) => adaptMcpTool(t, client));
}
