import type {
  AIStreamEvent,
  ModelCapabilities,
  ProviderAdapter,
  ProviderGenerateTextRequest,
  ProviderGenerateTextResponse,
  ProviderHealth,
  ProviderId,
  ProviderInitOptions,
} from '@ide/protocol';

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

export class OllamaAdapter implements ProviderAdapter {
  readonly providerId: ProviderId = 'ollama';
  readonly supportedModels: string[];
  readonly capabilities: ModelCapabilities = {
    tools: false,
    vision: false,
    reasoning: false,
    streaming: true,
    longContext: true,
    codeEditing: true,
    embeddings: true,
    reranking: false,
  };

  private baseUrl: string;
  private timeoutMs: number;

  constructor(config: { models: string[]; baseUrl?: string; timeoutMs?: number }) {
    this.supportedModels = config.models;
    this.baseUrl = config.baseUrl ?? 'http://127.0.0.1:11434';
    this.timeoutMs = config.timeoutMs ?? 60000;
  }

  async initialize(_options: ProviderInitOptions): Promise<void> {}

  async healthCheck(): Promise<ProviderHealth> {
    const start = Date.now();
    const requestSignal = createRequestSignal(5000);
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`, {
        signal: requestSignal.signal,
      });

      return {
        providerId: this.providerId,
        healthy: response.ok,
        latencyMs: Date.now() - start,
        errorRate: response.ok ? 0 : 1,
        lastCheckedAt: new Date().toISOString(),
      };
    } catch {
      return {
        providerId: this.providerId,
        healthy: false,
        latencyMs: Date.now() - start,
        errorRate: 1,
        lastCheckedAt: new Date().toISOString(),
        notes: ['Ollama not reachable'],
      };
    } finally {
      requestSignal.cleanup();
    }
  }

  async generateText(request: ProviderGenerateTextRequest): Promise<ProviderGenerateTextResponse> {
    const start = Date.now();
    const requestSignal = createRequestSignal(this.timeoutMs, request.signal);

    try {
      const response = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: request.modelId,
          messages: [{ role: 'user', content: request.prompt }],
          stream: false,
          options: {
            num_predict: request.maxTokens,
            temperature: request.temperature,
          },
        }),
        signal: requestSignal.signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`Ollama returned ${response.status}: ${body.slice(0, 200)}`);
      }

      const data = (await response.json()) as {
        message?: { content: string };
        eval_count?: number;
        prompt_eval_count?: number;
      };
      const latencyMs = Date.now() - start;

      return {
        providerId: this.providerId,
        modelId: request.modelId,
        text: data.message?.content ?? '',
        usage: {
          inputTokens: data.prompt_eval_count,
          outputTokens: data.eval_count,
          totalTokens: (data.prompt_eval_count ?? 0) + (data.eval_count ?? 0),
          latencyMs,
        },
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

      const requestSignal = createRequestSignal(self.timeoutMs, request.signal);
      try {
        const response = await fetch(`${self.baseUrl}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: request.modelId,
            messages: [{ role: 'user', content: request.prompt }],
            stream: true,
            options: {
              num_predict: request.maxTokens,
              temperature: request.temperature,
            },
          }),
          signal: requestSignal.signal,
        });

        if (!response.ok || !response.body) {
          yield { type: 'warning', message: `Ollama stream returned ${response.status}` };
          yield { type: 'end', reason: 'error' };
          return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
              const data = JSON.parse(trimmed) as { message?: { content?: string }; done?: boolean };
              if (data.message?.content) {
                yield { type: 'delta', text: data.message.content };
              }
              if (data.done) {
                yield { type: 'end', reason: 'complete' };
                return;
              }
            } catch {
              continue;
            }
          }
        }

        yield { type: 'end', reason: 'complete' };
      } catch (err) {
        yield { type: 'warning', message: `Ollama stream error: ${err instanceof Error ? err.message : String(err)}` };
        yield { type: 'end', reason: 'error' };
      } finally {
        requestSignal.cleanup();
      }
    })();
  }

  supportsTools(): boolean {
    return false;
  }

  supportsVision(): boolean {
    return false;
  }

  supportsStreaming(): boolean {
    return true;
  }
}
