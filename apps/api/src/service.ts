import { CmcError, isLicenseWarning, licenseReport, licenseWarnings, type ChainInfo, type CloneAnalysis, type ClonePlan, type Overrides, type VerifiedContract } from '@cmc/core';
import type { Backend, RecompileResult } from './backend.js';

class TtlCache<V> {
  private m = new Map<string, { at: number; v: Promise<V> }>();
  constructor(private ttl: number, private max = 200) {}
  get(key: string, make: () => Promise<V>, onHit?: () => void): Promise<V> {
    const hit = this.m.get(key);
    if (hit && Date.now() - hit.at < this.ttl) { onHit?.(); return hit.v; }
    const v = make();
    this.m.set(key, { at: Date.now(), v });
    v.catch(() => { if (this.m.get(key)?.v === v) this.m.delete(key); });
    if (this.m.size > this.max) this.m.delete(this.m.keys().next().value!);
    return v;
  }
}

/** Strip the big standard-JSON compiler inputs unless asked for; the browser never needs them. */
export function slimPlan(plan: ClonePlan): unknown {
  return {
    ...plan,
    contracts: Object.fromEntries(
      Object.entries(plan.contracts).map(([k, c]) => [k, { ...c, stdJsonInput: { sourceFiles: Object.keys(c.stdJsonInput.sources).length, evmVersion: c.stdJsonInput.settings.evmVersion ?? null }, abi: undefined }]),
    ),
  };
}

function slimContract(vc: VerifiedContract): unknown {
  return { ...vc, stdJsonInput: { sourceFiles: Object.keys(vc.stdJsonInput.sources).length }, abi: undefined };
}

export function slimAnalysis(a: CloneAnalysis): unknown {
  return {
    ...a, contract: slimContract(a.contract), implementation: a.implementation ? slimAnalysis(a.implementation) : null,
    beacon: a.beacon ? slimAnalysis(a.beacon) : a.beacon,
  };
}

const gated = (c: string) => c === 'restricted' || c === 'none-or-unknown';

export function summarise(a: CloneAnalysis, chain: ChainInfo) {
  const c = a.contract;
  const impl = a.implementation;
  const lic = licenseReport(a);
  const { ids, ...overall } = lic.overall;
  // each contract's own licence warning is replaced by the report-wide ones (a restrictive implementation must not hide behind a permissive proxy)
  const warnings = [...new Set([...a.warnings, ...(impl?.warnings ?? []), ...(a.beacon?.warnings ?? [])].filter((w) => !isLicenseWarning(w)))];
  warnings.push(...licenseWarnings(lic).filter((w) => !warnings.includes(w)));
  return {
    name: impl && a.proxy.isProxy ? `${c.name} -> ${impl.contract.name}` : c.name,
    address: c.address,
    chain: { chainId: chain.chainId, name: chain.name, alias: chain.alias },
    provider: c.provider,
    matchType: c.matchType,
    compiler: compilerLabel(c.language, c.compilerVersion),
    language: c.language,
    optimizer: c.optimizer,
    evmVersion: a.evm.effectiveEvmVersion,
    evmVersionDefault: !c.evmVersion,
    /** the most restrictive licence of the proxy, implementation, beacon and libraries; `all` lists every distinct licence found */
    license: { ...overall, all: ids },
    /** one licence per contract of the clone */
    licenses: lic.contracts,
    /** the UI makes the user confirm rights before continuing; decided by the most restrictive licence of all contracts */
    licenseGate: gated(lic.overall.class),
    proxy: a.proxy,
    libraries: a.libraries,
    tokenStandards: [...new Set([...a.tokenStandards, ...(impl?.tokenStandards ?? [])])],
    immutableCount: a.immutableCount + (impl?.immutableCount ?? 0),
    proxyKind: a.minimalProxy ? 'EIP-1167 minimal proxy' : a.beacon ? 'beacon proxy' : a.proxy.isProxy ? (a.proxy.type ?? 'proxy') : null,
    initialisation: a.initialisation ? { implementationProtected: a.initialisation.implementationProtected, ifAdminProxy: a.initialisation.ifAdminProxy, discovered: a.initialisation.discovered.map((d) => d.signature), discovery: a.initialisation.discovery } : null,
    unsupported: [...a.unsupported, ...(impl ? impl.unsupported.map((u) => `implementation: ${u}`) : [])],
    warnings,
  };
}

/** `solc 0.8.19+commit.x`, `Vyper 0.2.4`: the language is named correctly, never "solc" for a Vyper contract. */
export function compilerLabel(language: string, version: string): string {
  return /^vyper$/i.test(language) ? `Vyper ${version}` : /^yul$/i.test(language) ? `solc (Yul) ${version}` : `solc ${version}`;
}

/** Caches network-heavy steps so inspect -> plan -> re-plan does not refetch the source every time. */
export class Service {
  private analyses = new TtlCache<CloneAnalysis>(10 * 60_000);
  private recompiles = new TtlCache<RecompileResult[]>(60 * 60_000, 50);
  private memos = new TtlCache<unknown>(10 * 60_000, 100);

  /** Memoise an expensive, deterministic computation (e.g. compiling a step) by its request key. */
  memo<T>(key: string, make: () => Promise<T>): Promise<T> {
    return this.memos.get(key, make as () => Promise<unknown>) as Promise<T>;
  }

  constructor(public backend: Backend) {}

  analyse(address: string, chain: ChainInfo, onStage?: (text: string) => void): Promise<CloneAnalysis> {
    return this.analyses.get(`${chain.chainId}:${address.toLowerCase()}`, () => this.backend.analyse(address, chain.chainId, onStage), () => onStage?.('Using the analysis fetched a moment ago.'));
  }

  plan(analysis: CloneAnalysis, to: ChainInfo, overrides: Overrides, onLibrary?: (vc: VerifiedContract) => void): Promise<ClonePlan> {
    return this.backend.plan(analysis, to.chainId, overrides, onLibrary);
  }

  /** Analysis + plan of a clone request; throws the shared UNSUPPORTED error when the contract or the target cannot be cloned. */
  async supportedPlan(r: { address: string; from: ChainInfo; to: ChainInfo; overrides: Overrides }): Promise<ClonePlan> {
    const key = `plan:${r.from.chainId}:${r.to.chainId}:${r.address.toLowerCase()}:${JSON.stringify(Object.entries(r.overrides).sort())}`;
    const plan = await this.memo(key, async () => this.plan(await this.analyse(r.address, r.from), r.to, r.overrides));
    assertPlannable(plan);
    return plan;
  }

  recompile(address: string, chain: ChainInfo): Promise<RecompileResult[]> {
    return this.recompiles.get(`${chain.chainId}:${address.toLowerCase()}`, async () => {
      const a = await this.analyse(address, chain);
      const out: RecompileResult[] = [];
      for (const vc of [a.implementation?.contract, a.contract].filter((x): x is VerifiedContract => !!x)) out.push(await this.backend.recompile(vc));
      return out;
    });
  }
}

/** The one error for anything that cannot be cloned or rewritten (unsupported language, compiler, proxy kind or chain): the same 422 UNSUPPORTED everywhere. */
export function supportError(reasons: string[]): CmcError {
  return new CmcError(`Not supported: ${reasons.join('; ')}`, 'UNSUPPORTED');
}

export function assertPlannable(plan: ClonePlan) {
  if (plan.unsupported.length) throw supportError(plan.unsupported);
}
