import { ANTHROPIC_DEFAULT_URL, AnthropicProvider } from './anthropic.js';
import { ClaudeCliProvider, detectClaudeBinary } from './claude-cli.js';
import type { BaseOptions } from './common.js';
import { OpenAICompatProvider, PROFILES, type CompatProfile, type ReasoningEffort } from './openai-compat.js';
import type { LlmProvider } from './provider.js';
import { priceFor } from './prices.js';

export const PROVIDER_IDS = ['openai', 'openrouter', 'gemini', 'anthropic', 'custom', 'claude-cli'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  needsKey: boolean;
  defaultBaseUrl: string;
  /** the base URL may be changed by the user (custom: required) */
  baseUrlEditable: boolean;
  experimental: boolean;
  /** where to get a key */
  keyHelpUrl: string;
  suggestedModels: string[];
}

export const PROVIDERS: ProviderInfo[] = [
  { id: 'openai', label: 'OpenAI', needsKey: true, defaultBaseUrl: PROFILES.openai.baseUrl, baseUrlEditable: false, experimental: false, keyHelpUrl: 'https://platform.openai.com/api-keys', suggestedModels: ['gpt-6.2-astra', 'gpt-6.2-sol', 'gpt-6.1-terra', 'gpt-6-luna'] },
  { id: 'anthropic', label: 'Anthropic', needsKey: true, defaultBaseUrl: ANTHROPIC_DEFAULT_URL, baseUrlEditable: false, experimental: false, keyHelpUrl: 'https://platform.claude.com/settings/keys', suggestedModels: ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5'] },
  { id: 'gemini', label: 'Google Gemini', needsKey: true, defaultBaseUrl: PROFILES.gemini.baseUrl, baseUrlEditable: false, experimental: false, keyHelpUrl: 'https://aistudio.google.com/apikey', suggestedModels: ['gemini-3.8-flash', 'gemini-3.1-pro-preview', 'gemini-3.5-flash-lite'] },
  { id: 'openrouter', label: 'OpenRouter', needsKey: true, defaultBaseUrl: PROFILES.openrouter.baseUrl, baseUrlEditable: false, experimental: false, keyHelpUrl: 'https://openrouter.ai/keys', suggestedModels: ['anthropic/claude-sonnet-5.5', 'google/gemini-3.8-flash', 'openai/gpt-6.2-sol'] },
  { id: 'custom', label: 'Custom OpenAI-compatible endpoint (local model)', needsKey: false, defaultBaseUrl: '', baseUrlEditable: true, experimental: false, keyHelpUrl: '', suggestedModels: [] },
  { id: 'claude-cli', label: 'My installed Claude Code (experimental)', needsKey: false, defaultBaseUrl: '', baseUrlEditable: false, experimental: true, keyHelpUrl: '', suggestedModels: ['haiku', 'sonnet', 'opus'] },
];

const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

/** One provider's saved settings. Never contains a key: `keyRef` names the entry in the secret store. */
export interface ProviderConfig {
  model: string;
  baseUrl?: string;
  maxTokens?: number;
  temperature?: number;
  reasoningEffort?: ReasoningEffort;
  /** capability-profile overrides for OpenAI-compatible providers */
  profile?: Partial<Pick<CompatProfile, 'tokenParam' | 'reasoning' | 'streamUsage'>>;
  concurrency?: number;
}

export interface LlmSettings {
  version: 1;
  active: ProviderId | null;
  providers: Partial<Record<ProviderId, ProviderConfig>>;
  claudeCli: { enabled: boolean; binary?: string };
}

export const emptyLlmSettings = (): LlmSettings => ({ version: 1, active: null, providers: {}, claudeCli: { enabled: false } });

/** the secret-store reference for a provider's API key */
export const keyRef = (id: ProviderId) => `provider:${id}`;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export function validateProviderConfig(id: ProviderId, v: unknown): ProviderConfig {
  if (!isObj(v)) throw new Error('provider settings must be an object');
  const model = typeof v.model === 'string' ? v.model.trim() : '';
  if (!model || model.length > 200 || /[\s\u0000-\u001f]/.test(model)) throw new Error('model must be a model id without spaces');
  const out: ProviderConfig = { model };
  if (v.baseUrl !== undefined && v.baseUrl !== '') {
    if (typeof v.baseUrl !== 'string') throw new Error('baseUrl must be a string');
    if (!PROVIDERS.find((p) => p.id === id)!.baseUrlEditable) throw new Error(`the ${id} provider uses a fixed address`);
    let u: URL;
    try { u = new URL(v.baseUrl); } catch { throw new Error('baseUrl is not a valid URL'); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('baseUrl must be http or https');
    if (u.username || u.password) throw new Error('put no credentials in the URL; use the key field');
    out.baseUrl = u.toString().replace(/\/+$/, '');
  }
  if (id === 'custom' && !out.baseUrl) throw new Error('the custom provider needs a base URL');
  const num = (k: 'maxTokens' | 'temperature' | 'concurrency', min: number, max: number, int: boolean) => {
    if (v[k] === undefined || v[k] === null || v[k] === '') return;
    const n = Number(v[k]);
    if (!Number.isFinite(n) || n < min || n > max || (int && !Number.isInteger(n))) throw new Error(`${k} must be ${int ? 'a whole number' : 'a number'} from ${min} to ${max}`);
    out[k] = n;
  };
  num('maxTokens', 256, 1_000_000, true); num('temperature', 0, 2, false); num('concurrency', 1, 4, true);
  if (v.reasoningEffort !== undefined && v.reasoningEffort !== '') {
    if (!(EFFORTS as readonly unknown[]).includes(v.reasoningEffort)) throw new Error(`reasoningEffort must be one of ${EFFORTS.join(', ')}`);
    out.reasoningEffort = v.reasoningEffort as ReasoningEffort;
  }
  if (v.profile !== undefined) {
    if (!isObj(v.profile)) throw new Error('profile must be an object');
    const p: NonNullable<ProviderConfig['profile']> = {};
    if (v.profile.tokenParam !== undefined) { if (v.profile.tokenParam !== 'max_tokens' && v.profile.tokenParam !== 'max_completion_tokens') throw new Error('profile.tokenParam is invalid'); p.tokenParam = v.profile.tokenParam; }
    if (v.profile.reasoning !== undefined) { if (!['reasoning_effort', 'reasoning_object', 'none'].includes(v.profile.reasoning as string)) throw new Error('profile.reasoning is invalid'); p.reasoning = v.profile.reasoning as CompatProfile['reasoning']; }
    if (v.profile.streamUsage !== undefined) { if (typeof v.profile.streamUsage !== 'boolean') throw new Error('profile.streamUsage must be true or false'); p.streamUsage = v.profile.streamUsage; }
    if (Object.keys(p).length) out.profile = p;
  }
  return out;
}

export function validateLlmSettings(v: unknown): LlmSettings {
  if (!isObj(v)) throw new Error('settings must be an object');
  const out = emptyLlmSettings();
  if (v.active !== null && v.active !== undefined) {
    if (!(PROVIDER_IDS as readonly unknown[]).includes(v.active)) throw new Error('unknown active provider');
    out.active = v.active as ProviderId;
  }
  if (isObj(v.providers)) for (const [id, cfg] of Object.entries(v.providers)) {
    if (!(PROVIDER_IDS as readonly string[]).includes(id)) throw new Error(`unknown provider "${id}"`);
    if (id === 'claude-cli') continue;
    out.providers[id as ProviderId] = validateProviderConfig(id as ProviderId, cfg);
  }
  if (isObj(v.claudeCli)) {
    out.claudeCli.enabled = v.claudeCli.enabled === true;
    if (typeof v.claudeCli.binary === 'string' && v.claudeCli.binary) {
      if (!v.claudeCli.binary.startsWith('/') || /[\u0000-\u001f]/.test(v.claudeCli.binary)) throw new Error('the Claude Code path must be absolute');
      out.claudeCli.binary = v.claudeCli.binary;
    }
  }
  return out;
}

export interface CreateOptions extends BaseOptions {
  apiKey?: string;
  /** Claude CLI model alias comes from `model` */
  env?: NodeJS.ProcessEnv;
}

/** Builds the provider for `id` from saved settings. Throws a plain Error with a user-facing message when something required is missing. */
export function createProvider(id: ProviderId, settings: LlmSettings, o: CreateOptions = {}): LlmProvider {
  if (id === 'claude-cli') {
    if (!settings.claudeCli.enabled) throw new Error('The Claude Code connector is switched off. Turn it on in the settings first.');
    const binary = detectClaudeBinary({ explicit: settings.claudeCli.binary });
    if (!binary) throw new Error('Claude Code was not found on this computer.');
    return new ClaudeCliProvider({ ...o, binary, model: settings.providers['claude-cli']?.model ?? 'sonnet' });
  }
  const cfg = settings.providers[id];
  if (!cfg) throw new Error(`The ${id} provider is not set up yet.`);
  const info = PROVIDERS.find((p) => p.id === id)!;
  if (info.needsKey && !o.apiKey) throw new Error(`No API key is saved for ${info.label}.`);
  const known = priceFor(id, cfg.model);
  const common = { ...o, concurrency: cfg.concurrency ?? o.concurrency };
  if (id === 'anthropic') {
    return new AnthropicProvider({ ...common, model: cfg.model, apiKey: o.apiKey!, ...(cfg.maxTokens ? { maxTokens: cfg.maxTokens } : {}), ...(known?.maxOutput ? { modelMaxOutput: known.maxOutput } : {}), ...(cfg.temperature !== undefined ? { temperature: cfg.temperature } : {}),
      ...(cfg.reasoningEffort && cfg.reasoningEffort !== 'none' && cfg.reasoningEffort !== 'minimal' ? { effort: cfg.reasoningEffort } : {}) });
  }
  return new OpenAICompatProvider({ ...common, profile: id, model: cfg.model, apiKey: o.apiKey, baseUrl: cfg.baseUrl, overrides: cfg.profile, maxTokens: cfg.maxTokens, temperature: cfg.temperature, reasoningEffort: cfg.reasoningEffort, modelMaxOutput: known?.maxOutput });
}

/** Settings seed for a developer who sets a local endpoint through the environment (no home-network defaults: nothing is assumed). */
export function settingsFromEnv(env: NodeJS.ProcessEnv = process.env): LlmSettings | null {
  const url = env.CMC_LLM_URL?.trim(), model = env.CMC_LLM_MODEL?.trim();
  if (!url || !model) return null;
  return { ...emptyLlmSettings(), active: 'custom', providers: { custom: { model, baseUrl: url.replace(/\/chat\/completions\/?$/, '') } } };
}
