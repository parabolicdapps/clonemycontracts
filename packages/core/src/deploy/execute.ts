import { createPublicClient, createWalletClient, defineChain, fallback, http, type Account, type PublicClient, type WalletClient } from 'viem';
import { compareRuntime, compileContract, librariesLookup, linkBytecode, type BytecodeComparison, type CompiledContract } from '../compile/index.js';
import { getChain, rpcUrls } from '../chains/index.js';
import { defaultEvmVersion, evmIndex, scanSourceFeatures, unsupportedOnTarget } from '../analyse/evm.js';
import { minimalProxyInitCode } from '../analyse/proxies.js';
import { isRef } from '../util/refs.js';
import { CmcError, type Address, type ChainInfo, type ClonePlan, type Hex, type PlanArg, type PlanStep } from '../types.js';
import { fixLibrarySelfRuntime } from '../compile/self.js';
import { encodeArgs } from '../util/abi.js';
import { CREATEX, CREATEX_ABI, TOPIC_CREATION, TOPIC_CREATION_SALT, computeCreate2, computeCreate3, createxCalldata, guardSalt } from './createx.js';

export interface StepResult {
  stepId: string;
  name: string;
  /** deployed address (deploy steps) or the contract that was called (initialise/admin steps) */
  address: Address;
  txHash: Hex;
  gasUsed: string;
  /** deployed runtime vs recompiled runtime (immutables + metadata masked); for call steps a placeholder (`match`, no code deployed) */
  runtimeMatch: BytecodeComparison;
  /** 'deploy' (default) or 'call' for initialise/admin steps */
  kind?: 'deploy' | 'call';
  /** the source was patched: bytecode differs from the original on purpose */
  modifiedSource?: boolean;
  /** calldata that was sent (call steps) or the resolved constructor `_data` (proxy deployments) */
  callData?: Hex;
  /** CREATE2/CREATE3: address predicted by the plan vs the address CreateX actually deployed to */
  create2?: { predicted: Address | null; actual: Address; match: boolean };
}

export interface SkippedStep { stepId: string; reason: string }

export function makeClients(chain: ChainInfo, urls: string[], account: Account): { pub: PublicClient; wallet: WalletClient } {
  const def = defineChain({
    id: chain.chainId,
    name: chain.name,
    nativeCurrency: { name: chain.nativeCurrency, symbol: chain.nativeCurrency, decimals: 18 },
    rpcUrls: { default: { http: urls } },
  });
  const transport = urls.length > 1 ? fallback(urls.map((u) => http(u, { timeout: 30_000 }))) : http(urls[0], { timeout: 30_000 });
  return {
    pub: createPublicClient({ chain: def, transport }) as PublicClient,
    wallet: createWalletClient({ account, chain: def, transport }),
  };
}

export function defaultUrls(chain: ChainInfo): string[] {
  return rpcUrls(chain);
}

export const isCallStep = (s: PlanStep) => s.kind === 'initialise' || s.kind === 'admin';

class Unresolved extends Error {}

function resolveValue(step: PlanStep, v: unknown, deployed: Map<string, Address>, deployer: Address | undefined): unknown {
  if (isRef(v)) {
    if (v.$ref === 'deployer') {
      if (!deployer) throw new Unresolved(`step ${step.id} uses the deploying account, which is not known yet`);
      return deployer;
    }
    const id = v.$ref.replace(/^step:/, '');
    const a = deployed.get(id);
    if (!a) throw new Unresolved(`step ${step.id} depends on ${id}, which has not been deployed`);
    return a;
  }
  if (Array.isArray(v)) return v.map((x) => resolveValue(step, x, deployed, deployer));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolveValue(step, x, deployed, deployer)]));
  return v;
}

