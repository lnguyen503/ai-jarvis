/**
 * Tests for OllamaCloudProvider.
 * All HTTP calls are mocked with fetch — never hits the live API.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OllamaCloudProvider } from '../../src/providers/ollama-cloud.js';
import type { UnifiedMessage } from '../../src/providers/types.js';

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Set OLLAMA_API_KEY env var for tests
beforeEach(() => {
  process.env['OLLAMA_API_KEY'] = 'test-ollama-key';
  vi.clearAllMocks();
});

afterEach(() => {
  delete process.env['OLLAMA_API_KEY'];
});

function makeOkResponse(body: unknown, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  });
}

function makeErrorResponse(status: number, text = 'error') {
  return Promise.resolve({
    ok: false,
    status,
    json: () => Promise.reject(new Error('not json')),
    text: () => Promise.resolve(text),
  });
}

const messages: UnifiedMessage[] = [{ role: 'user', content: 'Hello' }];
const tools = [
  {
    name: 'system_info',
    description: 'Get system info',
    parameters: { type: 'object', properties: {}, required: [] },
  },
];

describe('OllamaCloudProvider', () => {
  it('returns end_turn response for simple text reply', async () => {
    mockFetch.mockReturnValueOnce(
      makeOkResponse({
        choices: [{ message: { content: 'Hello back!', tool_calls: [] }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    );

    const provider = new OllamaCloudProvider();
    const result = await provider.call({
      model: 'glm-5.1:cloud',
      system: 'You are helpful.',
      messages,
      tools: [],
      maxTokens: 1024,
      abortSignal: new AbortController().signal,
    });

    expect(result.stop_reason).toBe('end_turn');
    expect(result.content).toBe('Hello back!');
    expect(result.tool_calls).toHaveLength(0);
    expect(result.provider).toBe('ollama-cloud');
    expect(result.model).toBe('glm-5.1:cloud');
    expect(result.usage).toMatchObject({ input_tokens: 10, output_tokens: 5 });
  });

  it('returns tool_use response when model requests a tool call', async () => {
    mockFetch.mockReturnValueOnce(
      makeOkResponse({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'system_info', arguments: '{}' },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      }),
    );

    const provider = new OllamaCloudProvider();
    const result = await provider.call({
      model: 'glm-5.1:cloud',
      system: 'You are helpful.',
      messages,
      tools,
      maxTokens: 1024,
      abortSignal: new AbortController().signal,
    });

    expect(result.stop_reason).toBe('tool_use');
    expect(result.tool_calls).toHaveLength(1);
    expect(result.tool_calls[0]).toMatchObject({ id: 'call_1', name: 'system_info', input: {} });
  });

  it('sends Authorization header with OLLAMA_API_KEY', async () => {
    mockFetch.mockReturnValueOnce(
      makeOkResponse({
        choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      }),
    );

    const provider = new OllamaCloudProvider();
    await provider.call({
      model: 'glm-5.1:cloud',
      system: '',
      messages,
      tools: [],
      maxTokens: 512,
      abortSignal: new AbortController().signal,
    });

    const [, opts] = mockFetch.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(opts.headers['Authorization']).toBe('Bearer test-ollama-key');
  });

  it('sends tools in OpenAI function format', async () => {
    mockFetch.mockReturnValueOnce(
      makeOkResponse({
        choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      }),
    );

    const provider = new OllamaCloudProvider();
    await provider.call({
      model: 'glm-5.1:cloud',
      system: '',
      messages,
      tools,
      maxTokens: 512,
      abortSignal: new AbortController().signal,
    });

    const [, opts] = mockFetch.mock.calls[0] as [string, { body: string }];
    const body = JSON.parse(opts.body) as { tools: Array<{ type: string; function: { name: string } }> };
    expect(body.tools[0]).toMatchObject({
      type: 'function',
      function: { name: 'system_info' },
    });
  });

  it('retries once on malformed tool_call JSON', async () => {
    // First call: malformed arguments
    mockFetch.mockReturnValueOnce(
      makeOkResponse({
        choices: [
          {
            message: {
              tool_calls: [
                {
                  id: 'bad',
                  type: 'function',
                  function: { name: 'tool', arguments: 'not-valid-json' },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      }),
    );
    // Second call (retry): valid response
    mockFetch.mockReturnValueOnce(
      makeOkResponse({
        choices: [{ message: { content: 'ok on retry' }, finish_reason: 'stop' }],
      }),
    );

    const provider = new OllamaCloudProvider();
    const result = await provider.call({
      model: 'glm-5.1:cloud',
      system: '',
      messages,
      tools,
      maxTokens: 512,
      abortSignal: new AbortController().signal,
    });

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result.stop_reason).toBe('end_turn');
    expect(result.content).toBe('ok on retry');
  });

  it('throws after two malformed tool_call attempts', async () => {
    const malformedResponse = makeOkResponse({
      choices: [
        {
          message: {
            tool_calls: [
              { id: 'bad', type: 'function', function: { name: 'tool', arguments: 'bad' } },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    });
    mockFetch.mockReturnValueOnce(malformedResponse);
    mockFetch.mockReturnValueOnce(
      makeOkResponse({
        choices: [
          {
            message: {
              tool_calls: [
                { id: 'bad2', type: 'function', function: { name: 'tool', arguments: 'bad2' } },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      }),
    );

    const provider = new OllamaCloudProvider();
    await expect(
      provider.call({
        model: 'glm-5.1:cloud',
        system: '',
        messages,
        tools,
        maxTokens: 512,
        abortSignal: new AbortController().signal,
      }),
    ).rejects.toThrow(/Malformed tool_call/);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('throws on HTTP 4xx error', async () => {
    mockFetch.mockReturnValueOnce(makeErrorResponse(401, 'Unauthorized'));

    const provider = new OllamaCloudProvider();
    await expect(
      provider.call({
        model: 'glm-5.1:cloud',
        system: '',
        messages,
        tools: [],
        maxTokens: 512,
        abortSignal: new AbortController().signal,
      }),
    ).rejects.toThrow(/Ollama Cloud HTTP 401/);
  });

  it('throws on HTTP 5xx error', async () => {
    // v1.7.2: 5xx now retries once — mock the error on both the initial
    // attempt and the retry so the final failure still bubbles up.
    mockFetch.mockReturnValueOnce(makeErrorResponse(500, 'Server Error'));
    mockFetch.mockReturnValueOnce(makeErrorResponse(500, 'Server Error'));

    const provider = new OllamaCloudProvider();
    await expect(
      provider.call({
        model: 'glm-5.1:cloud',
        system: '',
        messages,
        tools: [],
        maxTokens: 512,
        abortSignal: new AbortController().signal,
      }),
    ).rejects.toThrow(/Ollama Cloud HTTP 500/);
  });

  it('strips think tags from end_turn content', async () => {
    mockFetch.mockReturnValueOnce(
      makeOkResponse({
        choices: [
          {
            message: { content: '<think>internal</think>Final answer.', tool_calls: [] },
            finish_reason: 'stop',
          },
        ],
      }),
    );

    const provider = new OllamaCloudProvider();
    const result = await provider.call({
      model: 'glm-5.1:cloud',
      system: '',
      messages,
      tools: [],
      maxTokens: 512,
      abortSignal: new AbortController().signal,
    });

    expect(result.content).toBe('Final answer.');
  });

  it('throws if OLLAMA_API_KEY is not set', async () => {
    delete process.env['OLLAMA_API_KEY'];
    const provider = new OllamaCloudProvider();
    await expect(
      provider.call({
        model: 'glm-5.1:cloud',
        system: '',
        messages,
        tools: [],
        maxTokens: 512,
        abortSignal: new AbortController().signal,
      }),
    ).rejects.toThrow(/OLLAMA_API_KEY/);
  });
});
