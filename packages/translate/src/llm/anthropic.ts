import { BaseProvider, LlmError, redactHeaders, streamSse, type Attempt, type BaseOptions } from './common.js';
import type { ChatMessage, ChatOptions } from './provider.js';

export const ANTHROPIC_VERSION = '2023-06-01';
export const ANTHROPIC_DEFAULT_URL = 'https://api.anthropic.com';

export interface AnthropicOptions extends BaseOptions {
  model: string;
  apiKey: string;
  baseUrl?: string;
  /** required by the Messages API; clamped to `modelMaxOutput` when that is known */
  maxTokens?: number;
  modelMaxOutput?: number;
  /** `output_config.effort` (Claude 4.6+ models); omitted when unset */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** sent only when set: the current Claude models reject non-default sampling parameters */
  temperature?: number;
}

/** Anthropic Messages API client (raw HTTP + SSE, no SDK): x-api-key, anthropic-version, top-level `system`, required max_tokens. */
export class AnthropicProvider extends BaseProvider {
  readonly name: string;
  private apiKey: string;
  private url: string;
  constructor(private o: AnthropicOptions) {
    super(o);
    if (!o.apiKey) throw new Error('an Anthropic API key is required');
    this.apiKey = o.apiKey;
    this.url = `${(o.baseUrl ?? ANTHROPIC_DEFAULT_URL).replace(/\/+$/, '').replace(/\/v1\/messages$/, '')}/v1/messages`;
    this.name = `anthropic:${o.model}`;
  }

  buildBody(messages: ChatMessage[], co: ChatOptions = {}): Record<string, unknown> {
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    // the API wants alternating user/assistant turns; merge consecutive same-role messages
    const turns: { role: 'user' | 'assistant'; content: string }[] = [];
    for (const m of messages) {
      if (m.role === 'system') continue;
      const last = turns[turns.length - 1];
      if (last && last.role === m.role) last.content += `\n\n${m.content}`; else turns.push({ role: m.role, content: m.content });
    }
    let cap = co.maxTokens ?? this.o.maxTokens ?? 32000;
    if (this.o.modelMaxOutput) cap = Math.min(cap, this.o.modelMaxOutput);
    const temp = co.temperature ?? this.o.temperature;
    return {
      model: this.o.model, max_tokens: cap, stream: true,
      ...(system ? { system } : {}),
      messages: turns,
      ...(temp !== undefined ? { temperature: temp } : {}),
      ...(this.o.effort ? { output_config: { effort: this.o.effort } } : {}),
    };
  }
  protected logBody(m: ChatMessage[], co: ChatOptions) { return this.buildBody(m, co); }
  headers(): Record<string, string> { return { 'x-api-key': this.apiKey, 'anthropic-version': ANTHROPIC_VERSION }; }
  safeHeaders() { return redactHeaders(this.headers()); }

  protected async attempt(messages: ChatMessage[], co: ChatOptions, signal: AbortSignal | undefined, readTimeoutMs: number): Promise<Attempt> {
    let content = '', reasoningChars = 0, finish: string | null = null, tokensIn = 0, tokensOut = 0, model: string | undefined;
    let err: { type?: string; message?: string } | null = null;
    await streamSse(this.url, { headers: this.headers(), body: this.buildBody(messages, co) }, signal, readTimeoutMs, (ev) => {
      let j: any;
      try { j = JSON.parse(ev.data); } catch { return; }
      switch (j.type ?? ev.event) {
        case 'message_start': {
          const u = j.message?.usage ?? {};
          // cache reads/writes are input tokens too
          tokensIn = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
          tokensOut = u.output_tokens ?? 0;
          if (typeof j.message?.model === 'string') model = j.message.model;
          break;
        }
        case 'content_block_delta':
          if (j.delta?.type === 'text_delta') content += j.delta.text ?? '';
          else if (j.delta?.type === 'thinking_delta') reasoningChars += (j.delta.thinking ?? '').length;
          break;
        case 'message_delta':
          if (j.delta?.stop_reason) finish = j.delta.stop_reason;
          if (j.usage?.output_tokens !== undefined) tokensOut = j.usage.output_tokens;
          if (j.usage?.input_tokens) tokensIn = j.usage.input_tokens + (j.usage.cache_creation_input_tokens ?? 0) + (j.usage.cache_read_input_tokens ?? 0);
          break;
        case 'error': err = j.error ?? { message: 'stream error' }; break;
        default: break; // ping, content_block_start/stop, message_stop
      }
    });
    if (err) {
      const e = err as { type?: string; message?: string };
      const retry = e.type === 'overloaded_error' || e.type === 'api_error' || e.type === 'rate_limit_error';
      throw new LlmError(e.type === 'authentication_error' ? 'auth' : retry ? 'server' : 'bad_request', `the provider reported an error mid-stream: ${String(e.message ?? e.type).slice(0, 200)}`, undefined, retry);
    }
    if (finish === 'refusal') throw new LlmError('refused', 'the model declined this request (stop_reason: refusal)', undefined, false);
    return { content, reasoningChars, finish, tokensIn, tokensOut, ...(model ? { model } : {}) };
  }

  /** GET /v1/models?limit=1: cheapest check that the key works. */
  async listModels(signal?: AbortSignal): Promise<string[]> {
    const { errorFromStatus } = await import('./common.js');
    let res: Response;
    try { res = await fetch(this.url.replace(/\/messages$/, '/models?limit=100'), { headers: this.headers(), signal: signal ?? AbortSignal.timeout(10_000) }); }
    catch (e) { throw new LlmError('network', `could not reach the Anthropic API: ${(e as Error).message}`, undefined, true); }
    if (!res.ok) throw errorFromStatus(res.status, await res.text().catch(() => ''));
    const j: any = await res.json().catch(() => ({}));
    return (j.data ?? []).map((m: any) => String(m.id)).filter(Boolean);
  }
}