function resolveArg(step: PlanStep, a: PlanArg, deployed: Map<string, Address>, allowUnresolved: boolean, deployer: Address | undefined): unknown {
  if (a.call) {
    // encoded call (proxy constructor `_data`): always re-encode from the individually remapped arguments
    const inner = a.call.args;
    if (inner.some((x) => x.action === 'needs-input' && (x.value === null || x.value === undefined))) {
      if (!allowUnresolved) throw new CmcError(`initialiser data ${step.id}.${a.name} still needs input for ${inner.filter((x) => x.action === 'needs-input' && x.value == null).map((x) => x.name).join(', ')}; pass --set <name>=<value> (or deployer), or --keep-unresolved to deploy the proxy uninitialised`, 'INPUT');
      return '0x';
    }
    if (inner.some((x) => x.action === 'needs-input') && !allowUnresolved) {
      throw new CmcError(`initialiser data ${step.id}.${a.name} still needs input (${inner.filter((x) => x.action === 'needs-input').map((x) => x.name).join(', ')}); pass --set or --keep-unresolved`, 'INPUT');
    }
    const vals = inner.map((x) => resolveValue(step, x.value, deployed, deployer));
    return (a.call.selector + encodeArgs(inner.map((x) => x.abiParam), vals).slice(2)) as Hex;
  }
  if (a.action === 'needs-input' && (a.value === null || a.value === undefined)) {
    throw new CmcError(`argument ${step.id}.${a.name} needs a value: pass --set ${a.name}=<value>`, 'INPUT');
  }
  if (a.action === 'needs-input' && !allowUnresolved) {
    throw new CmcError(`argument ${step.id}.${a.name} still needs input (${a.note}); pass --set ${a.name}=<value> or --keep-unresolved`, 'INPUT');
  }
  return resolveValue(step, a.value, deployed, deployer);
}

export function resolveArgs(step: PlanStep, deployed: Map<string, Address>, allowUnresolved: boolean, deployer?: Address): unknown[] {
  try {
    return step.args.map((a) => resolveArg(step, a, deployed, allowUnresolved, deployer));
  } catch (e) {
    if (e instanceof Unresolved) throw new CmcError(e.message, 'DEPLOY');
    throw e;
  }
}

/** Why a call step cannot run yet (arguments missing), or null when it can. */
export function unresolvedCall(step: PlanStep): string | null {
  const missing = step.args.filter((x) => x.action === 'needs-input' && (x.value === null || x.value === undefined)).map((x) => x.name);
  return missing.length ? `needs input: ${missing.join(', ')} (pass --set <name>=<value>; owner/admin/role addresses accept "deployer")` : null;
}

export interface CompileStepOptions { chain?: ChainInfo }

/** Compile one step; before deploying, refuse EVM features the target chain cannot run. */
export async function compileStep(plan: ClonePlan, step: PlanStep, chain?: ChainInfo): Promise<CompiledContract> {
  const c = plan.contracts[step.contractKey]!;
  const cap = chain ? (chain.latestHardfork ?? (chain.push0 ? null : 'paris')) : null;
  const effective = c.evmVersion ?? defaultEvmVersion(c.compilerVersion);
  const hints = scanSourceFeatures(c.stdJsonInput.sources);
  const needAsm = !!chain && cap !== null && (evmIndex(effective) > evmIndex(cap) || hints.some((h) => h.feature !== 'PREVRANDAO'));
  let compiled: CompiledContract;
  try {
    compiled = await compileContract({ compilerVersion: c.compilerVersion, stdJsonInput: c.stdJsonInput, contract: c.fullyQualifiedName ?? c.name, evmVersion: c.evmVersion ?? undefined, assembly: needAsm });
  } catch (e) {
    const m = (e as Error).message;
    if (chain && /not available for the (selected )?EVM version|only available for|requires.*(shanghai|cancun|prague)|transient|mcopy|tstore/i.test(m)) {
      throw new CmcError(`${c.name} cannot be compiled for ${chain.name} (EVM ${effective}${chain.latestHardfork ? `, chain verified up to ${chain.latestHardfork}` : ''}): it uses a newer-EVM feature than the target supports. Choose a chain that supports it, or lower the version with --set evmVersion=<fork> only if the code does not need the feature. Compiler said: ${m.split('\n').slice(0, 3).join(' ').slice(0, 300)}`, 'COMPILE');
    }
    throw e;
  }
  if (chain && compiled.features?.length) {
    const bad = unsupportedOnTarget(compiled.features, chain);
    if (bad.length) {
      throw new CmcError(`${c.name} compiles to code using ${bad.map((b) => `${b.feature} (needs ${b.needs})`).join(', ')}, but ${chain.name} is verified only up to ${chain.latestHardfork ?? 'Paris'}; deploying it would produce a broken contract. Lower the EVM target (--set evmVersion=<fork>) if the source allows it, or pick another chain.`, 'COMPILE');
    }
  }
  return compiled;
}

