import { getChain } from '../chains/index.js';
import { SOURCIFY_BASE } from '../fetch/sourcify.js';
import {
  CmcError, type Address, type ChainInfo, type ClonePlan, type Hex, type PlanStep, type StdJsonInput,
} from '../types.js';
import { encodeArgs } from '../util/abi.js';
import { isRef } from '../util/refs.js';

const USER_AGENT = 'clonemycontracts/0.1';

export type Explorer = 'sourcify' | 'etherscan' | 'blockscout';

/** Record of a real deployment, written next to plan.json as deployment.json. */
export interface DeploymentRecord {
  chainId: number;
  deployer?: Address;
  steps: { stepId: string; kind: 'deploy' | 'call'; address: Address; txHash: Hex }[];
}

export interface VerificationInput {
  stepId: string;
  address: Address;
  chainId: number;
  /** standard JSON input exactly as compiled for the deployment (patched sources, chosen evmVersion, linked library addresses) */
  standardJson: StdJsonInput;
  /** `path/File.sol:Name` */
  contractIdentifier: string;
  /** `0.8.20+commit.a1b79de6` */
  compilerVersion: string;
  /** ABI-encoded constructor arguments, `0x` for none */
  constructorArgs: Hex;
  creationTxHash?: Hex;
}

/** Address of every deployed step (from a DeploymentRecord). */
export function deployedAddresses(rec: DeploymentRecord): Map<string, Address> {
  return new Map(rec.steps.filter((s) => s.kind === 'deploy').map((s) => [s.stepId, s.address]));
}

function findLibraryFile(sources: Record<string, { content: string }>, name: string): string | null {
  const re = new RegExp(`\\blibrary\\s+${name}\\b`);
  return Object.entries(sources).find(([, s]) => re.test(s.content))?.[0] ?? null;
}

/** The standard JSON input and constructor arguments to submit for a deployed step. */
export function buildVerificationInput(plan: ClonePlan, step: PlanStep, addresses: Map<string, Address>, deployer?: Address, creationTxHash?: Hex, constructorArgsOverride?: Hex): VerificationInput {
  const c = plan.contracts[step.contractKey];
  const address = addresses.get(step.id);
  if (!c || step.kind === 'minimal-proxy' || step.kind === 'initialise' || step.kind === 'admin') throw new CmcError(`step ${step.id} has no source to verify (${step.kind})`, 'INPUT');
  if (!address) throw new CmcError(`step ${step.id} has no deployed address`, 'INPUT');
  const std = structuredClone(c.stdJsonInput);
  delete (std.settings as Record<string, unknown>).outputSelection;
  if (c.evmVersion) std.settings.evmVersion = c.evmVersion; else delete std.settings.evmVersion;
  // library addresses as deployed on the target
  const libs: Record<string, Record<string, string>> = {};
  for (const [key, ref] of Object.entries(step.links)) {
    const name = key.slice(key.lastIndexOf(':') + 1);
    const file = key.slice(0, key.lastIndexOf(':')) || findLibraryFile(std.sources, name);
    const addr = ref.startsWith('step:') ? addresses.get(ref.slice(5)) : ref;
    if (!file || !addr) throw new CmcError(`cannot place library ${name} for ${step.id}: ${!file ? 'its source file was not found' : 'its address is unknown'}`, 'INPUT');
    (libs[file] ??= {})[name] = addr;
  }
  std.settings.libraries = libs;
  // constructor args from the plan, with refs resolved to deployed addresses
  const inputs = c.abi.find((i) => i.type === 'constructor')?.inputs ?? [];
  const resolve = (v: unknown): unknown => {
    if (isRef(v)) {
      if (v.$ref === 'deployer') { if (!deployer) throw new CmcError('constructor argument uses the deployer but the deploying account is unknown', 'INPUT'); return deployer; }
      const a = addresses.get(v.$ref.replace(/^step:/, ''));
      if (!a) throw new CmcError(`constructor argument refers to ${v.$ref}, which has no deployed address`, 'INPUT');
      return a;
    }
    if (Array.isArray(v)) return v.map(resolve);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolve(x)]));
    return v;
  };
  let constructorArgs: Hex = '0x';
  if (constructorArgsOverride) constructorArgs = constructorArgsOverride;
  else if (inputs.length) {
    const vals = step.args.map((a) => {
      if (a.call) return (a.call.selector + encodeArgs(a.call.args.map((x) => x.abiParam), a.call.args.map((x) => resolve(x.value))).slice(2)) as Hex;
      if (a.value === null || a.value === undefined) throw new CmcError(`constructor argument ${step.id}.${a.name} has no value in the plan`, 'INPUT');
      return resolve(a.value);
    });
    constructorArgs = encodeArgs(inputs, vals);
  }
  return {
    stepId: step.id, address, chainId: plan.to.chainId, standardJson: std,
    contractIdentifier: c.fullyQualifiedName ?? `${Object.keys(std.sources)[0]}:${c.name}`,
    compilerVersion: c.compilerVersion.replace(/^v/, ''), constructorArgs, creationTxHash,
  };
}

