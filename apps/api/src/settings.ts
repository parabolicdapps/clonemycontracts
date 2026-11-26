import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ClaudeCliProvider, LlmError, OpenAICompatProvider, AnthropicProvider, PROVIDERS, appPaths, createProvider, detectClaudeBinary, emptyLlmSettings, estimateCost, keyRef,
  loadPrices, settingsFromEnv, validateLlmSettings, validateProviderConfig, type AppPaths, type LlmProvider, type LlmSettings, type ProviderId,
} from '@cmc/translate';
import { HttpError } from './errors.js';
import type { SecretStore } from './secrets.js';

/** Version of the first-run acknowledgement text shown by the web UI. Bump it when the text changes and everyone is asked again. */
export const ACK_VERSION = 1;

export interface Ack { version: number; at: string }
interface Stored { llm: LlmSettings; ack?: Ack }

/** One JSON file in the config directory, mode 0600, never containing a key. */
export class SettingsStore {
  private data: Stored;
  constructor(private dir: string) {
    this.data = { llm: emptyLlmSettings() };
    try {
      const j = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'));
      this.data = { llm: validateLlmSettings(j.llm ?? {}), ...(j.ack && typeof j.ack.version === 'number' ? { ack: { version: j.ack.version, at: String(j.ack.at ?? '') } } : {}) };
    } catch { /* first run or unreadable: defaults */ }
  }
  get llm() { return this.data.llm; }
  get ack() { return this.data.ack; }
  update(f: (d: Stored) => void) {
    f(this.data);
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const p = join(this.dir, 'settings.json'), tmp = `${p}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 1), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, p);
  }
}

export interface TestResult { ok: boolean; message: string; models?: string[]; modelListed?: boolean; ms: number }

/** Plain-language text for a provider failure; never the raw provider body (which can echo a key fragment). */
export function plainLlmError(e: unknown): string {
  if (e instanceof LlmError) {
    switch (e.kind) {
      case 'auth': return 'The provider rejected the key. Check that it is correct and still active.';
      case 'rate_limit': return 'The provider says you are sending too many requests or are out of quota.';
      case 'not_found': return 'The provider does not know that address or model.';
      case 'bad_request': return `The provider refused the request (${e.status ?? 400}).`;
      case 'network': case 'timeout': return 'Could not reach the provider. Check the address and your connection.';
      case 'unavailable': return e.message;
      case 'refused': return 'The model declined the request.';
      default: return 'The provider had a problem. Try again in a moment.';
    }
  }
  return e instanceof Error ? e.message : 'Unexpected error.';
}

/** Provider settings, keys, acknowledgement. The only place that reads keys out of the secret store. */
export class SettingsService {
  constructor(readonly store: SettingsStore, readonly secrets: SecretStore, readonly paths: AppPaths = appPaths(), private env: NodeJS.ProcessEnv = process.env) {}

  /** the settings in effect: saved ones, else a developer's CMC_LLM_URL/CMC_LLM_MODEL pair */
  effective(): LlmSettings { return this.store.llm.active ? this.store.llm : (settingsFromEnv(this.env) ?? this.store.llm); }

  async view() {
    const s = this.store.llm;
    const cliBin = detectClaudeBinary({ explicit: s.claudeCli.binary });
    return {
      active: s.active,
      providers: await Promise.all(PROVIDERS.map(async (p) => ({
        ...p, configured: p.id === 'claude-cli' ? s.claudeCli.enabled : !!s.providers[p.id], settings: s.providers[p.id] ?? null,
        hasKey: p.needsKey ? await this.secrets.has(keyRef(p.id)) : false,
      }))),
      claudeCli: { enabled: s.claudeCli.enabled, binary: s.claudeCli.binary ?? null, detected: cliBin },
      secretStore: { kind: this.secrets.kind, notice: this.secrets.notice },
      prices: { asOf: loadPrices().asOf, note: 'Prices are list prices copied by hand and may be stale.' },
      ack: { current: ACK_VERSION, accepted: this.store.ack ?? null, needed: this.store.ack?.version !== ACK_VERSION },
      paths: { data: this.paths.data, cache: this.paths.cache, config: this.paths.config },
    };
  }

  async saveProvider(id: ProviderId, body: { config?: unknown; key?: unknown; clearKey?: unknown }) {
    if (id === 'claude-cli') throw new HttpError(400, 'INPUT', 'Use the Claude Code switch for that connector.');
    const info = PROVIDERS.find((p) => p.id === id)!;
    let cfg;
    try { cfg = validateProviderConfig(id, body.config); } catch (e) { throw new HttpError(400, 'INPUT', (e as Error).message); }
    if (body.key !== undefined && body.key !== '') {
      if (!info.needsKey && id !== 'custom') throw new HttpError(400, 'INPUT', 'This provider takes no key.');
      if (typeof body.key !== 'string' || body.key.length < 8 || body.key.length > 400 || /[\s\u0000-\u001f]/.test(body.key)) throw new HttpError(400, 'INPUT', 'That does not look like an API key.');
      await this.secrets.set(keyRef(id), body.key);
    }
    if (body.clearKey === true) await this.secrets.delete(keyRef(id));
    this.store.update((d) => { d.llm.providers[id] = cfg; if (!d.llm.active) d.llm.active = id; });
  }

  setActive(id: ProviderId | null) {
    const s = this.store.llm;
    if (id === 'claude-cli' ? !s.claudeCli.enabled : id !== null && !s.providers[id]) throw new HttpError(400, 'INPUT', 'Set that provider up first.');
    this.store.update((d) => { d.llm.active = id; });
  }

  setClaudeCli(body: { enabled?: unknown; binary?: unknown; model?: unknown }) {
    let v: LlmSettings;
    try { v = validateLlmSettings({ claudeCli: { enabled: body.enabled === true, binary: body.binary || undefined } }); } catch (e) { throw new HttpError(400, 'INPUT', (e as Error).message); }
    const model = typeof body.model === 'string' && /^[a-z0-9._-]{1,60}$/i.test(body.model) ? body.model : this.store.llm.providers['claude-cli']?.model ?? 'sonnet';
    this.store.update((d) => {
      d.llm.claudeCli = v.claudeCli;
      d.llm.providers['claude-cli'] = { model };
      if (!v.claudeCli.enabled && d.llm.active === 'claude-cli') d.llm.active = null;
    });
  }

  acknowledge(version: unknown) {
    if (version !== ACK_VERSION) throw new HttpError(400, 'INPUT', 'That acknowledgement is out of date; reload the page.');
    this.store.update((d) => { d.ack = { version: ACK_VERSION, at: new Date().toISOString() }; });
  }

  /** A provider ready to call: the active one (or `id`). Throws a plain Error when nothing usable is set up. */
  async provider(o: { id?: ProviderId; logDir?: string; concurrency?: number } = {}): Promise<{ provider: LlmProvider; id: ProviderId; model: string }> {
    const settings = this.effective();
    const id = o.id ?? settings.active;
    if (!id) throw new Error('No AI provider is set up yet. Open the settings and choose one.');
    const apiKey = id === 'claude-cli' ? undefined : await this.secrets.get(keyRef(id));
    const provider = createProvider(id, settings, { apiKey, logDir: o.logDir, ...(o.concurrency ? { concurrency: o.concurrency } : {}) });
    return { provider, id, model: settings.providers[id]?.model ?? (id === 'claude-cli' ? 'sonnet' : '') };
  }

  /** Cheap check: lists models with the saved (or just-entered, unsaved) settings. `deep` also sends a 1-sentence prompt (costs a few tokens). */
  async test(id: ProviderId, draft: { config?: unknown; key?: unknown } = {}, deep = false): Promise<TestResult> {
    const t0 = Date.now();
    const done = (ok: boolean, message: string, extra: Partial<TestResult> = {}): TestResult => ({ ok, message, ms: Date.now() - t0, ...extra });
    try {
      if (id === 'claude-cli') {
        const s = this.store.llm;
        const bin = detectClaudeBinary({ explicit: s.claudeCli.binary });
        if (!bin) return done(false, 'Claude Code was not found on this computer.');
        const v = await ClaudeCliProvider.version(bin);
        if (!deep) return done(!!v, v ? `Found Claude Code ${v}. Use "Test with a message" to check that you are logged in.` : 'Found a program at that path but it did not report a version.');
        const p = new ClaudeCliProvider({ binary: bin, model: s.providers['claude-cli']?.model ?? 'haiku', timeoutMs: 120_000 });
        const r = await p.chat([{ role: 'user', content: 'Reply with the single word OK.' }]);
        return done(true, `Claude Code answered (${r.tokensIn} in / ${r.tokensOut} out).`);
      }
      const settings: LlmSettings = { ...this.store.llm, providers: { ...this.store.llm.providers } };
      if (draft.config !== undefined) settings.providers[id] = validateProviderConfig(id, draft.config);
      const apiKey = typeof draft.key === 'string' && draft.key ? draft.key : await this.secrets.get(keyRef(id));
      const provider = createProvider(id, settings, { apiKey, retries: 0, readTimeoutMs: 30_000 });
      const model = settings.providers[id]!.model;
      const models = await (provider as OpenAICompatProvider | AnthropicProvider).listModels();
      const listed = models.length ? models.some((m) => m === model || m === `models/${model}` || m.endsWith(`/${model}`)) : undefined;
      let msg = `Connected${models.length ? ` (${models.length} models available)` : ''}.`;
      if (listed === false) msg += ` The model "${model}" is not in that list; check its spelling.`;
      if (deep) {
        const r = await provider.chat([{ role: 'user', content: 'Reply with the single word OK.' }], { maxTokens: 256 });
        const c = estimateCost(id, model, r.tokensIn, r.tokensOut, r.reportedCostUsd);
        msg += ` The model answered (${r.tokensIn} in / ${r.tokensOut} out${c.usd !== null ? `, about $${c.usd.toFixed(5)}` : ''}).`;
      }
      return done(listed !== false, msg, { models: models.slice(0, 50), ...(listed !== undefined ? { modelListed: listed } : {}) });
    } catch (e) {
      if (e instanceof LlmError && e.kind === 'not_found' && id === 'custom') return done(true, 'The server answered but has no model list (that is normal for some local servers). Use "Test with a message" to check the model.');
      return done(false, plainLlmError(e));
    }
  }
}
