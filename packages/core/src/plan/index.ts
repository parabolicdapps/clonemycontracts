import { getAddress } from 'viem';
import { analyseContract, counterpartsAll, type AnalyseOptions } from '../analyse/index.js';
import { capEvmVersion, evmIndex, requiresPush0, scanSourceFeatures, unsupportedOnTarget } from '../analyse/evm.js';
import { isLicenseWarning, licenseWarnings, overallOf, type ContractLicense, type LicenseRole } from '../analyse/license.js';
import { replaceAddress } from '../analyse/literals.js';
import { getChain, unsupportedChainMessage } from '../chains/index.js';
import { fetchVerifiedContract } from '../fetch/index.js';
import {
  CmcError, type AbiParam, type Address, type AddressClass, type ArgAction, type ClonePlan, type CloneAnalysis, type DecodedCallInfo, type Hex, type Overrides,
  type PlanArg, type PlanCall, type PlanLiteral, type PlanStep, type StepKind, type VerifiedContract,
} from '../types.js';
import { findAddresses, setAtPath, parseArgValue, coerceArg, encodeArgs } from '../util/abi.js';
import { INITIALISER_NAME, selectorOfSignature } from '../util/calls.js';
import { isAddress } from '../util/hex.js';
import { DEPLOYER_REF, deployerWords, isRef, stepRef, stripRefs } from '../util/refs.js';
import { predictCreate2, type Create2Options } from '../deploy/create2.js';

export { isRef } from '../util/refs.js';

export interface PlanOptions extends AnalyseOptions {
  fetchContract?: (chainId: number, address: Address) => Promise<VerifiedContract>;
  /** called for each library contract fetched while planning (e.g. to recompile-check it) */
  onLibrary?: (vc: VerifiedContract) => void;
  /** deterministic-address deployment through CreateX (compiles every step to predict its address) */
  create2?: Create2Options;
  /** the verified name of a contract on the SOURCE chain (null when unverified); used to explain contract dependencies. Default: no lookup. */
  contractName?: (chainId: number, address: Address) => Promise<string | null>;
  /** reads code on the TARGET chain (CreateX presence check); default: live RPC */
  targetReader?: { getCode(address: Address): Promise<Hex | undefined> };
}

const rank: Record<ArgAction, number> = { keep: 0, remap: 1, 'needs-input': 2 };
const ROLE_RE = /owner|admin|minter|pauser|blacklister|governor|guardian|manager|operator|role|treasury|authority|controller|multisig|safe|beneficiary|recipient|feeTo|feeCollector/i;
/** Verified contract names that the well-known address table knows by kind: a dependency with such a name gets the target chain's address as a suggestion. */
const NAME_KINDS: Record<string, string> = {
  swaprouter02: 'uniswap-v3-swaprouter02', uniswapv2router02: 'uniswap-v2-router02', uniswapv2factory: 'uniswap-v2-factory',
  permit2: 'permit2', multicall3: 'multicall3', createx: 'createx', weth9: 'wrapped-native', weth: 'wrapped-native', wrappedether: 'wrapped-native',
};
const TRIVIAL_ADDR = /^0x0{30}[0-9a-f]{0,10}$/i;

interface Unit { key: string; stepId: string; kind: StepKind; analysis: CloneAnalysis }
type Lookup = (addr: Address) => { classification: AddressClass; label?: string; kind?: string };