export interface HttpRequest { url: string; method: 'POST' | 'GET'; headers: Record<string, string>; body?: string }

/** Sourcify v2: POST /v2/verify/{chainId}/{address} with JSON {stdJsonInput, compilerVersion, contractIdentifier[, creationTransactionHash]}. */
export function sourcifyRequest(v: VerificationInput, base = SOURCIFY_BASE): HttpRequest {
  return {
    url: `${base}/v2/verify/${v.chainId}/${v.address}`, method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': USER_AGENT },
    body: JSON.stringify({ stdJsonInput: v.standardJson, compilerVersion: v.compilerVersion, contractIdentifier: v.contractIdentifier, ...(v.creationTxHash ? { creationTransactionHash: v.creationTxHash } : {}) }),
  };
}

/**
 * Etherscan V2 (`/v2/api?chainid=`) `verifysourcecode` with the standard JSON input. Blockscout accepts the same form at `<instance>/api`
 * (its Etherscan-compatible API), so this builder serves both; `apiKey` is omitted for Blockscout.
 */
export function etherscanRequest(v: VerificationInput, o: { base: string; apiKey?: string; chainId?: number }): HttpRequest {
  const q = new URLSearchParams();
  if (o.chainId !== undefined) q.set('chainid', String(o.chainId));
  if (o.apiKey) q.set('apikey', o.apiKey);
  q.set('module', 'contract'); q.set('action', 'verifysourcecode');
  const body = new URLSearchParams({
    contractaddress: v.address,
    sourceCode: JSON.stringify(v.standardJson),
    codeformat: 'solidity-standard-json-input',
    contractname: v.contractIdentifier,
    compilerversion: `v${v.compilerVersion}`,
    optimizationUsed: v.standardJson.settings.optimizer?.enabled ? '1' : '0',
    runs: String(v.standardJson.settings.optimizer?.runs ?? 200),
    constructorArguments: v.constructorArgs.replace(/^0x/, ''),
    evmVersion: v.standardJson.settings.evmVersion ?? 'default',
    licenseType: '1',
  });
  return { url: `${o.base}?${q}`, method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': USER_AGENT }, body: body.toString() };
}

export function etherscanStatusRequest(guid: string, o: { base: string; apiKey?: string; chainId?: number }): HttpRequest {
  const q = new URLSearchParams();
  if (o.chainId !== undefined) q.set('chainid', String(o.chainId));
  if (o.apiKey) q.set('apikey', o.apiKey);
  q.set('module', 'contract'); q.set('action', 'checkverifystatus'); q.set('guid', guid);
  return { url: `${o.base}?${q}`, method: 'GET', headers: { 'user-agent': USER_AGENT } };
}

export interface VerifyResult { explorer: Explorer; stepId: string; address: Address; status: 'verified' | 'pending' | 'failed' | 'skipped'; detail: string; url?: string }

export interface VerifyOptions {
  /** inject for tests */
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** only these explorers (default: all that apply) */
  only?: Explorer[];
  pollMs?: number;
  maxPolls?: number;
  etherscanKey?: string;
  onProgress?: (m: string) => void;
  /** verify only these plan steps */
  stepIds?: string[];
  /** use these ABI-encoded constructor arguments instead of deriving them from the plan */
  constructorArgs?: Hex;
}

async function send(req: HttpRequest, f: typeof fetch): Promise<{ status: number; json: any; text: string }> {
  const res = await f(req.url, { method: req.method, headers: req.headers, body: req.body, signal: AbortSignal.timeout(90_000) });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text };
}

async function viaSourcify(v: VerificationInput, o: Required<Pick<VerifyOptions, 'pollMs' | 'maxPolls'>> & { f: typeof fetch; sleep: (ms: number) => Promise<void> }): Promise<VerifyResult> {
  const base = { explorer: 'sourcify' as const, stepId: v.stepId, address: v.address };
  const r = await send(sourcifyRequest(v), o.f);
  if (r.status === 409) return { ...base, status: 'verified', detail: 'already verified on Sourcify' };
  if (r.status !== 202 || !r.json?.verificationId) return { ...base, status: 'failed', detail: `HTTP ${r.status}: ${r.json?.message ?? r.text.slice(0, 200)}` };
  const id = r.json.verificationId as string;
  for (let i = 0; i < o.maxPolls; i++) {
    await o.sleep(o.pollMs);
    const s = await send({ url: `${SOURCIFY_BASE}/v2/verify/${id}`, method: 'GET', headers: { 'user-agent': USER_AGENT } }, o.f);
    if (s.json?.isJobCompleted) {
      const match = s.json.contract?.match ?? s.json.contract?.runtimeMatch;
      if (match && !s.json.error) return { ...base, status: 'verified', detail: `${match} (job ${id})`, url: `https://repo.sourcify.dev/${v.chainId}/${v.address}` };
      return { ...base, status: 'failed', detail: s.json.error?.message ?? 'verification job failed' };
    }
  }
  return { ...base, status: 'pending', detail: `job ${id} still running; check GET ${SOURCIFY_BASE}/v2/verify/${id}` };
}

