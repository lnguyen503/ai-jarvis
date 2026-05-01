/**
 * Unified provider abstraction for multi-model routing (v1.1).
 * Providers translate between our UnifiedMessage format and their wire format.
 */

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface UnifiedToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface UnifiedToolResultBlock {
  type: 'tool_result';
  tool_call_id: string;
  content: string;
}

export interface UnifiedTextBlock {
  type: 'text';
  text: string;
}

export type UnifiedContentBlock = UnifiedTextBlock | UnifiedToolResultBlock;

/** A message in our provider-agnostic conversation history. */
export interface UnifiedMessage {
  role: MessageRole;
  /** Plain text content (for simple user/assistant messages). */
  content?: string;
  /** Structured content blocks (for tool-use turns). */
  blocks?: UnifiedContentBlock[];
  /** Tool calls emitted by the assistant. */
  tool_calls?: UnifiedToolCall[];
  /** For tool-result messages, the id of the call being answered. */
  tool_call_id?: string;
}

/** Token usage reported by a provider. May be absent (Ollama doesn't always report). */
export interface UsageInfo {
  /** Standard input tokens — full price. */
  input_tokens: number;
  /** Output tokens — full price. */
  output_tokens: number;
  /** Tokens written to the prompt cache this call — billed at full input price.
   *  Only set when prompt caching is in use (Claude provider). */
  cache_creation_input_tokens?: number;
  /** Tokens read from the prompt cache this call — billed at 10% of input price.
   *  Only set when prompt caching is in use (Claude provider). */
  cache_read_input_tokens?: number;
}

/** Provider-agnostic response from a single LLM call. */
export interface UnifiedResponse {
  /** 'end_turn' | 'tool_use' — mirrors Anthropic stop reasons for easy porting. */
  stop_reason: 'end_turn' | 'tool_use';
  /** Plain text content from the assistant (already stripped of think tags). */
  content: string;
  /** Tool calls requested by the model, if stop_reason === 'tool_use'. */
  tool_calls: UnifiedToolCall[];
  /** Token usage, if available. */
  usage?: UsageInfo;
  /** Which provider/model produced this response. */
  provider: string;
  model: string;
}

/** A fully-typed tool definition for passing to providers. */
export interface UnifiedToolDef {
  name: string;
  description: string;
  /** JSON Schema object for the parameters. */
  parameters: Record<string, unknown>;
}

/** The interface every model provider must implement. */
export interface ModelProvider {
  readonly name: string;

  call(params: {
    model: string;
    system: string;
    messages: UnifiedMessage[];
    tools: UnifiedToolDef[];
    maxTokens: number;
    abortSignal: AbortSignal;
  }): Promise<UnifiedResponse>;

  /**
   * v1.12.0 — streaming variant of call(). Fires onTextDelta for each text
   * chunk as it arrives from the provider. Tool-use blocks arrive whole at
   * the end (we do not stream partial tool_call JSON — it's unparseable
   * mid-stream and pre-final partial tool args would be a footgun for
   * downstream dispatch). Returns the same UnifiedResponse as call() so
   * callers can branch on stop_reason after the stream completes.
   *
   * OPTIONAL: test mocks and minimal providers can omit it. The agent's
   * callWithFallback checks presence before routing through this method;
   * when absent, it falls back to call() silently (streaming is purely an
   * opt-in UX enhancement). Real providers (ClaudeProvider, OllamaCloudProvider)
   * implement it; the gateway only threads callbacks down when streaming
   * is enabled for the current chat.
   */
  streamText?(params: {
    model: string;
    system: string;
    messages: UnifiedMessage[];
    tools: UnifiedToolDef[];
    maxTokens: number;
    abortSignal: AbortSignal;
    onTextDelta: (chunk: string) => void;
  }): Promise<UnifiedResponse>;
}
