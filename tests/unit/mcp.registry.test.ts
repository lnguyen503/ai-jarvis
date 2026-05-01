/**
 * MCP Registry unit tests — McpClient is mocked.
 * Tests: disabled server path, enabled server path, prefixing, non-fatal failure.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Use vi.hoisted so mock classes are available when vi.mock factory is hoisted
const mocks = vi.hoisted(() => {
  const mockListTools = vi.fn().mockResolvedValue([
    { name: 'get_library_docs', description: 'Get library documentation', inputSchema: {} },
    { name: 'resolve_library_id', description: 'Resolve a library id', inputSchema: {} },
  ]);
  const mockCallTool = vi.fn().mockResolvedValue('result');
  const mockClose = vi.fn().mockResolvedValue(undefined);

  class MockMcpClient {
    serverName: string;
    listTools = mockListTools;
    callTool = mockCallTool;
    close = mockClose;

    constructor(opts: { serverConfig: { name: string } }) {
      this.serverName = opts.serverConfig.name;
    }
  }

  return { mockListTools, mockCallTool, mockClose, MockMcpClient };
});

vi.mock('../../src/mcp/client.js', () => ({
  McpClient: mocks.MockMcpClient,
}));

// Import AFTER mocking
import { McpRegistry } from '../../src/mcp/registry.js';
import { makeTestConfig } from '../fixtures/makeConfig.js';
import { getLogger } from '../../src/logger/index.js';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.mockListTools.mockResolvedValue([
    { name: 'get_library_docs', description: 'Get library documentation', inputSchema: {} },
    { name: 'resolve_library_id', description: 'Resolve a library id', inputSchema: {} },
  ]);
  mocks.mockClose.mockResolvedValue(undefined);
});

describe('McpRegistry — disabled', () => {
  it('returns [] when mcp.enabled is false', async () => {
    const cfg = makeTestConfig({ mcp: { enabled: false, servers: [] } });
    const registry = new McpRegistry({ config: cfg, logger: getLogger() });
    const tools = await registry.discover();
    expect(tools).toHaveLength(0);
  });

  it('returns [] when no servers are configured', async () => {
    const cfg = makeTestConfig({ mcp: { enabled: true, servers: [] } });
    const registry = new McpRegistry({ config: cfg, logger: getLogger() });
    const tools = await registry.discover();
    expect(tools).toHaveLength(0);
  });

  it('returns [] when all servers are disabled', async () => {
    const cfg = makeTestConfig({
      mcp: {
        enabled: true,
        servers: [{ name: 'context7', url: 'https://mcp.context7.com/mcp', enabled: false, transport: 'http' }],
      },
    });
    const registry = new McpRegistry({ config: cfg, logger: getLogger() });
    const tools = await registry.discover();
    expect(tools).toHaveLength(0);
  });
});

describe('McpRegistry — enabled', () => {
  function makeRegistryWithContext7() {
    const cfg = makeTestConfig({
      mcp: {
        enabled: true,
        servers: [{ name: 'context7', url: 'https://mcp.context7.com/mcp', enabled: true, transport: 'http' }],
      },
    });
    return new McpRegistry({ config: cfg, logger: getLogger() });
  }

  it('discovers tools from an enabled server', async () => {
    const registry = makeRegistryWithContext7();
    const tools = await registry.discover();
    expect(tools.length).toBe(2);
  });

  it('prefixes tool names with server name', async () => {
    const registry = makeRegistryWithContext7();
    const tools = await registry.discover();
    expect(tools[0]!.name).toBe('context7__get_library_docs');
    expect(tools[1]!.name).toBe('context7__resolve_library_id');
  });

  it('description includes server name prefix', async () => {
    const registry = makeRegistryWithContext7();
    const tools = await registry.discover();
    expect(tools[0]!.description).toContain('context7');
  });

  it('getTools() returns cached tools after discover()', async () => {
    const registry = makeRegistryWithContext7();
    await registry.discover();
    const tools = registry.getTools();
    expect(tools).toHaveLength(2);
  });

  it('getTools() returns empty array before discover()', () => {
    const registry = makeRegistryWithContext7();
    expect(registry.getTools()).toHaveLength(0);
  });
});

describe('McpRegistry — failure handling', () => {
  it('skips a server that fails to connect (non-fatal)', async () => {
    mocks.mockListTools.mockRejectedValueOnce(new Error('connection refused'));

    const cfg = makeTestConfig({
      mcp: {
        enabled: true,
        servers: [{ name: 'bad-server', url: 'https://bad.example.com/mcp', enabled: true, transport: 'http' }],
      },
    });
    const registry = new McpRegistry({ config: cfg, logger: getLogger() });
    // Should NOT throw
    const tools = await registry.discover();
    expect(tools).toHaveLength(0);
  });

  it('close() does not throw if no clients were opened', async () => {
    const cfg = makeTestConfig({ mcp: { enabled: false, servers: [] } });
    const registry = new McpRegistry({ config: cfg, logger: getLogger() });
    await expect(registry.close()).resolves.toBeUndefined();
  });

  it('close() calls close on all connected clients', async () => {
    const cfg = makeTestConfig({
      mcp: {
        enabled: true,
        servers: [{ name: 'context7', url: 'https://mcp.context7.com/mcp', enabled: true, transport: 'http' }],
      },
    });
    const registry = new McpRegistry({ config: cfg, logger: getLogger() });
    await registry.discover();
    await registry.close();
    expect(mocks.mockClose).toHaveBeenCalledOnce();
  });
});
