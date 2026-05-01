/**
 * MCP client unit tests — all SDK transport is mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Use vi.hoisted so mocks are available when vi.mock factories run (they get hoisted)
const mocks = vi.hoisted(() => {
  const mockConnect = vi.fn().mockResolvedValue(undefined);
  const mockListTools = vi.fn().mockResolvedValue({
    tools: [
      { name: 'get_library_docs', description: 'Get library docs', inputSchema: {} },
      { name: 'resolve_library_id', description: 'Resolve library id', inputSchema: {} },
    ],
  });
  const mockCallTool = vi.fn().mockResolvedValue({
    content: [{ type: 'text', text: 'Here are the docs' }],
  });
  const mockClose = vi.fn().mockResolvedValue(undefined);

  // Track constructor calls
  const httpCalls: URL[] = [];
  const sseCalls: URL[] = [];

  class MockSdkClient {
    connect = mockConnect;
    listTools = mockListTools;
    callTool = mockCallTool;
    close = mockClose;
  }

  class MockStreamableHTTP {
    constructor(url: URL) {
      httpCalls.push(url);
    }
  }

  class MockSSE {
    constructor(url: URL) {
      sseCalls.push(url);
    }
  }

  return { mockConnect, mockListTools, mockCallTool, mockClose, MockStreamableHTTP, MockSSE, MockSdkClient, httpCalls, sseCalls };
});

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: mocks.MockSdkClient,
  getSupportedElicitationModes: vi.fn(),
}));

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: mocks.MockStreamableHTTP,
  StreamableHTTPError: class StreamableHTTPError extends Error {},
}));

vi.mock('@modelcontextprotocol/sdk/client/sse.js', () => ({
  SSEClientTransport: mocks.MockSSE,
}));

// Import AFTER mocking
import { McpClient } from '../../src/mcp/client.js';
import { getLogger } from '../../src/logger/index.js';

function makeClient(transport: 'http' | 'sse' = 'http') {
  return new McpClient({
    serverConfig: {
      name: 'context7',
      url: 'https://mcp.context7.com/mcp',
      enabled: true,
      transport,
    },
    logger: getLogger(),
  });
}

describe('McpClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Re-set default implementations after clearAllMocks
    mocks.mockConnect.mockResolvedValue(undefined);
    mocks.mockListTools.mockResolvedValue({
      tools: [
        { name: 'get_library_docs', description: 'Get library docs', inputSchema: {} },
        { name: 'resolve_library_id', description: 'Resolve library id', inputSchema: {} },
      ],
    });
    mocks.mockCallTool.mockResolvedValue({
      content: [{ type: 'text', text: 'Here are the docs' }],
    });
    mocks.mockClose.mockResolvedValue(undefined);
  });

  it('exposes the server name', () => {
    const client = makeClient();
    expect(client.serverName).toBe('context7');
  });

  it('listTools() connects lazily and returns tools', async () => {
    const client = makeClient();
    const tools = await client.listTools();

    expect(mocks.mockConnect).toHaveBeenCalledOnce();
    expect(tools).toHaveLength(2);
    expect(tools[0]!.name).toBe('get_library_docs');
    expect(tools[1]!.name).toBe('resolve_library_id');
  });

  it('listTools() does not reconnect on second call', async () => {
    const client = makeClient();
    await client.listTools();
    await client.listTools();

    // connect should have been called only once
    expect(mocks.mockConnect).toHaveBeenCalledTimes(1);
  });

  it('callTool() returns the text content from the response', async () => {
    const client = makeClient();
    const result = await client.callTool('get_library_docs', { libraryId: 'react' });
    expect(result).toBe('Here are the docs');
  });

  it('callTool() passes name and args to the SDK callTool', async () => {
    const client = makeClient();
    await client.callTool('get_library_docs', { libraryId: 'react' });

    expect(mocks.mockCallTool).toHaveBeenCalledWith({
      name: 'get_library_docs',
      arguments: { libraryId: 'react' },
    });
  });

  it('uses SSEClientTransport when transport=sse', async () => {
    const client = makeClient('sse');
    await client.listTools();
    expect(mocks.sseCalls.length).toBeGreaterThan(0);
    expect(mocks.sseCalls[mocks.sseCalls.length - 1]!.toString()).toBe('https://mcp.context7.com/mcp');
  });

  it('uses StreamableHTTPClientTransport when transport=http', async () => {
    const client = makeClient('http');
    await client.listTools();
    expect(mocks.httpCalls.length).toBeGreaterThan(0);
    expect(mocks.httpCalls[mocks.httpCalls.length - 1]!.toString()).toBe('https://mcp.context7.com/mcp');
  });

  it('callTool() handles empty content array', async () => {
    mocks.mockCallTool.mockResolvedValueOnce({ content: [] });
    const client = makeClient();
    const result = await client.callTool('any_tool', {});
    expect(result).toBe('');
  });

  it('callTool() handles resource content blocks', async () => {
    mocks.mockCallTool.mockResolvedValueOnce({
      content: [{ type: 'resource', resource: { uri: 'https://example.com', text: 'Resource text' } }],
    });
    const client = makeClient();
    const result = await client.callTool('any_tool', {});
    expect(result).toBe('Resource text');
  });

  it('close() does not throw if not connected', async () => {
    const client = makeClient();
    await expect(client.close()).resolves.toBeUndefined();
    expect(mocks.mockClose).not.toHaveBeenCalled();
  });

  it('close() closes the SDK client when connected', async () => {
    const client = makeClient();
    await client.listTools();
    await client.close();

    expect(mocks.mockClose).toHaveBeenCalled();
  });
});
