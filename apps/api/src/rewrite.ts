import { CmcError } from '@cmc/core';
import {
  APTOS_CONTAINER, AptosPack, COSMWASM_CONTAINER, CosmWasmPack, DEFAULT_CONTAINER, OpenAICompatProvider, SolanaPack, TEZOS_CONTAINER, TezosPack,
  analyseForRewrite, classifyStandard, describeTarget, estimateCost, resolveAdapter, resolveImage, rewrite, RewriteCancelled, UnsupportedSourceError,
  type RewriteReport, type RuntimeStatus, type TargetInfo, type TargetPack,
} from '@cmc/translate';
import type { SettingsService } from './settings.js';

export { RewriteCancelled };

/** The extracted spec disagrees with the contract's ABI: the pipeline would stop with an UNVERIFIED report and generate nothing, so planning refuses up front. */
export class SpecMismatch extends Error {
  constructor(public problems: string[]) { super(`This contract could not be analysed reliably, so nothing would be generated: ${problems.slice(0, 3).join('; ')}${problems.length > 3 ? `; and ${problems.length - 3} more` : ''}`); }
}

export const SPEC_GATE_FAILED = 'spec sanity gate';
export type { TargetInfo };

export interface RewritePlanInfo {
  contract: string;
  /** which path the pipeline will take for this contract */
  path: 'template' | 'model';
  /** the standard a template path implements (null on the model path) */
  standard: string | null;
  /** why it is not a plain standard (model path) */
  reasons: string[];
  functions: string[];
  /** generation units (model path) */
  units: string[];
  designNotes: string[];
  notTranslated: { feature: string; where: string; reason: string }[];
  nonPortable: { id: string; title: string; where: string[]; treatment: string; detail: string }[];
  decimalsNote: string | null;
}

export interface RewriteHealth {
  ok: boolean;
  model: { ok: boolean; message: string };
  sandbox: { ok: boolean; message: string };
  /** per target id: its toolchain image is present on the container runtime */
  images: Record<string, boolean>;
  /** the full runtime status (not installed / not running / ready, version, limits, guidance links) */
  runtime?: RuntimeStatus;
  /** target id -> the image reference that would be pulled */
  imageRefs?: Record<string, string>;
}

export interface RewriteRequest { address: `0x${string}`; from: string; to: string }
export interface RewriteRunOptions {
  outDir: string; signal: AbortSignal; onProgress: (line: string) => void;
  /** wall-clock budget: the pipeline should stop itself and return its best result before the hard cap cancels it */
  budgetMs?: number;
  /** the pipeline's best-so-far result after the first compile and every behaviour round; the API keeps its report if the run is stopped */
  onCheckpoint?: (report: RewriteReport) => void;
}
export interface RewriteOutcome { status: string; report: RewriteReport }

/** What the API needs from the rewrite pipeline; tests inject a fake. */
export interface RewriteBackend {
  targets(): TargetInfo[];
  health(): Promise<RewriteHealth>;
  plan(req: RewriteRequest, chainId: number): Promise<RewritePlanInfo>;
  run(req: RewriteRequest, o: RewriteRunOptions): Promise<RewriteOutcome>;
}

const PACKS: Record<string, () => TargetPack<any>> = {
  solana: () => new SolanaPack(),
  cosmwasm: () => new CosmWasmPack(),
  aptos: () => new AptosPack(),
  tezos: () => new TezosPack(),
};
const IMAGE: Record<string, string> = { solana: DEFAULT_CONTAINER.image, cosmwasm: COSMWASM_CONTAINER.image, aptos: APTOS_CONTAINER.image, tezos: TEZOS_CONTAINER.image };
/** the fully qualified image reference a target runs (and a first-run download pulls) */
export const imageRef = (id: string) => resolveImage(IMAGE[id]!);
export const TARGET_IDS = Object.keys(PACKS);