async function viaEtherscanStyle(explorer: 'etherscan' | 'blockscout', v: VerificationInput, o: { f: typeof fetch; sleep: (ms: number) => Promise<void>; pollMs: number; maxPolls: number; base: string; apiKey?: string; chainId?: number; link?: string }): Promise<VerifyResult> {
  const base = { explorer, stepId: v.stepId, address: v.address };
  const r = await send(etherscanRequest(v, { base: o.base, apiKey: o.apiKey, chainId: o.chainId }), o.f);
  const guid = r.json?.result;
  if (r.json?.status !== '1' || typeof guid !== 'string') {
    if (/already verified/i.test(String(r.json?.result ?? r.json?.message))) return { ...base, status: 'verified', detail: 'already verified', url: o.link };
    return { ...base, status: 'failed', detail: `HTTP ${r.status}: ${r.json?.result ?? r.json?.message ?? r.text.slice(0, 200)}` };
  }
  for (let i = 0; i < o.maxPolls; i++) {
    await o.sleep(o.pollMs);
    const s = await send(etherscanStatusRequest(guid, { base: o.base, apiKey: o.apiKey, chainId: o.chainId }), o.f);
    const txt = String(s.json?.result ?? '');
    if (/pass|verified/i.test(txt)) return { ...base, status: 'verified', detail: txt, url: o.link };
    if (/fail|unable|error/i.test(txt) && !/pending|queue/i.test(txt)) return { ...base, status: 'failed', detail: txt };
  }
  return { ...base, status: 'pending', detail: `submitted (guid ${guid}); still pending` };
}

/** Explorers that apply on this chain, given the environment. */
export function explorersFor(chain: ChainInfo, etherscanKey?: string): { explorer: Explorer; note?: string }[] {
  const out: { explorer: Explorer; note?: string }[] = [{ explorer: 'sourcify' }];
  if (chain.explorer.etherscanV2) out.push(etherscanKey ? { explorer: 'etherscan' } : { explorer: 'etherscan', note: 'skipped: ETHERSCAN_API_KEY not set' });
  if (chain.explorer.blockscoutApi) out.push({ explorer: 'blockscout' });
  return out;
}

/** Verify every deployed source step on the explorers available for the plan's target chain. Failures are reported, never thrown. */
export async function verifyDeployment(plan: ClonePlan, rec: DeploymentRecord, opts: VerifyOptions = {}): Promise<VerifyResult[]> {
  const chain = getChain(plan.to.chainId);
  const f = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const key = opts.etherscanKey ?? process.env.ETHERSCAN_API_KEY;
  const addresses = deployedAddresses(rec);
  const results: VerifyResult[] = [];
  for (const step of plan.steps) {
    if (opts.stepIds && !opts.stepIds.includes(step.id)) continue;
    if (!addresses.has(step.id) || !plan.contracts[step.contractKey] || ['minimal-proxy', 'initialise', 'admin'].includes(step.kind)) continue;
    let input: VerificationInput;
    try { const tx = rec.steps.find((s) => s.stepId === step.id)?.txHash; input = buildVerificationInput(plan, step, addresses, rec.deployer, tx && tx.length === 66 ? tx : undefined, opts.constructorArgs); }
    catch (e) { results.push({ explorer: 'sourcify', stepId: step.id, address: addresses.get(step.id)!, status: 'failed', detail: (e as Error).message }); continue; }
    for (const ex of explorersFor(chain, key)) {
      if (opts.only && !opts.only.includes(ex.explorer)) continue;
      if (ex.note) { results.push({ explorer: ex.explorer, stepId: step.id, address: input.address, status: 'skipped', detail: ex.note }); continue; }
      opts.onProgress?.(`verifying ${step.name} on ${ex.explorer}`);
      try {
        const common = { f, sleep, pollMs: opts.pollMs ?? 3000, maxPolls: opts.maxPolls ?? 20 };
        if (ex.explorer === 'sourcify') results.push(await viaSourcify(input, common));
        else if (ex.explorer === 'etherscan') results.push(await viaEtherscanStyle('etherscan', input, { ...common, base: 'https://api.etherscan.io/v2/api', apiKey: key, chainId: chain.chainId, link: chain.explorer.url ? `${chain.explorer.url}/address/${input.address}#code` : undefined }));
        else results.push(await viaEtherscanStyle('blockscout', input, { ...common, base: `${chain.explorer.blockscoutApi}/api`, link: `${chain.explorer.blockscoutApi}/address/${input.address}?tab=contract` }));
      } catch (e) {
        results.push({ explorer: ex.explorer, stepId: step.id, address: input.address, status: 'failed', detail: (e as Error).message.split('\n')[0]! });
      }
    }
  }
  return results;
}
