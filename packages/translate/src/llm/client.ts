import { Semaphore, MAX_CONCURRENCY } from './common.js';
import { OpenAICompatProvider, normaliseBaseUrl, type ReasoningEffort } from './openai-compat.js';
import type { ChatMessage, ChatOptions, ChatResult, LlmProvider } from './provider.js';

export { Semaphore, MAX_CONCURRENCY };

export interface LocalModelOptions {
  /** full chat-completions URL or its base. Default: CMC_LLM_URL. There is no built-in address. */
  url?: string;
  /** default: CMC_LLM_MODEL */
  model?: string;
  apiKey?: string;
  maxTokens?: number;
  temperature?: number;
  reasoningEffort?: ReasoningEffort;
  concurrency?: number;
  readTimeoutMs?: number;
  retries?: number;
  retryBaseMs?: number;
  logDir?: string;
  extraBody?: Record<string, unknown>;
}

/** Client for a local / self-hosted OpenAI-compatible server (the `custom` profile). Used by the CLI; the app uses the registry. */
export class LocalModelClient extends OpenAICompatProvider {
  constructor(o: LocalModelOptions = {}) {
    const url = o.url ?? process.env.CMC_LLM_URL;
    const model = o.model ?? process.env.CMC_LLM_MODEL;
    if (!url || !model) throw new Error('No model endpoint is configured: set CMC_LLM_URL and CMC_LLM_MODEL (an OpenAI-compatible server), or use the app\'s settings.');
    super({ profile: 'custom', baseUrl: normaliseBaseUrl(url), model, apiKey: o.apiKey, maxTokens: o.maxTokens, temperature: o.temperature, reasoningEffort: o.reasoningEffort, concurrency: o.concurrency, readTimeoutMs: o.readTimeoutMs, retries: o.retries, retryBaseMs: o.retryBaseMs, logDir: o.logDir, extraBody: o.extraBody });
  }
}

/** Provider for tests: answers from a function. */
export class ScriptedProvider implements LlmProvider {
  readonly name = 'scripted';
  private u = { requests: 0, tokensIn: 0, tokensOut: 0, modelSecs: 0 };
  constructor(private fn: (messages: ChatMessage[], opts?: ChatOptions) => string | Promise<string>) {}
  async chat(messages: ChatMessage[], opts?: ChatOptions): Promise<ChatResult> {
    const content = await this.fn(messages, opts);
    this.u.requests++;
    return { content, tokensIn: 0, tokensOut: 0, reasoningChars: 0, finish: 'stop', secs: 0 };
  }
  usage() { return { ...this.u }; }
}
