import type {
  AIStreamEvent,
  AIToolCall,
  AIToolCallSpec,
  ModelCapabilities,
  ProviderAdapter,
  ProviderGenerateTextRequest,
  ProviderGenerateTextResponse,
  ProviderHealth,
  ProviderId,
  ProviderInitOptions,
} from '@ide/protocol';

function isLoopbackUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.hostname === 'localhost' || url.hostname === '::1' || url.hostname.startsWith('127.');
  } catch {
    return false;
  }
}

function createRequestSignal(timeoutMs: number, upstream?: AbortSignal): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const abort = () => controller.abort();
  if (upstream?.aborted) {
    controller.abort();
  } else {
    upstream?.addEventListener('abort', abort, { once: true });
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      upstream?.removeEventListener('abort', abort);
    },
  };
}

function authHeaders(apiKey?: string): Record<string, string> {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

export class OpenAICompatibleAdapter implements ProviderAdapter {
  readonly providerId: ProviderId;
  readonly supportedModels: string[];
  readonly capabilities: ModelCapabilities;

  private baseUrl: string;
  private apiKey?: string;
  private timeoutMs: number;

  constructor(config: {
    providerId: ProviderId;
    baseUrl?: string;
    apiKey?: string;
    models: string[];
    timeoutMs?: number;
  }) {
    this.providerId = config.providerId;
    this.baseUrl = config.baseUrl ?? 'https://api.openai.com';
    this.apiKey = config.apiKey;
    this.supportedModels = config.models;
    this.timeoutMs = config.timeoutMs ?? 30000;
    this.capabilities = {
      tools: true,
      vision: config.baseUrl ? true : false,
      reasoning: true,
      streaming: true,
      longContext: true,
      codeEditing: true,
      embeddings: true,
      reranking: false,
    };
  }

  async initialize(_options: ProviderInitOptions): Promise<void> {}

  async healthCheck(): Promise<ProviderHealth> {
    if (!this.apiKey && !isLoopbackUrl(this.baseUrl)) {
      return {
        providerId: this.providerId,
        healthy: false,
        latencyMs: 0,
        errorRate: 1,
        lastCheckedAt: new Date().toISOString(),
        notes: ['API key is required for non-loopback OpenAI-compatible providers'],
      };
    }

    const start = Date.now();
    const requestSignal = createRequestSignal(5000);
    try {
      const response = await fetch(`${this.baseUrl}/v1/models`, {
        method: 'GET',
        headers: authHeaders(this.apiKey),
        signal: requestSignal.signal,
      });

      return {
        providerId: this.providerId,
        healthy: response.ok,
        latencyMs: Date.now() - start,
        errorRate: response.ok ? 0 : 1,
        lastCheckedAt: new Date().toISOString(),
        notes: response.ok ? undefined : [`HTTP ${response.status}`],
      };
    } catch {
      return {
        providerId: this.providerId,
        healthy: false,
        latencyMs: Date.now() - start,
        errorRate: 1,
        lastCheckedAt: new Date().toISOString(),
        notes: ['health check failed'],
      };
    } finally {
      requestSignal.cleanup();
    }
  }

  async generateText(request: ProviderGenerateTextRequest): Promise<ProviderGenerateTextResponse> {
    if (!this.apiKey && !isLoopbackUrl(this.baseUrl)) {
      throw new Error(`${this.providerId} requires an API key for ${this.baseUrl}`);
    }

    const start = Date.now();
    const requestSignal = createRequestSignal(this.timeoutMs, request.signal);

    try {
      const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders(this.apiKey),
        },
        body: JSON.stringify({
          model: request.modelId,
          messages: [{ role: 'user', content: request.prompt }],
          max_tokens: request.maxTokens,
          temperature: request.temperature,
          stream: false,
          ...openAIToolsBody(request.tools),
        }),
        signal: requestSignal.signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`${this.providerId} returned ${response.status}: ${body.slice(0, 200)}`);
      }

      const data = (await response.json()) as {
        choices: Array<{
          message: {
            content?: string | null;
            tool_calls?: OpenAIChatToolCall[];
          };
        }>;
        usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
      };
      const latencyMs = Date.now() - start;
      const choice = data.choices?.[0];
      const toolCalls = (choice?.message?.tool_calls ?? []).map(openAIToolCallToProtocol);

      return {
        providerId: this.providerId,
        modelId: request.modelId,
        text: choice?.message?.content ?? '',
        usage: {
          inputTokens: data.usage?.prompt_tokens,
          outputTokens: data.usage?.completion_tokens,
          totalTokens: data.usage?.total_tokens,
          latencyMs,
        },
        toolCalls,
      };
    } catch (err) {
      throw err;
    } finally {
      requestSignal.cleanup();
    }
  }

  async streamText(request: ProviderGenerateTextRequest): Promise<AsyncIterable<AIStreamEvent>> {
    const self = this;
    return (async function* () {
      yield { type: 'start', requestId: request.requestId };

      if (!self.apiKey && !isLoopbackUrl(self.baseUrl)) {
        yield { type: 'warning', message: `${self.providerId} requires an API key for ${self.baseUrl}` };
        yield { type: 'end', reason: 'error' };
        return;
      }

      const requestSignal = createRequestSignal(self.timeoutMs, request.signal);
      try {
        const response = await fetch(`${self.baseUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...authHeaders(self.apiKey),
          },
          body: JSON.stringify({
            model: request.modelId,
            messages: [{ role: 'user', content: request.prompt }],
            max_tokens: request.maxTokens,
            temperature: request.temperature,
            stream: true,
            ...openAIToolsBody(request.tools),
          }),
          signal: requestSignal.signal,
        });

        if (!response.ok || !response.body) {
          yield { type: 'warning', message: `${self.providerId} stream returned ${response.status}` };
          yield { type: 'end', reason: 'error' };
          return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        const toolCallBuffers = new Map<number, OpenAIStreamToolCallBuffer>();
        const emittedToolCallIds = new Set<string>();

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data: ')) continue;
            const payload = trimmed.slice(6);
            if (payload === '[DONE]') {
              for (const event of flushOpenAIStreamToolCalls(toolCallBuffers, emittedToolCallIds)) {
                yield event;
              }
              yield { type: 'end', reason: 'complete' };
              return;
            }
            try {
              const data = JSON.parse(payload) as {
                choices: Array<{
                  delta?: {
                    content?: string;
                    tool_calls?: OpenAIStreamToolCallDelta[];
                  };
                  finish_reason?: string | null;
                }>;
              };
              const choice = data.choices?.[0];
              const content = choice?.delta?.content;
              if (content) {
                yield { type: 'delta', text: content };
              }
              for (const toolCallDelta of choice?.delta?.tool_calls ?? []) {
                appendOpenAIStreamToolCall(toolCallBuffers, toolCallDelta);
              }
              if (choice?.finish_reason === 'tool_calls') {
                for (const event of flushOpenAIStreamToolCalls(toolCallBuffers, emittedToolCallIds)) {
                  yield event;
                }
              }
            } catch {
              continue;
            }
          }
        }

        for (const event of flushOpenAIStreamToolCalls(toolCallBuffers, emittedToolCallIds)) {
          yield event;
        }
        yield { type: 'end', reason: 'complete' };
      } catch (err) {
        yield {
          type: 'warning',
          message: `Stream error: ${err instanceof Error ? err.message : String(err)}`,
        };
        yield { type: 'end', reason: 'error' };
      } finally {
        requestSignal.cleanup();
      }
    })();
  }

  supportsTools(): boolean {
    return true;
  }

  supportsVision(): boolean {
    return this.capabilities.vision;
  }

  supportsStreaming(): boolean {
    return true;
  }
}

interface OpenAIChatToolCall {
  id: string;
  type: 'function';
  function?: {
    name?: string;
    arguments?: string;
  };
}

interface OpenAIStreamToolCallDelta {
  index: number;
  id?: string;
  type?: 'function';
  function?: {
    name?: string;
    arguments?: string;
  };
}

interface OpenAIStreamToolCallBuffer {
  id?: string;
  name?: string;
  argumentsText: string;
}

function openAIToolsBody(tools?: AIToolCallSpec[]): Record<string, unknown> {
  if (!tools?.length) {
    return {};
  }

  return {
    tools: tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema ?? { type: 'object', properties: {} },
        strict: tool.strict,
      },
    })),
    tool_choice: 'auto',
  };
}

function openAIToolCallToProtocol(toolCall: OpenAIChatToolCall): AIToolCall {
  return {
    id: toolCall.id,
    name: toolCall.function?.name ?? 'unknown_tool',
    arguments: parseToolArguments(toolCall.function?.arguments),
  };
}

function appendOpenAIStreamToolCall(
  buffers: Map<number, OpenAIStreamToolCallBuffer>,
  delta: OpenAIStreamToolCallDelta,
): void {
  const current = buffers.get(delta.index) ?? { argumentsText: '' };
  buffers.set(delta.index, {
    id: delta.id ?? current.id,
    name: delta.function?.name ?? current.name,
    argumentsText: `${current.argumentsText}${delta.function?.arguments ?? ''}`,
  });
}

function flushOpenAIStreamToolCalls(
  buffers: Map<number, OpenAIStreamToolCallBuffer>,
  emittedIds: Set<string>,
): AIStreamEvent[] {
  const events: AIStreamEvent[] = [];

  for (const [index, value] of buffers) {
    const id = value.id ?? `tool-${index}`;
    if (!value.name || emittedIds.has(id)) {
      continue;
    }

    events.push({
      type: 'tool_call',
      toolCall: {
        id,
        name: value.name,
        arguments: parseToolArguments(value.argumentsText),
      },
    });
    emittedIds.add(id);
  }

  return events;
}

function parseToolArguments(value: string | undefined): Record<string, unknown> {
  if (!value?.trim()) {
    return {};
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return { raw: value };
  }

  return { raw: value };
}