export interface ExecuteOptions {
  chain: ChainInfo;
  pub: PublicClient;
  wallet: WalletClient;
  allowUnresolved?: boolean;
  onProgress?: (msg: string) => void;
}

export interface ExecuteOutcome { results: StepResult[]; skipped: SkippedStep[]; addresses: Record<string, Address> }

/** Everything needed to build the init code of a deploy step (shared by planning/prediction and execution). */
export async function buildInitCode(plan: ClonePlan, step: PlanStep, chain: ChainInfo, deployed: Map<string, Address>, deployer: Address | undefined, allowUnresolved: boolean): Promise<{ initCode: Hex; compiled: CompiledContract | null; lookup: (f: string, n: string) => string | undefined; callData?: Hex }> {
  if (step.kind === 'minimal-proxy') {
    const impl = deployed.get(step.dependsOn.find((d) => d === 'implementation') ?? 'implementation');
    if (!impl) throw new CmcError('minimal proxy depends on the implementation, which has not been deployed', 'DEPLOY');
    return { initCode: minimalProxyInitCode(impl), compiled: null, lookup: () => undefined };
  }
  const compiled = await compileStep(plan, step, chain);
  const lookup = (file: string, name: string): string | undefined => {
    const ref = step.links[`${file}:${name}`] ?? step.links[`:${name}`] ?? Object.entries(step.links).find(([k]) => k.endsWith(`:${name}`))?.[1];
    if (!ref) return undefined;
    return ref.startsWith('step:') ? deployed.get(ref.slice(5)) : ref;
  };
  const { linked, missing } = linkBytecode(compiled.creation.object, compiled.creation.linkReferences, lookup);
  if (missing.length) throw new CmcError(`unlinked libraries for ${step.name}: ${missing.join(', ')}`, 'COMPILE');
  const args = resolveArgs(step, deployed, allowUnresolved, deployer);
  const ctorInputs = compiled.abi.find((i) => i.type === 'constructor')?.inputs ?? [];
  const callArg = step.args.findIndex((x) => x.call);
  return { initCode: (('0x' + linked) + encodeArgs(ctorInputs, args).slice(2)) as Hex, compiled, lookup, callData: callArg >= 0 ? (args[callArg] as Hex) : undefined };
}

export interface StepTransactionContext {
  /** addresses of already deployed steps (step id -> address) */
  deployed: Record<string, Address> | Map<string, Address>;
  /** the account that signs (needed for `{"$ref":"deployer"}` and for sender-bound CreateX salts) */
  deployer?: Address;
  /** ids of call steps (initialise/admin) that already ran */
  completed?: Iterable<string>;
  /** ids of steps that were skipped (a step depending on one of them is skipped too) */
  skipped?: Iterable<string>;
  /** target chain (default: the plan's); its verified opcode support decides the refusal of unsupported code */
  chain?: ChainInfo;
  /** build despite needs-input arguments that have a value (they are skipped when the value is missing) */
  allowUnresolved?: boolean;
}