export async function planClone(a: CloneAnalysis, toChain: string | number, overrides: Overrides = {}, opts: PlanOptions = {}): Promise<ClonePlan> {
  const to = getChain(toChain);
  const from = getChain(a.contract.chainId);
  const fetchContract = opts.fetchContract ?? ((id, addr) => fetchVerifiedContract(id, addr));
  const unsupported = [...a.unsupported];
  const warnings: string[] = ['State is not copied: the clone is a fresh contract with initial state (no balances, owners or storage).'];
  const needsInput: string[] = [];
  if (to.kind !== 'evm') unsupported.push(unsupportedChainMessage(to));
  if (from.chainId === to.chainId) warnings.push('Source and destination chain are the same.');
  if (a.implementation) unsupported.push(...a.implementation.unsupported.map((u) => `implementation: ${u}`));

  const applied = new Set<string>();
  const addrOverrides = new Map<string, Address>();
  const nameOverrides = new Map<string, string>();
  let evmOverride: string | undefined;
  for (const [k, v] of Object.entries(overrides)) {
    if (isAddress(k)) {
      if (!isAddress(v)) throw new CmcError(`--set ${k}=${v}: replacement must be an address`, 'INPUT');
      addrOverrides.set(k.toLowerCase(), getAddress(v) as Address);
    } else if (k === 'evmVersion') evmOverride = v;
    else nameOverrides.set(k, v);
  }

  // ---- units, in deployment order -------------------------------------------------
  const units: Unit[] = [];
  const unitByAddress = new Map<string, Unit>();
  const planned = new Set<string>();
  async function addLibraries(an: CloneAnalysis, depth: number): Promise<void> {
    for (const lib of an.libraries) {
      const k = lib.address.toLowerCase();
      if (planned.has(k)) continue;
      if (depth > 3) { unsupported.push(`library nesting too deep at ${lib.name}`); continue; }
      planned.add(k);
      try {
        const lv = await fetchContract(a.contract.chainId, lib.address as Address);
        opts.onLibrary?.(lv);
        const la = await analyseContract(lv, { ...opts, followProxy: false });
        unsupported.push(...la.unsupported.map((u) => `library ${lib.name}: ${u}`));
        await addLibraries(la, depth + 1);
        const u: Unit = { key: `lib:${lv.name}`, stepId: `lib:${lv.name}`, kind: 'library', analysis: la };
        units.push(u);
        unitByAddress.set(k, u);
      } catch (e) {
        unsupported.push(`library ${lib.name} at ${lib.address} could not be cloned: ${(e as Error).message}`);
      }
    }
  }
  if (a.implementation) {
    await addLibraries(a.implementation, 0);
    const u: Unit = { key: 'implementation', stepId: 'implementation', kind: 'implementation', analysis: a.implementation };
    units.push(u);
    unitByAddress.set(a.implementation.contract.address.toLowerCase(), u);
    for (const impl of a.proxy.implementations) unitByAddress.set(impl.toLowerCase(), u);
  }
  if (a.beacon) {
    await addLibraries(a.beacon, 0);
    const u: Unit = { key: 'beacon', stepId: 'beacon', kind: 'beacon', analysis: a.beacon };
    units.push(u);
    unitByAddress.set(a.beacon.contract.address.toLowerCase(), u);
  }
  const isMinimal = !!a.minimalProxy;
  if (!isMinimal) await addLibraries(a, 0);
  const mainKind: StepKind = isMinimal ? 'minimal-proxy' : a.implementation ? 'proxy' : 'contract';
  const mainUnit: Unit = { key: mainKind, stepId: mainKind, kind: mainKind, analysis: a };
  units.push(mainUnit);

  const contracts: ClonePlan['contracts'] = {};
  const steps: PlanStep[] = [];
  const literals: PlanLiteral[] = [];
  const usedAddrOverrides = new Set<string>();
  const usedNameOverrides = new Set<string>();

  // ---- the target chain's limits on the EVM -----------------------------------------
  const caps: string[] = [];
  if (!to.push0) caps.push('paris');
  if (to.latestHardfork) caps.push(to.latestHardfork);
  const cap = caps.length ? caps.reduce((lo, c) => (evmIndex(c) < evmIndex(lo) ? c : lo)) : null;
  const capReason = !to.push0 && (!to.latestHardfork || evmIndex('paris') <= evmIndex(to.latestHardfork)) ? `${to.name} does not support PUSH0` : `${to.name}'s latest verified hardfork is ${to.latestHardfork}`;

  // ---- shared: decide what to do with one address ------------------------------------
  interface Decision { value?: unknown; action: ArgAction; note?: string; suggested?: Address; suggestion?: unknown; dependsOn?: string }
  async function decideAddress(addr: Address, f: ReturnType<Lookup>, name: string, u: Unit | null, p: AbiParam): Promise<Decision> {
    const lc = addr.toLowerCase();
    const ovr = addrOverrides.get(lc);
    const ref = unitByAddress.get(lc);
    if (ovr) { usedAddrOverrides.add(lc); return { value: ovr, action: 'keep', note: `overridden by --set ${lc}`, suggested: ovr }; }
    if (ref && ref !== u) return { value: stepRef(ref.stepId), action: 'remap', note: `points to the cloned ${ref.stepId} step`, dependsOn: ref.stepId };
    if (u && (u.kind === 'proxy' || u.kind === 'beacon') && p.type === 'address' && /impl|logic/i.test(name) && a.implementation) {
      const impl = units.find((x) => x.kind === 'implementation')!;
      return { value: stepRef(impl.stepId), action: 'remap', note: 'initial implementation -> the cloned implementation', dependsOn: impl.stepId };
    }
    if (f.classification === 'zero') return { action: 'keep' };
    // burn / precompile-style placeholders (0x...01, 0x...dEaD) are intentional, not accounts to hand over
    if (TRIVIAL_ADDR.test(addr) || /dead$/i.test(addr)) return { action: 'keep', note: 'placeholder address (burn/precompile range), kept' };
    if (f.classification === 'wellknown' && f.kind) {
      const counter = (await counterpartsAll(f.kind))[String(to.chainId)];
      if (counter) return { value: counter, action: 'remap', note: `${f.label ?? f.kind} on ${from.name} -> ${counter} on ${to.name}`, suggested: counter };
      return { action: 'needs-input', note: `${f.label ?? f.kind} has no known counterpart on ${to.name}` };
    }
    const roleish = ROLE_RE.test(name);
    if (f.classification === 'contract') {
      // a contract the clone depends on (router, registry, manager ...): never an account of the deployer, whatever the argument is called
      const dep = await dependencyInfo(addr);
      return { action: 'needs-input', ...(dep.suggestion ? { suggestion: dep.suggestion } : {}), note: dep.note };
    }
    const suggestion = f.classification === 'eoa' || roleish ? { ...DEPLOYER_REF } : undefined;
    if (f.classification === 'eoa') return { action: 'needs-input', suggestion, note: `address with no code on ${from.name} (owner/admin/treasury?); set your own${roleish ? ' (use "deployer" for the deploying account)' : ''}` };
    return { action: 'needs-input', suggestion, note: 'could not classify (source RPC unavailable)' };
  }

  let nameLookups = 0;
  const nameCache = new Map<string, Promise<string | null>>();
  /** What a contract dependency is (its verified name on the source chain) and, when the registry knows it, its address on the target chain. */
  async function dependencyInfo(addr: Address): Promise<{ note: string; suggestion?: Address }> {
    const lc = addr.toLowerCase();
    let name: string | null = null;
    if (opts.contractName && (nameCache.has(lc) || nameLookups < 12)) {
      if (!nameCache.has(lc)) { nameLookups++; nameCache.set(lc, opts.contractName(from.chainId, addr).catch(() => null)); }
      name = await nameCache.get(lc)!;
    }
    const kind = name ? NAME_KINDS[name.toLowerCase().replace(/[^a-z0-9]/g, '')] : undefined;
    const counter = kind ? (await counterpartsAll(kind))[String(to.chainId)] : undefined;
    return {
      note: `protocol contract on the source chain: ${name ?? 'unverified'} (${addr}) — supply its address on the target chain or clone it first${counter ? `; the well-known ${kind} on ${to.name} is ${counter}` : ''}`,
      ...(counter ? { suggestion: getAddress(counter) as Address } : {}),
    };
  }

  /** Plan one value of an ABI type (constructor argument or call argument). */
  async function planArg(o: {
    p: AbiParam; index: number; stepId: string; nameKeys: string[]; original: unknown; known: boolean; lookup: Lookup; unit: Unit | null;
    mode: 'ctor' | 'call'; unknownNote: string; dependsOn: Set<string>;
  }): Promise<PlanArg> {
    const { p } = o;
    const name = p.name || `arg${o.index}`;
    let value: unknown = o.known ? o.original : null;
    let action: ArgAction = o.known ? 'keep' : 'needs-input';
    let note: string | undefined = o.known ? undefined : o.unknownNote;
    let suggestion: unknown;
    const addrInfo: PlanArg['addresses'] = [];
    if (o.known) {
      for (const f of findAddresses(p, o.original)) {
        const finding = o.lookup(f.address);
        const info: PlanArg['addresses'][number] = { path: f.path, address: f.address, classification: finding.classification, label: finding.label };
        const d = await decideAddress(f.address, finding, name, o.unit, p);
        if (d.value !== undefined) value = setAtPath(value, f.path, d.value);
        if (d.suggested) info.suggested = d.suggested;
        if (d.dependsOn) o.dependsOn.add(d.dependsOn);
        if (d.suggestion !== undefined) suggestion = d.suggestion;
        if (rank[d.action] > rank[action]) action = d.action;
        if (d.note && (!note || rank[d.action] >= rank[action])) note = d.note;
        addrInfo.push(info);
      }
      if (/^u?int\d*$/.test(p.type) && /chain.?id/i.test(name) && String(o.original) === String(from.chainId)) {
        value = String(to.chainId); action = 'remap'; note = `chain id ${from.chainId} -> ${to.chainId}`;
      }
      // an unresolved call argument is never silently copied from the source chain
      if (o.mode === 'call' && action === 'needs-input') value = null;
    }
    for (const key of o.nameKeys) {
      if (!nameOverrides.has(key)) continue;
      const raw = nameOverrides.get(key)!;
      try {
        value = deployerWords(parseArgValue(p, raw));
        coerceArg(p, stripRefs(value));
      } catch (e) { throw new CmcError(`--set ${key}=${raw}: not a valid ${p.type} (${(e as Error).message})`, 'INPUT'); }
      action = 'keep'; note = `set by --set ${key}`; usedNameOverrides.add(key); applied.add(key); suggestion = undefined;
      if (JSON.stringify(value).includes('"$ref":"deployer"')) note += ' (the deploying account)';
      break;
    }
    return { index: o.index, name, type: p.type, abiParam: p, original: o.known ? o.original : null, value, action, note, addresses: addrInfo, ...(suggestion !== undefined ? { suggestion } : {}) };
  }

  /** `bytes` constructor argument that is an encoded initialiser call -> a decoded PlanCall with remappable arguments. */
  async function planDecodedCall(info: DecodedCallInfo, targetStep: string, stepId: string, keys: (inner: string) => string[], dependsOn: Set<string>, unitCtx: Unit | null): Promise<PlanCall> {
    const args: PlanArg[] = [];
    for (const [i, x] of info.args.entries()) {
      const finds = new Map(x.addresses.map((ad) => [ad.address.toLowerCase(), ad]));
      args.push(await planArg({
        p: x.abiParam, index: i, stepId, nameKeys: keys(x.name), original: x.value, known: true, mode: 'call', unit: unitCtx, unknownNote: '', dependsOn,
        lookup: (addr) => finds.get(addr.toLowerCase()) ?? { classification: 'unknown' },
      }));
    }
    return { target: targetStep, function: info.function, signature: info.signature, selector: info.selector, args };
  }

  for (const u of units) {
    const vc = u.analysis.contract;
    const noSource = u.kind === 'minimal-proxy';
    let hadEdits = false;
    const dependsOn = new Set<string>();

    // ---- compiler settings + source patching -----------------------------------------
    if (!noSource) {
      const original = vc.evmVersion ?? u.analysis.evm.effectiveEvmVersion;
      let evm: string | null = vc.evmVersion;
      if (evmOverride) { evm = evmOverride; applied.add('evmVersion'); }
      else if (cap && evmIndex(original) > evmIndex(cap)) {
        evm = capEvmVersion(original, cap);
        warnings.push(`${vc.name}: evmVersion lowered from ${original} to ${evm} because ${capReason}`);
      } else if (!to.push0 && requiresPush0(original)) {
        evm = 'paris';
        warnings.push(`${vc.name}: evmVersion lowered from ${original} to paris because ${to.name} does not support PUSH0`);
      }
      const std = structuredClone(vc.stdJsonInput);
      const sourceEdits: { from: string; to: string; occurrences?: number }[] = [];
      // hard-coded address literals as remap items
      for (const lit of u.analysis.sourceLiterals ?? []) {
        const lc = lit.address.toLowerCase();
        if (TRIVIAL_ADDR.test(lit.address) || /dead$/i.test(lit.address)) continue;
        if (!['contract', 'wellknown', 'eoa', 'unknown'].includes(lit.classification)) continue;
        const ovr = addrOverrides.get(lc);
        let value: Address = getAddress(lit.address) as Address;
        let action: ArgAction = 'keep';
        let note: string | undefined;
        let suggested: Address | undefined;
        if (ovr) { value = ovr; suggested = ovr; note = `set by --set ${lc}`; usedAddrOverrides.add(lc); }
        else if (lit.classification === 'wellknown' && lit.kind) {
          const counter = (await counterpartsAll(lit.kind))[String(to.chainId)];
          if (counter) { value = getAddress(counter) as Address; suggested = value; action = 'remap'; note = `${lit.label ?? lit.kind} on ${from.name} -> ${counter} on ${to.name}`; }
          else { action = 'needs-input'; note = `${lit.label ?? lit.kind} has no known counterpart on ${to.name}; patch with --set ${lit.address}=<address>`; }
        } else if (lit.classification === 'contract') { action = 'needs-input'; note = `contract on ${from.name} with no known counterpart on ${to.name}; patch with --set ${lit.address}=<address>`; }
        else if (lit.classification === 'eoa') { action = 'needs-input'; note = `address with no code on ${from.name} (owner/admin/treasury?); patch with --set ${lit.address}=<address>`; }
        else { action = 'needs-input'; note = 'could not classify (source RPC unavailable)'; }
        const id = `${u.stepId}.literal:${lit.address}`;
        const locations = (await import('../analyse/literals.js')).scanLiteralLocations(vc.stdJsonInput.sources).filter((l) => l.address.toLowerCase() === lc).map(({ file, line, column, snippet }) => ({ file, line, column, snippet }));
        literals.push({ id, contractKey: u.key, stepId: u.stepId, original: lit.address, value, action, note, classification: lit.classification, label: lit.label, ...(suggested ? { suggested } : {}), locations, occurrences: lit.occurrences });
        if (action === 'needs-input') needsInput.push(id);
        if (value.toLowerCase() !== lc) {
          let n = 0;
          for (const f of Object.values(std.sources)) { const r = replaceAddress(f.content, lit.address, value); f.content = r.text; n += r.count; }
          if (n) sourceEdits.push({ from: lc, to: value, occurrences: n });
        }
      }
      // overrides for literals the analyser did not list (e.g. beyond the first 60): plain textual patch
      for (const [oldLc, neu] of addrOverrides) {
        if (sourceEdits.some((e) => e.from === oldLc)) continue;
        let n = 0;
        for (const f of Object.values(std.sources)) { const r = replaceAddress(f.content, oldLc, neu); f.content = r.text; n += r.count; }
        if (n) { sourceEdits.push({ from: oldLc, to: neu, occurrences: n }); usedAddrOverrides.add(oldLc); }
      }
      hadEdits = sourceEdits.length > 0;
      contracts[u.key] = {
        name: vc.name,
        fullyQualifiedName: vc.fullyQualifiedName,
        sourceAddress: vc.address,
        compilerVersion: vc.compilerVersion,
        evmVersion: evm,
        evmVersionOriginal: vc.evmVersion,
        stdJsonInput: std,
        sourceEdits,
        expectedMatch: sourceEdits.length === 0 && evm === vc.evmVersion,
        abi: vc.abi,
        originalConstructorArgs: vc.constructorArgs,
        modifiedSource: hadEdits,
      };
      // EVM features visible in source that the target cannot run (the compiled assembly is checked again before deploying)
      const hints = scanSourceFeatures(vc.stdJsonInput.sources).filter((h) => ['MCOPY', 'TSTORE', 'TLOAD', 'BLOBHASH', 'BLOBBASEFEE', 'CLZ'].includes(h.feature));
      const bad = unsupportedOnTarget(new Set(hints.map((h) => h.feature)), to);
      if (bad.length) warnings.push(`${vc.name}: source uses ${bad.map((b) => `${b.feature} (${b.needs})`).join(', ')} which ${to.name} (verified up to ${to.latestHardfork ?? 'pre-Shanghai'}) cannot run; compiling will fail rather than deploy broken code`);
    }

    // ---- constructor args ---------------------------------------------------------------
    const args: PlanArg[] = [];
    if (!noSource) {
      const ctorLookup: Lookup = (addr) => {
        const finding = u.analysis.addresses.find((x) => x.address.toLowerCase() === addr.toLowerCase() && x.where.startsWith('constructor:'));
        return { classification: finding?.classification ?? 'unknown', label: finding?.label, kind: finding?.kind };
      };
      for (const [i, p] of u.analysis.constructorInputs.entries()) {
        const dec = u.analysis.constructorArgs?.[i];
        const name = p.name || `arg${i}`;
        const initInfo = u.analysis.initialisation;
        let arg: PlanArg;
        if (initInfo?.constructorCall && initInfo.constructorCall.argName === name && dec) {
          // proxy constructor `_data`: decode the original initialiser call and let each argument be remapped
          const call = await planDecodedCall(initInfo.constructorCall, 'implementation', u.stepId, (inner) => [`${u.stepId}.${name}.${inner}`, `${name}.${inner}`, inner], dependsOn, u);
          const callAction = call.args.reduce<ArgAction>((m, x) => (rank[x.action] > rank[m] ? x.action : m), 'keep');
          const unresolved = call.args.some((x) => x.value === null || x.value === undefined);
          const raw = nameOverrides.get(`${u.stepId}.${name}`) ?? nameOverrides.get(name);
          if (raw !== undefined) {
            usedNameOverrides.add(nameOverrides.has(`${u.stepId}.${name}`) ? `${u.stepId}.${name}` : name);
            arg = { index: i, name, type: p.type, abiParam: p, original: dec.value, value: raw, action: 'keep', note: `set by --set ${name} (raw initialiser data)`, addresses: [] };
          } else {
            arg = {
              index: i, name, type: p.type, abiParam: p, original: dec.value, action: callAction, addresses: [], call,
              value: unresolved || JSON.stringify(call.args).includes('"$ref"') ? null : (call.selector + encodeArgs(call.args.map((x) => x.abiParam), call.args.map((x) => x.value)).slice(2)),
              note: `initialiser call ${call.signature} run by the proxy constructor; arguments are remappable individually`,
            };
          }
          if (initInfo.constructorCall.args.some((x) => x.addresses.some((ad) => ad.classification === 'eoa' || ad.classification === 'contract'))) {
            warnings.push(`${u.stepId}.${name}: the original initialiser's owner/admin/role addresses are not copied silently; give your own with --set <arg>=<address> or --set <arg>=deployer`);
          }
        } else {
          arg = await planArg({ p, index: i, stepId: u.stepId, nameKeys: [`${u.stepId}.${name}`, name], original: dec?.value, known: !!dec, lookup: ctorLookup, unit: u, mode: 'ctor', unknownNote: 'constructor argument unknown; provide with --set', dependsOn });
        }
        if (arg.call) { for (const y of arg.call.args) if (y.action === 'needs-input') needsInput.push(`${u.stepId}.${arg.name}.${y.name}`); }
        else if (arg.action === 'needs-input') needsInput.push(`${u.stepId}.${arg.name}`);
        args.push(arg);
      }
    }

    // ---- links ---------------------------------------------------------------------------
    const links: Record<string, string> = {};
    for (const lib of u.analysis.libraries) {
      const dep = unitByAddress.get(lib.address.toLowerCase());
      if (dep) { links[`${lib.file}:${lib.name}`] = `step:${dep.stepId}`; dependsOn.add(dep.stepId); }
      else links[`${lib.file}:${lib.name}`] = lib.address;
    }
    const verb = u.kind === 'library' ? 'Deploy library' : u.kind === 'implementation' ? 'Deploy implementation' : u.kind === 'proxy' ? 'Deploy proxy' : u.kind === 'beacon' ? 'Deploy beacon' : u.kind === 'minimal-proxy' ? 'Deploy EIP-1167 minimal proxy' : 'Deploy';
    steps.push({
      id: u.stepId, kind: u.kind, label: `${verb} ${vc.name}`, name: vc.name, sourceAddress: vc.address,
      contractKey: noSource ? 'implementation' : u.key, args, links, dependsOn: [...dependsOn],
      ...(noSource ? { dependsOn: ['implementation'] } : {}),
    });

    // ---- warnings ------------------------------------------------------------------------
    // immutables take their values from the constructor arguments: with no arguments there is nothing remapped that could make them differ
    if (u.analysis.immutableCount > 0 && u.analysis.constructorInputs.length > 0) warnings.push(`${vc.name}: ${u.analysis.immutableCount} immutable(s); their values come from the constructor args and will differ from the original where args are remapped`);
    if (hadEdits) warnings.push(`${vc.name}: source is modified (address remaps); the deployed bytecode intentionally differs from the original, which is not a mismatch`);
    if (!noSource && Object.values(vc.stdJsonInput.sources).some((f) => /hex\s*["']([0-9a-fA-F]{64})["']/.test(f.content))) {
      warnings.push(`${vc.name}: source contains a 32-byte hex literal (possibly a CREATE2 init-code hash, as in Uniswap V2 libraries); it is tied to the original factory and may not be valid for a different factory on ${to.name}`);
    }
  }
  for (const l of literals.filter((x) => x.action === 'needs-input')) {
    warnings.push(`Hard-coded ${l.label ? `${l.label} ` : ''}address ${l.original} in ${l.locations[0]?.file}:${l.locations[0]?.line} (${l.classification} on ${from.name}): ${l.note}`);
  }

  // ---- initialisation of proxies --------------------------------------------------------------
  const mainStep = steps.at(-1)!;
  let initSummary: ClonePlan['initialisation'] = { mode: 'none', frontRunnable: false, notes: [] };
  const init = a.initialisation;
  if (init && (a.implementation || isMinimal)) {
    const implAbiKey = 'implementation';
    const callSteps: PlanStep[] = [];
    let lastCallId: string | null = null; // each later initialiser (V2, V2_1, ...) runs only after the one before it
    const mkCall = async (idPrefix: 'init' | 'admin', info: { function: string; signature: string; selector: Hex; inputs: AbiParam[]; values?: DecodedCallInfo['args']; lookupAddrs?: DecodedCallInfo['args'] }, meta: { discovered: boolean; optional: boolean; sourceTx?: Hex; sourceCaller?: Address }, abiKey: string, note?: string) => {
      let id = `${idPrefix}:${info.function}`;
      if (steps.concat(callSteps).some((s) => s.id === id)) id = `${id}#${info.selector.slice(2)}`;
      const deps = new Set<string>([mainStep.id]);
      if (lastCallId) deps.add(lastCallId);
      const cargs: PlanArg[] = [];
      for (const [i, p] of info.inputs.entries()) {
        const dec = info.values?.[i];
        const finds = new Map((dec?.addresses ?? []).map((ad) => [ad.address.toLowerCase(), ad]));
        const arg = await planArg({
          p, index: i, stepId: id, nameKeys: [`${id}.${p.name || `arg${i}`}`, p.name || `arg${i}`], original: dec?.value, known: !!dec, mode: 'call', unit: null, dependsOn: deps,
          unknownNote: `${info.function}(${p.name ?? ''}) was not seen on ${from.name}; provide a value with --set ${p.name || `arg${i}`}=<value>`,
          lookup: (addr) => finds.get(addr.toLowerCase()) ?? { classification: 'unknown' },
        });
        cargs.push(arg);
      }
      const unresolved = cargs.filter((x) => x.action === 'needs-input' && (x.value === null || x.value === undefined));
      if (!meta.optional) for (const x of unresolved) needsInput.push(`${id}.${x.name}`);
      const verb = idPrefix === 'admin' ? 'Hand the proxy admin to another account' : meta.discovered ? 'Initialise (as the original was)' : meta.optional ? 'Initialise (detected from the ABI, optional)' : 'Initialise (detected from the ABI; required, no history found)';
      callSteps.push({
        id, kind: idPrefix === 'admin' ? 'admin' : 'initialise', label: `${verb}: ${info.signature}`, name: info.function, sourceAddress: a.contract.address, contractKey: abiKey, args: cargs, links: {},
        dependsOn: [...deps],
        call: { target: mainStep.id, function: info.function, signature: info.signature, selector: info.selector, discovered: meta.discovered, optional: meta.optional, sourceTx: meta.sourceTx, sourceCaller: meta.sourceCaller },
      });
      lastCallId = id;
      void note;
    };

    if (init.ifAdminProxy) {
      const orig = init.discoveredAdminCalls[0];
      const abiItem = a.contract.abi.find((i) => i.type === 'function' && i.name === 'changeAdmin')!;
      await mkCall('admin', { function: 'changeAdmin', signature: 'changeAdmin(address)', selector: selectorOfSignature('changeAdmin(address)'), inputs: abiItem.inputs ?? [], values: orig?.args }, { discovered: !!orig, optional: false, sourceTx: orig?.txHash, sourceCaller: orig?.from }, 'proxy');
      const adminStep = callSteps.at(-1)!;
      for (const x of adminStep.args) {
        if (x.action !== 'needs-input') continue;
        delete (x as { suggestion?: unknown }).suggestion;
        x.note = `the deploying account becomes the proxy admin, and an admin cannot call the implementation through the proxy; hand the admin role to another account before initialising${init.adminAddress ? ` (the original admin was ${init.adminAddress})` : ''}`;
      }
      warnings.push(`${a.contract.name}: the deployer becomes the proxy admin and a proxy admin cannot call the implementation, so the plan hands the admin role to another account (${adminStep.id}) before initialising; choose that account with --set newAdmin=<address>`);
    }

    const coveredByCtor = new Set(init.constructorCall ? [init.constructorCall.selector] : []);
    for (const d of init.discovered) {
      if (coveredByCtor.has(d.selector)) continue;
      await mkCall('init', { function: d.function, signature: d.signature, selector: d.selector, inputs: d.inputs, values: d.args }, { discovered: true, optional: false, sourceTx: d.txHash, sourceCaller: d.from }, implAbiKey);
    }
    const have = new Set([...init.discovered.map((d) => d.selector), ...(init.constructorCall ? [init.constructorCall.selector] : [])]);
    if (!init.constructorCall) {
      const natural = [...init.abiInitialisers].sort((x, y) => x.function.localeCompare(y.function, undefined, { numeric: true }));
      // with no history and no constructor data, the base initialiser is what makes the clone usable at all: required, not optional
      const baseIdx = !init.discovered.length ? natural.findIndex((f) => /^(initiali[sz]e|init|setUp)$/i.test(f.function)) : -1;
      for (const [i, f] of natural.entries()) {
        const sel = selectorOfSignature(f.signature);
        if (have.has(sel)) continue;
        await mkCall('init', { function: f.function, signature: f.signature, selector: sel, inputs: f.inputs }, { discovered: false, optional: i !== baseIdx }, implAbiKey);
      }
    }
    for (const s of callSteps) steps.push(s);

    const required = callSteps.filter((s) => s.kind === 'initialise' && !s.call!.optional);
    const optionalSteps = callSteps.filter((s) => s.kind === 'initialise' && s.call!.optional);
    const mode: NonNullable<ClonePlan['initialisation']>['mode'] = init.constructorCall && !required.length ? 'constructor-data' : callSteps.some((s) => s.kind === 'initialise') ? 'separate-transactions' : init.constructorCall ? 'constructor-data' : 'none';
    initSummary = { mode, frontRunnable: callSteps.some((s) => s.kind === 'initialise'), notes: [] };
    if (init.constructorCall) initSummary.notes.push(`the original proxy was initialised in its constructor with ${init.constructorCall.signature}`);
    if (init.constructorDataUndecoded) {
      warnings.push(`${mainStep.id}.${init.constructorDataUndecoded.argName}: constructor data (${init.constructorDataUndecoded.data.slice(0, 10)}...) does not match any function of the implementation ABI, so it is kept as raw bytes and not remappable`);
    }
    if (required.length || optionalSteps.length) {
      const sep = [...required, ...optionalSteps].map((s) => s.call!.function).join(', ');
      initSummary.notes.push(`initialised by separate transactions after deployment: ${sep}`);
      warnings.push(`Front-running risk: ${mainStep.name} is deployed and then initialised in separate transactions (${sep}); in between, anyone can call the initialiser and take ownership. Run deploy and initialise back-to-back from the same account on a private RPC, or deploy with the initialiser in the proxy constructor data.`);
    }
    if (required.length) {
      const rolePhrases = required.flatMap((s) => s.args.filter((x) => x.action === 'needs-input' && x.addresses.length).map((x) => `${s.id}.${x.name}`));
      if (rolePhrases.length) warnings.push(`Owner/admin/role arguments (${rolePhrases.join(', ')}) are not copied from ${from.name}; set your own, or pass --set <name>=deployer to use the deploying account.`);
    }
    if (optionalSteps.length) {
      const names = optionalSteps.map((s) => s.call!.signature).join(', ');
      warnings.push(`Detected from the implementation ABI but not seen on ${from.name} (explorer history${init.discovery.source === 'none' ? ' unavailable' : ' covers only the first transactions'}): ${names}. They are skipped until you supply their arguments with --set; later-version initialisers (V2, V2_1, ...) were usually called after an upgrade.`);
    }
    initSummary.notes.push(init.discovery.source === 'none' ? `initialiser history: none (${init.discovery.note ?? 'no source'})` : `initialiser history from ${init.discovery.source} (${init.discovery.scanned} transactions${init.discovery.note ? `; ${init.discovery.note}` : ''})`);
    if (init.discovery.source === 'none' && !init.constructorCall) {
      initSummary.notes.push(`transaction history unavailable (${init.discovery.note ?? 'no explorer'}); initialisers were detected from the implementation ABI only`);
    }
    if (init.implementationProtected === false && init.abiInitialisers.length) {
      warnings.push(`The implementation (${a.implementation?.contract.name}) can be initialised directly: it has ${init.abiInitialisers.map((i) => i.function).join(', ')} and no _disableInitializers() / constructor lock was found in its source. Initialise or lock the deployed implementation yourself.`);
    }
  }
  if (a.beacon) warnings.push(`Beacon proxy: the clone deploys implementation -> beacon (owner = the beacon constructor's owner argument, set yours) -> proxy; upgrading the beacon upgrades every proxy that points at it.`);

  const eoaArgs = steps.filter((s) => s.kind !== 'initialise' && s.kind !== 'admin').flatMap((s) => s.args.filter((x) => x.addresses.some((ad) => ad.classification === 'eoa' && !ad.suggested) && !x.call).map((x) => `${s.id}.${x.name}`));
  if (eoaArgs.length) warnings.push(`Owner/admin-style addresses (${eoaArgs.join(', ')}) point at accounts from ${from.name}; the clone will be controlled by whoever holds those keys unless you set your own.`);
  for (const w of [...a.warnings, ...(a.implementation?.warnings ?? []), ...(a.beacon?.warnings ?? [])]) if (!isLicenseWarning(w) && !warnings.includes(w)) warnings.push(w);
  // one licence per contract of the plan; the most restrictive one decides the verdict and the warnings
  const licenses: ContractLicense[] = [];
  for (const u of units) {
    if (u.kind === 'minimal-proxy') continue;
    const l = u.analysis.license;
    licenses.push({ role: (u.kind === 'contract' ? 'contract' : u.kind) as LicenseRole, name: u.analysis.contract.name, address: u.analysis.contract.address, id: l.id, ids: l.ids ?? (l.id ? [l.id] : []), class: l.class });
  }
  const overall = overallOf(licenses);
  warnings.push(...licenseWarnings({ overall, contracts: licenses }).filter((w) => !warnings.includes(w)));

  const allKeys = [...new Set(steps.flatMap((s) => s.args.flatMap((x) => [`${s.id}.${x.name}`, ...(x.call ? x.call.args.map((y) => `${s.id}.${x.name}.${y.name}`) : [])])))];
  for (const k of nameOverrides.keys()) if (!usedNameOverrides.has(k)) throw new CmcError(`--set ${k}: no constructor argument or initialiser argument with that name (names: ${allKeys.join(', ') || 'none'})`, 'INPUT');
  for (const k of addrOverrides.keys()) if (!usedAddrOverrides.has(k)) throw new CmcError(`--set ${k}=...: address not found in any constructor argument, initialiser argument or source`, 'INPUT');
  for (const k of usedAddrOverrides) applied.add(k);

  const plan: ClonePlan = {
    version: 1,
    planVersion: 2,
    from: { chainId: from.chainId, address: a.contract.address },
    to: { chainId: to.chainId },
    steps,
    contracts,
    warnings,
    unsupported,
    needsInput,
    overridesApplied: [...applied],
    license: overall,
    licenses,
    sourceLiterals: literals,
    initialisation: initSummary,
  };
  if (opts.create2) await predictCreate2(plan, opts.create2, opts.targetReader);
  return plan;
}

export { INITIALISER_NAME };
