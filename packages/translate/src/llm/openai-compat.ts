import { BaseProvider, LlmError, redactHeaders, redactUrl, streamSse, type Attempt, type BaseOptions } from './common.js';
import type { ChatMessage, ChatOptions } from './provider.js';

export type CompatProfileId = 'openai' | 'openrouter' | 'gemini' | 'custom';
export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** What one OpenAI-compatible endpoint accepts. Every field can be overridden per provider in the settings. */
export interface CompatProfile {
  id: CompatProfileId;
  /** base URL without the `/chat/completions` suffix */
  baseUrl: string;
  /** which request parameter carries the output cap */
  tokenParam: 'max_tokens' | 'max_completion_tokens';
  /** how reasoning depth is requested: top-level `reasoning_effort`, OpenRouter's `reasoning: {effort}` object, or not at all */
  reasoning: 'reasoning_effort' | 'reasoning_object' | 'none';
  /** reasoning effort sent when the caller does not choose one (undefined = leave the model's default) */
  defaultReasoningEffort?: ReasoningEffort;
  /** temperature sent when the caller does not choose one (undefined = omit; reasoning models may reject non-default values) */
  defaultTemperature?: number;
  defaultMaxTokens: number;
  /** ask for token usage in the final stream chunk */
  streamUsage: boolean;
  /** extra static request headers (never credentials) */
  headers: Record<string, string>;
}