/** Remove anything that names a home-network machine, an account or a path from text that goes to the browser. */
export function sanitize(text: string): string {
  return text
    .replace(/connect to host \S+( port \d+)?/gi, 'connect to the build host')
    .replace(/\bssh\b:?/gi, 'remote shell')
    .replace(/\b[\w.-]+@(?:\d{1,3}\.){3}\d{1,3}\b/g, 'the build host')
    .replace(/\b[\w.-]+@[\w.-]+\.(?:local|lan|home)\b/gi, 'the build host')
    .replace(/https?:\/\/(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?[^\s)'"]*/g, 'the model service')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, 'a local host')
    .replace(/\/home\/[\w.-]+(?:\/[^\s)'":]*)?/g, 'a work directory')
    .replace(/\/Users\/[\w.-]+(?:\/[^\s)'":]*)?/g, 'a work directory')
    .replace(/\/tmp\/[^\s)'":]*/g, 'a work directory');
}

export function sanitizeDeep<T>(v: T): T {
  if (typeof v === 'string') return sanitize(v) as T;
  if (Array.isArray(v)) return v.map(sanitizeDeep) as T;
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, sanitizeDeep(x)])) as T;
  return v;
}

/** A plain-language message for a failure of the pipeline, never the raw text (which can hold hosts or ssh output). */
export function plainRewriteError(e: unknown): { code: string; message: string } {
  if (e instanceof RewriteCancelled) return { code: 'CANCELLED', message: 'The rewrite was cancelled.' };
  if (e instanceof UnsupportedSourceError) return { code: 'UNSUPPORTED', message: sanitize(e.message) };
  if (e instanceof CmcError) return { code: e.code, message: sanitize(e.message) };
  const m = e instanceof Error ? e.message : String(e);
  if (/model call failed|llm|read timeout|no data for/i.test(m)) return { code: 'MODEL', message: 'The language model service did not answer. Try again in a moment.' };
  if (/ssh|docker|upload failed|ECONNREFUSED|connect to host|toolchain/i.test(m)) return { code: 'SANDBOX', message: 'The build sandbox could not be reached or failed. Try again in a moment.' };
  if (/anvil/i.test(m)) return { code: 'INTERNAL', message: 'The local chain used to record the original behaviour could not start.' };
  return { code: 'INTERNAL', message: 'The rewrite failed unexpectedly.' };
}

async function checkModel(settings: SettingsService): Promise<{ ok: boolean; message: string }> {
  const eff = settings.effective();
  const id = eff.active;
  if (!id) return { ok: false, message: 'No AI provider is set up yet. Open the settings and choose one.' };
  if (id === 'claude-cli') return eff.claudeCli.enabled ? { ok: true, message: 'Using your installed Claude Code (experimental).' } : { ok: false, message: 'The Claude Code connector is switched off.' };
  try {
    const { provider } = await settings.provider({ id });
    if (provider instanceof OpenAICompatProvider && id === 'custom') {
      try { await provider.listModels(AbortSignal.timeout(4000)); } catch (e) {
        // a local server without /models is fine; one that cannot be reached is not
        if (!(e instanceof Error && /HTTP 404|HTTP 405/.test(e.message))) return { ok: false, message: 'The local model server is not reachable right now.' };
      }
    }
    return { ok: true, message: `Using ${id}.` };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'The AI provider is not ready.' };
  }
}

async function checkSandbox(): Promise<{ sandbox: { ok: boolean; message: string }; runtime: RuntimeStatus; images: Set<string> }> {
  const r = await resolveAdapter();
  if (!r.adapter) return { sandbox: { ok: false, message: r.status.message }, runtime: r.status, images: new Set() };
  const have = new Set<string>();
  await Promise.all(TARGET_IDS.map(async (id) => { if (await r.adapter!.imageExists(imageRef(id))) have.add(imageRef(id)); }));
  return { sandbox: { ok: true, message: r.status.message }, runtime: r.status, images: have };
}

let healthCache: { at: number; v: RewriteHealth } | null = null;
/** forget the cached health (after settings changed or the user pressed "check again") */
export const invalidateHealth = () => { healthCache = null; };

export interface RewriteDeps { settings: SettingsService }

export function createRewriteBackend(deps: RewriteDeps): RewriteBackend {
  return {
  targets: () => TARGET_IDS.map((id) => describeTarget(PACKS[id]!())),

  async health() {
    if (healthCache && Date.now() - healthCache.at < 5_000) return healthCache.v;
    const [model, sb] = await Promise.all([checkModel(deps.settings), checkSandbox()]);
    const images = Object.fromEntries(TARGET_IDS.map((id) => [id, sb.images.has(imageRef(id))]));
    const v: RewriteHealth = { ok: model.ok && sb.sandbox.ok, model, sandbox: sb.sandbox, images, runtime: sb.runtime, imageRefs: Object.fromEntries(TARGET_IDS.map((id) => [id, imageRef(id)])) };
    healthCache = { at: Date.now(), v };
    return v;
  },

  async plan(req, chainId) {
    const pack = PACKS[req.to]?.();
    if (!pack) throw new CmcError(`Unknown rewrite target "${req.to}"`, 'INPUT');
    // fetch + AST-only compile + spec + sanity gate, cached for 30 minutes with shared in-flight requests (packages/translate)
    const { spec, gate } = await analyseForRewrite(chainId, req.address);
    if (!gate.ok) throw new SpecMismatch(gate.problems);
    const tpl = pack.templates(spec, {});
    const design: any = tpl ? tpl.design : pack.design(spec, {});
    const verdict = classifyStandard(spec);
    const nonPortable = (pack.describeNonPortable?.(spec) ?? spec.nonPortable).map((n) => ({ id: n.id, title: n.title, where: n.where, treatment: n.treatment, detail: n.detail }));
    return sanitizeDeep({
      contract: spec.name,
      path: tpl ? 'template' : 'model',
      standard: tpl ? tpl.standard : null,
      reasons: tpl ? [] : verdict.reasons.slice(0, 6),
      functions: spec.functions.filter((f) => f.kind === 'function' && (f.visibility === 'public' || f.visibility === 'external')).map((f) => f.name),
      units: tpl ? [] : pack.units(design),
      designNotes: design.notes ?? [],
      notTranslated: design.notTranslated ?? [],
      nonPortable,
      decimalsNote: design.decimalsNote ?? null,
    } satisfies RewritePlanInfo);
  },

  async run(req, o) {
    const pack = PACKS[req.to]?.();
    if (!pack) throw new CmcError(`Unknown rewrite target "${req.to}"`, 'INPUT');
    const { provider: llm, id: providerId, model } = await deps.settings.provider({ logDir: o.outDir, concurrency: 2 });
    const res = await rewrite({ source: { kind: 'address', chain: req.from, address: req.address }, pack, llm, outDir: o.outDir, onProgress: (l) => o.onProgress(sanitize(l)), signal: o.signal, timeBudgetMs: o.budgetMs, onCheckpoint: (r) => o.onCheckpoint?.(r.report) });
    const u = llm.usage();
    const c = estimateCost(providerId, model, u.tokensIn, u.tokensOut);
    o.onProgress(`Model usage: ${u.requests} calls, ${u.tokensIn} tokens in, ${u.tokensOut} out${c.usd !== null ? `, about $${c.usd.toFixed(4)} (${c.basis === 'reported' ? 'reported by the provider' : `estimate from prices dated ${c.asOf}, may be stale`})` : ' (no price on file for this model)'}.`);
    return { status: res.status, report: res.report };
  },
  };
}