export interface StepTransaction {
  /**
   * ready: send `to`/`data` now. waiting: needs addresses/steps that are not done yet (`waitingFor`).
   * skipped: will not run (`reason`; `blocking` = a required step lacking input, which stops a real deployment).
   * unsupported: cannot be built (`reason`, `errorCode`), e.g. the compiled code uses opcodes the target chain does not run.
   */
  status: 'ready' | 'waiting' | 'skipped' | 'unsupported';
  reason?: string;
  waitingFor?: string[];
  blocking?: boolean;
  errorCode?: CmcError['code'];
  /** null = contract creation */
  to?: Address | null;
  data?: Hex;
  /** deploy steps: with CreateX the predicted address, otherwise undefined (depends on the nonce) */
  predictedAddress?: Address | null;
  /** deploy steps: the plain init code (CreateX wraps it in `data`); for proxies the resolved `_data` */
  initCode?: Hex;
  callData?: Hex;
  /** internals for the executor: compiled contract and the library lookup */
  compiled?: CompiledContract | null;
  lookup?: (file: string, name: string) => string | undefined;
}

/**
 * The exact transaction the deployer would send for one plan step, without a signer. One code path: `executePlanDetailed` uses it.
 * Covers library, contract, implementation, proxy (with re-encoded `_data`), beacon, minimal-proxy, initialise and admin steps,
 * with library linking, `step:<id>` / `deployer` ref resolution, optional/dependency skipping, CreateX wrapping and the
 * per-chain EVM-feature refusal.
 */
export async function buildStepTransaction(plan: ClonePlan, stepId: string, ctx: StepTransactionContext): Promise<StepTransaction> {
  const step = plan.steps.find((s) => s.id === stepId);
  if (!step) return { status: 'unsupported', reason: `no step ${stepId} in the plan`, errorCode: 'INPUT' };
  const chain = ctx.chain ?? getChain(plan.to.chainId);
  const deployed = ctx.deployed instanceof Map ? ctx.deployed : new Map(Object.entries(ctx.deployed) as [string, Address][]);
  const completed = new Set(ctx.completed ?? []);
  const skipped = new Set(ctx.skipped ?? []);
  const deployer = ctx.deployer;
  const allow = !!ctx.allowUnresolved;

  if (isCallStep(step)) {
    const target = deployed.get(step.call!.target);
    const blocked = step.dependsOn.find((d) => skipped.has(d));
    if (blocked) return { status: 'skipped', reason: `depends on ${blocked}, which was skipped (running it first would revert)` };
    const waitingFor = [
      ...(target ? [] : [step.call!.target]),
      ...step.dependsOn.filter((d) => d !== step.call!.target && !deployed.has(d) && !completed.has(d)),
    ];
    if (waitingFor.length) return { status: 'waiting', waitingFor, reason: `waiting for ${waitingFor.join(', ')}` };
    const why = unresolvedCall(step);
    if (why) return { status: 'skipped', reason: `${step.call!.optional ? 'optional, ' : ''}${why}`, blocking: !step.call!.optional && !allow };
    try {
      const values = resolveArgs(step, deployed, allow, deployer);
      const data = (step.call!.selector + encodeArgs(step.args.map((x) => x.abiParam), values).slice(2)) as Hex;
      return { status: 'ready', to: target!, data, callData: data };
    } catch (e) {
      if (e instanceof CmcError && e.code === 'DEPLOY' && /deploying account/.test(e.message)) return { status: 'waiting', reason: e.message, waitingFor: ['deployer'] };
      return fail(e);
    }
  }

  const waitingFor = [...new Set([...step.dependsOn, ...Object.values(step.links).filter((l) => l.startsWith('step:')).map((l) => l.slice(5))])].filter((d) => !deployed.has(d));
  if (waitingFor.length) return { status: 'waiting', waitingFor, reason: `waiting for ${waitingFor.join(', ')}` };
  try {
    const { initCode, compiled, lookup, callData } = await buildInitCode(plan, step, chain, deployed, deployer, allow);
    const c2 = plan.create2;
    if (!c2) return { status: 'ready', to: null, data: initCode, initCode, callData, compiled, lookup, predictedAddress: undefined };
    const g = c2.guardedSalt ?? guardSalt(c2.salt, deployer ?? null, chain.chainId);
    const predicted = step.create2?.predictedAddress ?? (c2.mode === 'create2' ? computeCreate2(c2.factory, g, initCode) : computeCreate3(c2.factory, g));
    return { status: 'ready', to: c2.factory, data: createxCalldata(c2.mode, c2.salt, initCode), initCode, callData, compiled, lookup, predictedAddress: predicted };
  } catch (e) {
    if (e instanceof CmcError && e.code === 'DEPLOY' && /not been deployed|deploying account/.test(e.message)) return { status: 'waiting', reason: e.message, waitingFor: /deploying account/.test(e.message) ? ['deployer'] : [] };
    return fail(e);
  }
}