export const PROFILES: Record<CompatProfileId, CompatProfile> = {
  // https://developers.openai.com/api/reference/resources/chat : `max_tokens` is deprecated and incompatible with o-series, use max_completion_tokens.
  openai: { id: 'openai', baseUrl: 'https://api.openai.com/v1', tokenParam: 'max_completion_tokens', reasoning: 'reasoning_effort', defaultMaxTokens: 32000, streamUsage: true, headers: {} },
  // https://openrouter.ai/docs/use-cases/reasoning-tokens : unified `reasoning` object; usage (incl. cost) arrives in the last chunk without a request flag.
  openrouter: { id: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', tokenParam: 'max_tokens', reasoning: 'reasoning_object', defaultMaxTokens: 32000, streamUsage: true, headers: {} },
  // https://aistudio.google.com/docs/openai : OpenAI-compatible endpoint; the page does not name the token parameter (max_tokens assumed, unverified).
  gemini: { id: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', tokenParam: 'max_tokens', reasoning: 'reasoning_effort', defaultMaxTokens: 32000, streamUsage: true, headers: {} },
  // a local or self-hosted server (vLLM, llama.cpp, Ollama, LM Studio, ...): the profile the pipeline was tuned on.
  custom: { id: 'custom', baseUrl: '', tokenParam: 'max_tokens', reasoning: 'reasoning_effort', defaultReasoningEffort: 'low', defaultTemperature: 0.2, defaultMaxTokens: 32000, streamUsage: true, headers: {} },
};

export interface OpenAICompatOptions extends BaseOptions {
  profile: CompatProfileId;
  model: string;
  /** API key; sent as `Authorization: Bearer` and nowhere else. Optional for local servers. */
  apiKey?: string;
  /** overrides the profile's base URL. A trailing `/chat/completions` is accepted and stripped. */
  baseUrl?: string;
  /** overrides for individual profile fields */
  overrides?: Partial<Omit<CompatProfile, 'id'>>;
  maxTokens?: number;
  temperature?: number;
  /** 'none' on a profile that sends reasoning parameters means: send none */
  reasoningEffort?: ReasoningEffort;
  /** merged last into the request body (escape hatch for provider-specific parameters) */
  extraBody?: Record<string, unknown>;
  /** output cap known for this model (from prices.json); requests asking for more are clamped */
  modelMaxOutput?: number;
}

export const normaliseBaseUrl = (u: string) => u.trim().replace(/\/+$/, '').replace(/\/chat\/completions$/, '');

/** Streaming client for every OpenAI-compatible chat-completions endpoint, steered by a capability profile. */
export class OpenAICompatProvider extends BaseProvider {
  readonly name: string;
  readonly profile: CompatProfile;
  readonly model: string;
  readonly opts: { url: string; model: string; maxTokens: number; temperature: number | undefined; reasoningEffort: ReasoningEffort | undefined; concurrency: number; readTimeoutMs: number; retries: number };
  private apiKey: string | undefined;
  private extraBody: Record<string, unknown> | undefined;
  private modelMaxOutput: number | undefined;

  constructor(o: OpenAICompatOptions) {
    super(o);
    const base = PROFILES[o.profile];
    this.profile = { ...base, ...o.overrides, id: base.id };
    const root = normaliseBaseUrl(o.baseUrl ?? this.profile.baseUrl);
    if (!root) throw new Error('a base URL is required for this provider');
    this.model = o.model;
    this.apiKey = o.apiKey || undefined;
    this.extraBody = o.extraBody;
    this.modelMaxOutput = o.modelMaxOutput;
    this.opts = {
      url: `${root}/chat/completions`, model: o.model,
      maxTokens: o.maxTokens ?? this.profile.defaultMaxTokens,
      temperature: o.temperature ?? this.profile.defaultTemperature,
      reasoningEffort: o.reasoningEffort ?? this.profile.defaultReasoningEffort,
      concurrency: this.base.concurrency, readTimeoutMs: this.base.readTimeoutMs, retries: this.base.retries,
    };
    this.name = `${o.profile}:${o.model}`;
  }

  /** The JSON body for one call. Exported through the class for tests. */
  buildBody(messages: ChatMessage[], co: ChatOptions = {}): Record<string, unknown> {
    const p = this.profile;
    let cap = co.maxTokens ?? this.opts.maxTokens;
    if (this.modelMaxOutput) cap = Math.min(cap, this.modelMaxOutput);
    const body: Record<string, unknown> = { model: this.model, messages, [p.tokenParam]: cap, stream: true };
    const temp = co.temperature ?? this.opts.temperature;
    if (temp !== undefined) body.temperature = temp;
    if (p.streamUsage) body.stream_options = { include_usage: true };
    const eff = this.opts.reasoningEffort;
    if (eff && !(eff === 'none' && p.id === 'custom')) {
      if (p.reasoning === 'reasoning_effort') body.reasoning_effort = eff;
      else if (p.reasoning === 'reasoning_object') body.reasoning = { effort: eff };
    }
    return { ...body, ...this.extraBody };
  }

  protected logBody(messages: ChatMessage[], co: ChatOptions) { return this.buildBody(messages, co); }

  /** Headers for one call (the only place the key is used). */
  headers(): Record<string, string> {
    return { ...this.profile.headers, ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) };
  }
  /** headers with credentials replaced, for diagnostics */
  safeHeaders() { return redactHeaders(this.headers()); }
  safeUrl() { return redactUrl(this.opts.url); }

  protected async attempt(messages: ChatMessage[], co: ChatOptions, signal: AbortSignal | undefined, readTimeoutMs: number): Promise<Attempt> {
    let content = '', reasoningChars = 0, finish: string | null = null, tokensIn = 0, tokensOut = 0, model: string | undefined, cost: number | undefined;
    let streamError: string | null = null;
    await streamSse(this.opts.url, { headers: this.headers(), body: this.buildBody(messages, co) }, signal, readTimeoutMs, (ev) => {
      if (ev.data.trim() === '[DONE]') return;
      let j: any;
      try { j = JSON.parse(ev.data); } catch { return; }
      if (j.error) { streamError = typeof j.error === 'string' ? j.error : (j.error.message ?? 'stream error'); return; }
      if (typeof j.model === 'string') model = j.model;
      if (j.usage) {
        tokensIn = j.usage.prompt_tokens ?? tokensIn; tokensOut = j.usage.completion_tokens ?? tokensOut;
        if (typeof j.usage.cost === 'number') cost = j.usage.cost;
      }
      for (const ch of j.choices ?? []) {
        const dl = ch.delta ?? {};
        if (dl.content) content += dl.content;
        const rc = dl.reasoning ?? dl.reasoning_content;
        if (typeof rc === 'string') reasoningChars += rc.length;
        if (ch.finish_reason) finish = ch.finish_reason;
      }
    });
    if (streamError) throw new LlmError('server', `the provider reported an error mid-stream: ${String(streamError).slice(0, 200)}`, undefined, true);
    return { content, reasoningChars, finish, tokensIn, tokensOut, ...(model ? { model } : {}), ...(cost !== undefined ? { reportedCostUsd: cost } : {}) };
  }

  /** Cheapest reachability + key check: GET <base>/models. */
  async listModels(signal?: AbortSignal): Promise<string[]> {
    const root = this.opts.url.replace(/\/chat\/completions$/, '');
    let res: Response;
    try { res = await fetch(`${root}/models`, { headers: this.headers(), signal: signal ?? AbortSignal.timeout(10_000) }); }
    catch (e) { throw new LlmError('network', `could not reach ${redactUrl(root)}: ${(e as Error).message}`, undefined, true); }
    if (!res.ok) { const { errorFromStatus } = await import('./common.js'); throw errorFromStatus(res.status, await res.text().catch(() => '')); }
    const j: any = await res.json().catch(() => ({}));
    return (Array.isArray(j.data) ? j.data : Array.isArray(j.models) ? j.models : []).map((m: any) => String(m.id ?? m.name ?? '')).filter(Boolean);
  }
}
