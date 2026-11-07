// The generator's LLM (PRD §12.1). `Llm` is the only thing the generator knows about it, so tests can
// stub it. Prompts hold client payloads, so nothing here logs a message or a response body, and error
// text never quotes them: a provider's error can echo the request.

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmCompletion {
  content: string | null;
  finishReason: string | null;
}

export interface Llm {
  /** Rejects with `LlmUnavailableError` if no answer came back, including when `signal` aborts, which is how calls time out. */
  complete(messages: readonly LlmMessage[], signal: AbortSignal): Promise<LlmCompletion>;
}

/** A rate limit, outage, timeout, or refused request. Worth trying again later, unlike a bad answer. */
export class LlmUnavailableError extends Error {
  constructor(
    message: string,
    /** How long the provider asked us to wait. */
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'LlmUnavailableError';
  }
}

export interface FireworksOptions {
  apiKey: string;
  model: string;
  reasoningEffort: string;
  maxTokens?: number;
  log: (message: string) => void;
}

const ENDPOINT = 'https://api.fireworks.ai/inference/v1/chat/completions';
/** Only a limit. With reasoning off most adapters use under 2,000 tokens, but large webhook payloads went past 8,000. */
const MAX_TOKENS = 16000;

function retryAfterMs(header: string | null): number | undefined {
  const seconds = Number(header ?? undefined);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}

export function createFireworksLlm(options: FireworksOptions): Llm {
  const { apiKey, model, reasoningEffort, maxTokens = MAX_TOKENS, log } = options;

  return {
    async complete(messages, signal) {
      let response: Response;
      let text: string;
      try {
        response = await fetch(ENDPOINT, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, max_tokens: maxTokens, reasoning_effort: reasoningEffort, messages }),
          signal,
        });
        text = await response.text();
      } catch (error) {
        throw new LlmUnavailableError(`Fireworks request failed: ${(error as Error).name}`);
      }
      if (!response.ok) {
        throw new LlmUnavailableError(
          `Fireworks returned ${response.status}`,
          retryAfterMs(response.headers.get('retry-after')),
        );
      }

      let json: FireworksReply;
      try {
        json = JSON.parse(text) as FireworksReply;
      } catch {
        throw new LlmUnavailableError('Fireworks returned a body that is not JSON');
      }
      const reasoning = json.usage?.completion_tokens_details?.reasoning_tokens ?? 0;
      if (reasoning > 0) log(`Fireworks spent ${reasoning} tokens reasoning, with reasoning_effort ${reasoningEffort}`);
      const choice = json.choices?.[0];
      return { content: choice?.message?.content ?? null, finishReason: choice?.finish_reason ?? null };
    },
  };
}

interface FireworksReply {
  choices?: { message?: { content?: string | null }; finish_reason?: string | null }[];
  usage?: { completion_tokens_details?: { reasoning_tokens?: number } };
}