function fail(e: unknown): StepTransaction {
  const err = e as CmcError;
  return { status: 'unsupported', reason: err.message, errorCode: err.code ?? 'INTERNAL' };
}

/** Deploy every step in order; also runs `initialise`/`admin` call steps. Skips call steps whose arguments are still missing. */
export async function executePlanDetailed(plan: ClonePlan, o: ExecuteOptions): Promise<ExecuteOutcome> {
  const deployed = new Map<string, Address>();
  const results: StepResult[] = [];
  const skipped: SkippedStep[] = [];
  const log = o.onProgress ?? (() => {});
  const deployer = o.wallet.account!.address;
  const c2 = plan.create2;
  if (c2) {
    if (!c2.factoryVerified) throw new CmcError(`CreateX is not deployed on ${o.chain.name} (no code at ${c2.factory}); cannot use --create2/--create3 there`, 'DEPLOY');
    if (c2.deployer && c2.deployer.toLowerCase() !== deployer.toLowerCase()) throw new CmcError(`the plan's salt is bound to ${c2.deployer} but the signing key is ${deployer}; re-plan with this key configured`, 'DEPLOY');
  }
  for (const step of plan.steps) {
    const tx = await buildStepTransaction(plan, step.id, { deployed, deployer, completed: results.filter((r) => r.kind === 'call').map((r) => r.stepId), skipped: skipped.map((k) => k.stepId), chain: o.chain, allowUnresolved: o.allowUnresolved });
    if (isCallStep(step)) {
      if (tx.status === 'waiting') { skipped.push({ stepId: step.id, reason: `target ${step.call!.target} was not deployed` }); continue; }
      if (tx.status === 'skipped') {
        if (tx.blocking) throw new CmcError(`${step.id} ${tx.reason}`, 'INPUT');
        skipped.push({ stepId: step.id, reason: tx.reason! });
        log(`skipping ${step.id}: ${tx.reason}`);
        continue;
      }
      if (tx.status === 'unsupported') throw new CmcError(tx.reason!, tx.errorCode ?? 'INPUT');
      const target = tx.to!;
      const data = tx.data!;
      log(`${step.id}: ${step.call!.signature} on ${target}`);
      let hash: Hex;
      try {
        hash = await o.wallet.sendTransaction({ account: o.wallet.account!, chain: o.wallet.chain, to: target, data });
      } catch (e) {
        throw new CmcError(`${step.id} (${step.call!.signature}) failed: ${(e as Error).message.split('\n')[0]}`, 'DEPLOY');
      }
      const receipt = await o.pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
      if (receipt.status !== 'success') throw new CmcError(`${step.id} (${step.call!.signature}) reverted (tx ${hash})`, 'DEPLOY');
      results.push({ stepId: step.id, name: step.call!.function, address: target, txHash: hash, gasUsed: receipt.gasUsed.toString(), runtimeMatch: { result: 'match', detail: 'call step: no code deployed' }, kind: 'call', callData: data });
      continue;
    }

    log(`${step.kind === 'minimal-proxy' ? 'building' : 'compiling'} ${step.name}${plan.contracts[step.contractKey] && step.kind !== 'minimal-proxy' ? ` (${plan.contracts[step.contractKey]!.compilerVersion})` : ''}`);
    if (tx.status !== 'ready') throw new CmcError(tx.reason ?? `cannot build ${step.id}`, tx.status === 'unsupported' ? tx.errorCode ?? 'DEPLOY' : 'DEPLOY');
    const { initCode, compiled, lookup, callData } = { initCode: tx.initCode!, compiled: tx.compiled ?? null, lookup: tx.lookup!, callData: tx.callData };
    log(`deploying ${step.name}${c2 ? ` via CreateX ${c2.mode.toUpperCase()}` : ''}`);
    let hash: Hex;
    try {
      hash = c2
        ? await o.wallet.sendTransaction({ account: o.wallet.account!, chain: o.wallet.chain, to: c2.factory, data: createxCalldata(c2.mode, c2.salt, initCode) })
        : await o.wallet.sendTransaction({ account: o.wallet.account!, chain: o.wallet.chain, data: initCode, to: undefined });
    } catch (e) {
      throw new CmcError(`deploying ${step.name} failed: ${(e as Error).message.split('\n')[0]}`, 'DEPLOY');
    }
    const receipt = await o.pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
    let address: Address | null | undefined = receipt.contractAddress;
    let c2info: StepResult['create2'];
    if (c2) {
      const log0 = receipt.logs.find((l) => l.address.toLowerCase() === c2.factory.toLowerCase() && (l.topics[0] === TOPIC_CREATION_SALT || l.topics[0] === TOPIC_CREATION));
      address = log0?.topics[1] ? (`0x${log0.topics[1].slice(26)}` as Address) : null;
      if (address) {
        const g = c2.guardedSalt ?? guardSalt(c2.salt, deployer, o.chain.chainId);
        const predicted = step.create2?.predictedAddress ?? (c2.mode === 'create2' ? computeCreate2(c2.factory, g, initCode) : computeCreate3(c2.factory, g));
        c2info = { predicted, actual: address, match: predicted.toLowerCase() === address.toLowerCase() };
        if (!c2info.match) throw new CmcError(`${step.name}: CreateX deployed to ${address} but the plan predicted ${predicted}; stopping`, 'DEPLOY');
      }
    }
    if (receipt.status !== 'success' || !address) throw new CmcError(`deployment of ${step.name} reverted (tx ${hash})`, 'DEPLOY');
    deployed.set(step.id, address);
    const onchain = (await o.pub.getCode({ address })) ?? '0x';
    let runtimeMatch: BytecodeComparison;
    if (!compiled) {
      runtimeMatch = onchain === '0x' ? { result: 'mismatch', detail: 'no code at the deployed address' } : { result: 'exact', detail: 'EIP-1167 runtime built from the clone implementation address' };
      const want = `0x363d3d373d3d3d363d73${deployed.get('implementation')!.slice(2).toLowerCase()}5af43d82803e903d91602b57fd5bf3`;
      if (onchain !== '0x' && onchain.toLowerCase() !== want) runtimeMatch = { result: 'mismatch', detail: 'minimal proxy runtime differs from the expected EIP-1167 code' };
    } else {
      const rt = linkBytecode(compiled.runtime.object, compiled.runtime.linkReferences, lookup).linked;
      const expectRuntime = fixLibrarySelfRuntime(rt, onchain);
      runtimeMatch = onchain === '0x' ? { result: 'mismatch', detail: 'no code at the deployed address' } : compareRuntime(onchain, expectRuntime, compiled.runtime.immutableReferences);
    }
    const modified = !!plan.contracts[step.contractKey]?.modifiedSource && step.kind !== 'minimal-proxy';
    results.push({
      stepId: step.id, name: step.name, address, txHash: hash, gasUsed: receipt.gasUsed.toString(), runtimeMatch, kind: 'deploy',
      ...(modified ? { modifiedSource: true } : {}), ...(callData ? { callData } : {}), ...(c2info ? { create2: c2info } : {}),
    });
    log(`  ${step.name} at ${address} (${runtimeMatch.result}${modified ? ', modified source' : ''}${c2info ? `, CREATE2 address ${c2info.match ? 'matches' : 'DIFFERS from'} prediction` : ''})`);
  }
  return { results, skipped, addresses: Object.fromEntries(deployed) };
}

/** Deploy every step in order (see {@link executePlanDetailed} for skipped steps). */
export async function executePlan(plan: ClonePlan, o: ExecuteOptions): Promise<StepResult[]> {
  return (await executePlanDetailed(plan, o)).results;
}

export { CREATEX, CREATEX_ABI };
