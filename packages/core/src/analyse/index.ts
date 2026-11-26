import { getAddress } from 'viem';
import { counterpartOf, findWellKnown, getChain } from '../chains/index.js';
import { fetchVerifiedContract } from '../fetch/index.js';
import {
  CmcError, type AddressFinding, type Address, type CloneAnalysis, type Hex, type VerifiedContract, type ChainInfo, type DecodedArg, type SourceLiteral,
} from '../types.js';
import { constructorInputs, decodeConstructorArgs, findAddresses } from '../util/abi.js';
import { ZERO_ADDRESS, isAddress } from '../util/hex.js';
import { getClient } from '../util/rpc.js';
import { defaultEvmVersion, requiresPush0, supportsStandardJson } from './evm.js';
import { scanLiteralLocations } from './literals.js';
import { analyseInitialisation } from './init.js';
import { recoverConstructorArgs } from './ctorargs.js';
import {
  BEACON_SLOT, SEL_BEACON_IMPLEMENTATION, SEL_DESCRIPTION, SEL_FACET_ADDRESSES, abiLooksLikeDiamond, addressFromWord, decodeAddressArrayLength, decodeString, parseMinimalProxy,
} from './proxies.js';
import { fetchCreationTxHash, discoverEarlyTransactions, type EarlyTxResult } from '../fetch/history.js';
import { contractLicenseIds, licenseWarning, summariseLicenseIds } from './license.js';
import { detectTokenStandards } from './tokens.js';

export { classifyLicense, detectSourceLicenses, licenseReport, licenseWarnings, isLicenseWarning, mostRestrictive, summariseLicenseIds, contractLicenseIds, normaliseProviderLicense } from './license.js';
export type { LicenseReport, ContractLicense } from './license.js';
export { defaultEvmVersion, requiresPush0, EVM_VERSIONS } from './evm.js';
export { detectTokenStandards } from './tokens.js';
export { scanLiteralLocations, blankComments, replaceAddress } from './literals.js';
export { FEATURE_FORK, scanAssembly, scanSourceFeatures, unsupportedOnTarget, capEvmVersion } from './evm.js';
export { recoverConstructorArgs } from './ctorargs.js';
export { parseMinimalProxy, minimalProxyInitCode } from './proxies.js';

/** Minimal chain access, injectable for tests. */
export interface ChainReader {
  getCode(address: Address): Promise<Hex | undefined>;
  getStorageAt(address: Address, slot: Hex): Promise<Hex | undefined>;
  /** eth_call; used for beacon `implementation()`, diamond loupe probes and Chainlink `description()`. Optional: features degrade gracefully without it. */
  call?(to: Address, data: Hex): Promise<Hex | undefined>;
  /** eth_getTransactionByHash; used to recover constructor arguments from the creation transaction. */
  getTransaction?(hash: Hex): Promise<{ to: Address | null; input: Hex } | null | undefined>;
}

export function viemReader(chain: ChainInfo): ChainReader {
  const c = getClient(chain);
  return {
    getCode: (address) => c.getCode({ address }),
    getStorageAt: (address, slot) => c.getStorageAt({ address, slot }),
    call: async (to, data) => (await c.call({ to, data })).data,
    getTransaction: async (hash) => {
      const t = await c.getTransaction({ hash });
      return t ? { to: (t.to as Address | null) ?? null, input: t.input } : null;
    },
  };
}

export const PROXY_IMPL_SLOTS: { name: string; slot: Hex }[] = [
  { name: 'EIP-1967', slot: '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc' },
  { name: 'ZeppelinOS', slot: '0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3' },
];

const ADDRESS_LITERAL = /0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g;
const MAX_LITERAL_ADDRESSES = 60;

export function scanSourceLiterals(sources: Record<string, { content: string }>): { address: Address; file: string }[] {
  const seen = new Map<string, { address: Address; file: string }>();
  for (const [file, { content }] of Object.entries(sources)) {
    for (const m of content.matchAll(ADDRESS_LITERAL)) {
      const key = m[0].toLowerCase();
      if (!seen.has(key)) seen.set(key, { address: m[0] as Address, file });
    }
  }
  return [...seen.values()];
}

async function classify(addr: Address, chain: ChainInfo, reader: ChainReader | null): Promise<Pick<AddressFinding, 'classification' | 'label' | 'kind' | 'counterparts'>> {
  if (addr.toLowerCase() === ZERO_ADDRESS) return { classification: 'zero' };
  const wk = findWellKnown(addr, chain.chainId);
  if (wk) {
    return { classification: 'wellknown', label: wk.label, kind: wk.kind, counterparts: counterpartsFor(wk.kind, chain.chainId) };
  }
  if (!reader) return { classification: 'unknown' };
  try {
    const code = await reader.getCode(addr);
    if (!code || code === '0x') return { classification: 'eoa' };
    // a Chainlink-style feed that is not in the registry: match the target's feed by `description()`
    if (reader.call) {
      const desc = decodeString(await reader.call(addr, SEL_DESCRIPTION).catch(() => undefined));
      if (desc && /^[A-Za-z0-9.\-_ ]{1,24} \/ [A-Za-z0-9.\-_ ]{1,24}$/.test(desc)) {
        return { classification: 'wellknown', label: `Chainlink ${desc}`, kind: `chainlink:${desc}`, counterparts: counterpartsFor(`chainlink:${desc}`, chain.chainId) };
      }
    }
    return { classification: 'contract' };
  } catch {
    return { classification: 'unknown' };
  }
}

export async function counterpartsAll(kind: string): Promise<Record<string, Address>> {
  return counterpartsFor(kind, -1);
}
function counterpartsFor(kind: string, exceptChain: number): Record<string, Address> {
  const out: Record<string, Address> = {};
  for (const id of ALL_CHAIN_IDS()) {
    if (id === exceptChain) continue;
    const a = counterpartOf(kind, id);
    if (a) out[String(id)] = a as Address;
  }
  return out;
}
import { CHAINS } from '../chains/index.js';
const ALL_CHAIN_IDS = () => CHAINS.map((c) => c.chainId);

export interface AnalyseOptions {
  reader?: ChainReader | null;
  /** how to fetch the implementation of a proxy; defaults to the live fetchers */
  fetchImplementation?: (chainId: number, address: Address) => Promise<VerifiedContract>;
  /** analyse implementation (set false for the nested call) */
  followProxy?: boolean;
  /** explorer transaction history (injectable for tests); default: Etherscan V2 / Blockscout */
  fetchEarlyTransactions?: (chain: ChainInfo, address: Address, limit: number) => Promise<EarlyTxResult>;
  /** creation tx hash lookup (injectable for tests) */
  fetchCreationTxHash?: (chain: ChainInfo, address: Address) => Promise<Hex | null>;
  /** try to recover missing constructor args from the creation tx (default true) */
  recoverConstructorArgs?: boolean;
  /** fetch a linked library's source to read its licence (best effort; without it libraries carry no licence entry) */
  fetchLibrary?: (chainId: number, address: Address) => Promise<VerifiedContract>;
}

/** Analyse an already-fetched contract. */
export async function analyseContract(vc: VerifiedContract, opts: AnalyseOptions = {}): Promise<CloneAnalysis> {
  const chain = getChain(vc.chainId);
  const reader = opts.reader === undefined ? safeReader(chain) : opts.reader;
  const unsupported: string[] = [];
  const warnings: string[] = [];

  if (vc.language !== 'Solidity') unsupported.push(`${vc.language} ${vc.compilerVersion} contracts are not supported in v1 (Solidity only)`);
  if (vc.language === 'Solidity' && vc.compilerVersion && !supportsStandardJson(vc.compilerVersion)) unsupported.push(`solc ${vc.compilerVersion} is not supported for cloning: compilers before 0.4.11 have no standard JSON interface, which the exact recompile needs (supported: Solidity 0.4.11 and newer)`);
  if (!vc.compilerVersion) unsupported.push('compiler version unknown');

  // proxy: provider answer first, then on-chain implementation slots
  let proxy = vc.proxy;
  if (!proxy.isProxy && reader) {
    for (const s of PROXY_IMPL_SLOTS) {
      try {
        const v = await reader.getStorageAt(vc.address, s.slot);
        if (v && /^0x0{24}[0-9a-fA-F]{40}$/.test(v) && !/^0x0+$/.test(v)) {
          proxy = { isProxy: true, type: s.name, implementations: [getAddress(`0x${v.slice(26)}`) as Address] };
          break;
        }
      } catch {
        /* rpc unavailable: leave as non-proxy */
      }
    }
  }

  // EIP-1967 beacon proxy: the beacon holds the implementation
  let beaconAddr: Address | null = null;
  if (reader && opts.followProxy !== false) {
    try {
      beaconAddr = addressFromWord(await reader.getStorageAt(vc.address, BEACON_SLOT));
      if (beaconAddr && reader.call) {
        const impl = addressFromWord(await reader.call(beaconAddr, SEL_BEACON_IMPLEMENTATION).catch(() => undefined));
        if (impl) proxy = { isProxy: true, type: 'EIP-1967 beacon', implementations: [impl] };
        else beaconAddr = null;
      } else if (beaconAddr && !proxy.isProxy) beaconAddr = null;
    } catch { beaconAddr = null; }
  }
  let beacon: CloneAnalysis | null = null;
  if (beaconAddr && opts.followProxy !== false) {
    try {
      const fetchB = opts.fetchImplementation ?? ((id, a) => fetchVerifiedContract(id, a));
      beacon = await analyseContract(await fetchB(vc.chainId, beaconAddr), { ...opts, followProxy: false });
      unsupported.push(...beacon.unsupported.map((u) => `beacon: ${u}`));
    } catch (e) {
      unsupported.push(`beacon ${beaconAddr} could not be fetched: ${(e as Error).message}`);
    }
  }
  // EIP-2535 diamonds are not supported
  let diamond = abiLooksLikeDiamond(vc.abi);
  if (!diamond && reader?.call && opts.followProxy !== false) {
    diamond = decodeAddressArrayLength(await reader.call(vc.address, SEL_FACET_ADDRESSES).catch(() => undefined)) > 0;
  }
  if (diamond) unsupported.push('EIP-2535 diamond: facets and the selector table are not cloned (diamonds are unsupported for now)');

  let implementation: CloneAnalysis | null = null;
  if (proxy.isProxy && opts.followProxy !== false) {
    const implAddr = proxy.implementations[0];
    if (!implAddr) {
      unsupported.push('proxy detected but its implementation address could not be resolved');
    } else {
      try {
        const fetchImpl = opts.fetchImplementation ?? ((id, a) => fetchVerifiedContract(id, a));
        const iv = await fetchImpl(vc.chainId, implAddr);
        implementation = await analyseContract(iv, { ...opts, followProxy: false });
        if (proxy.implementations.length > 1) warnings.push(`Proxy has ${proxy.implementations.length} implementations (e.g. a diamond); only the first is cloned`);
      } catch (e) {
        unsupported.push(`implementation ${implAddr} could not be fetched: ${(e as Error).message}`);
      }
    }
    warnings.push('Proxy storage is not copied: the cloned proxy must be initialised (call its initializer) and its admin/owner set by you.');
  }

  const inputs = constructorInputs(vc.abi);
  let ctorHex = vc.constructorArgs;
  let ctorSource: CloneAnalysis['constructorArgsSource'] = ctorHex !== null ? 'provider' : 'unknown';
  if (ctorHex === null && inputs.length > 0 && opts.recoverConstructorArgs !== false && reader?.getTransaction) {
    const rec = await recoverConstructorArgs(vc, {
      fetchCreationTxHash: (a) => (opts.fetchCreationTxHash ?? fetchCreationTxHash)(chain, a),
      getTransaction: (h) => reader.getTransaction!(h),
    }).catch((e) => ({ args: null, note: (e as Error).message }));
    if (rec.args) { ctorHex = rec.args; ctorSource = 'creation-tx'; warnings.push(`Constructor arguments were not provided by ${vc.provider}; ${rec.note}.`); }
    else warnings.push(`Constructor arguments could not be recovered: ${rec.note}.`);
  }
  const decoded = decodeConstructorArgs(inputs, ctorHex);
  let constructorArgs: DecodedArg[] | null = null;
  if (decoded) {
    constructorArgs = inputs.map((p, i) => ({ index: i, name: p.name || `arg${i}`, type: p.type, abiParam: p, value: decoded[i] }));
  } else if (inputs.length > 0) {
    warnings.push('Constructor arguments are unknown; they must be supplied with --set.');
  }

  // collect addresses
  const findings: AddressFinding[] = [];
  const seen = new Set<string>();
  const pending: { address: Address; where: string }[] = [];
  for (const a of constructorArgs ?? []) {
    for (const f of findAddresses(a.abiParam, a.value)) {
      pending.push({ address: f.address, where: `constructor:${a.name}${f.path.length ? `[${f.path.join('.')}]` : ''}` });
    }
  }
  const literals = scanSourceLiterals(vc.stdJsonInput.sources);
  for (const l of literals.slice(0, MAX_LITERAL_ADDRESSES)) pending.push({ address: l.address, where: `source:${l.file}` });
  if (literals.length > MAX_LITERAL_ADDRESSES) warnings.push(`${literals.length} address literals in source; only the first ${MAX_LITERAL_ADDRESSES} classified`);
  const classCache = new Map<string, Awaited<ReturnType<typeof classify>>>();
  for (const p of pending) {
    const k = `${p.address.toLowerCase()}|${p.where}`;
    if (seen.has(k)) continue;
    seen.add(k);
    let cl = classCache.get(p.address.toLowerCase());
    if (!cl) {
      cl = await classify(p.address, chain, reader);
      classCache.set(p.address.toLowerCase(), cl);
    }
    findings.push({ address: p.address, where: p.where, ...cl });
  }

  // hard-coded address literals with locations
  const locs = scanLiteralLocations(vc.stdJsonInput.sources);
  const byAddr = new Map<string, typeof locs>();
  for (const l of locs) { const k = l.address.toLowerCase(); (byAddr.get(k) ?? byAddr.set(k, []).get(k)!).push(l); }
  const sourceLiterals: SourceLiteral[] = [];
  for (const [k, ls] of [...byAddr].slice(0, MAX_LITERAL_ADDRESSES)) {
    let cl = classCache.get(k);
    if (!cl) { cl = await classify(ls[0]!.address, chain, reader); classCache.set(k, cl); }
    const first = ls[0]!;
    sourceLiterals.push({ address: first.address, file: first.file, line: first.line, column: first.column, snippet: first.snippet, occurrences: ls.length, ...cl });
  }

  // initialisation of proxies
  let initialisation: CloneAnalysis['initialisation'] = null;
  if (proxy.isProxy && opts.followProxy !== false && implementation) {
    const cls = (addr: Address) => classify(addr, chain, reader);
    initialisation = await analyseInitialisation({
      vc, proxy, implementation, constructorArgs, classify: cls,
      readStorage: reader ? (slot) => reader.getStorageAt(vc.address, slot) : null,
      fetchEarly: (n) => (opts.fetchEarlyTransactions ?? ((c, a, l) => discoverEarlyTransactions(c, a, l, { creationBlock: vc.creationBlock, creationTxHash: vc.creationTxHash })))(chain, vc.address, n),
    });
  }

  const libraries = Object.entries(vc.libraries).flatMap(([file, m]) => Object.entries(m).map(([name, address]) => ({ file, name, address })));
  const effectiveEvm = vc.evmVersion ?? defaultEvmVersion(vc.compilerVersion);
  const tokenAbi = implementation ? implementation.contract.abi : vc.abi;
  const license = summariseLicenseIds(contractLicenseIds(vc));
  const lw = licenseWarning(license.class, license.id);
  if (lw) warnings.push(lw);
  const libraryLicenses: NonNullable<CloneAnalysis['libraryLicenses']> = [];
  if (opts.fetchLibrary) {
    for (const lib of libraries) {
      try {
        const lv = await opts.fetchLibrary(vc.chainId, lib.address as Address);
        const l = summariseLicenseIds(contractLicenseIds(lv));
        if (!libraryLicenses.some((x) => x.address.toLowerCase() === lib.address.toLowerCase())) libraryLicenses.push({ name: lv.name, address: lib.address, id: l.id, ids: l.ids, class: l.class });
      } catch { /* a library whose licence cannot be read simply has no entry */ }
    }
  }

  return {
    contract: vc,
    proxy,
    implementation,
    libraries,
    constructorInputs: inputs,
    constructorArgs,
    addresses: findings,
    immutableCount: Object.keys(vc.immutableReferences).length,
    tokenStandards: detectTokenStandards(tokenAbi),
    license,
    ...(libraryLicenses.length ? { libraryLicenses } : {}),
    evm: { effectiveEvmVersion: effectiveEvm, needsPush0: requiresPush0(effectiveEvm) },
    unsupported,
    warnings,
    sourceLiterals,
    initialisation,
    beacon,
    minimalProxy: null,
    constructorArgsSource: ctorSource,
  };
}

function safeReader(chain: ChainInfo): ChainReader | null {
  try {
    return viemReader(chain);
  } catch {
    return null;
  }
}

/** Analyse an EIP-1167 minimal proxy (no source of its own): analysis of the target implementation wrapped in a proxy stub. Null when the code is not a minimal proxy. */
export async function analyseMinimalProxy(address: Address, chainIdOrAlias: string | number, opts: AnalyseOptions = {}): Promise<CloneAnalysis | null> {
  const chain = getChain(chainIdOrAlias);
  const reader = opts.reader === undefined ? safeReader(chain) : opts.reader;
  if (!reader) return null;
  const implAddr = parseMinimalProxy(await reader.getCode(address).catch(() => undefined));
  if (!implAddr) return null;
  const fetchImpl = opts.fetchImplementation ?? ((id, a) => fetchVerifiedContract(id, a));
  const iv = await fetchImpl(chain.chainId, implAddr);
  const implementation = await analyseContract(iv, { ...opts, followProxy: false });
  const proxy = { isProxy: true, type: 'EIP-1167', implementations: [implAddr] };
  const stub: VerifiedContract = {
    address, chainId: chain.chainId, name: 'MinimalProxy', fullyQualifiedName: null, compilerVersion: '', language: 'Solidity',
    stdJsonInput: { language: 'Solidity', sources: {}, settings: {} }, evmVersion: null, optimizer: { enabled: false, runs: 0 },
    abi: iv.abi, constructorArgs: '0x', libraries: {}, creationTxHash: null, license: iv.license, proxy, immutableReferences: {}, matchType: null,
    provider: iv.provider, attempts: [],
  };
  const initialisation = await analyseInitialisation({
    vc: stub, proxy, implementation, constructorArgs: null, classify: (a) => classify(a, chain, reader), readStorage: null,
    fetchEarly: (n) => (opts.fetchEarlyTransactions ?? discoverEarlyTransactions)(chain, address, n),
  });
  return {
    contract: stub, proxy, implementation, libraries: [], constructorInputs: [], constructorArgs: [], addresses: [], immutableCount: 0,
    tokenStandards: implementation.tokenStandards, license: implementation.license, evm: implementation.evm, unsupported: [],
    warnings: [`${address} is an EIP-1167 minimal proxy of ${implAddr}: the implementation is cloned, then a new minimal proxy is deployed pointing at the clone. The proxy itself holds no logic and no state is copied.`],
    sourceLiterals: [], initialisation, beacon: null, minimalProxy: { standard: 'EIP-1167' }, constructorArgsSource: 'provider',
  };
}

/** Fetch + analyse. */
export async function analyse(address: string, from: string | number, opts: AnalyseOptions = {}): Promise<CloneAnalysis> {
  const chain = getChain(from);
  if (!isAddress(address)) throw new CmcError(`"${address}" is not a valid address`, 'INPUT');
  let vc: VerifiedContract;
  try {
    vc = await fetchVerifiedContract(chain.chainId, address);
  } catch (e) {
    // an unverified EIP-1167 clone has no source of its own, but its implementation usually does
    if (e instanceof CmcError && e.code === 'UNVERIFIED') {
      const m = await analyseMinimalProxy(address as Address, chain.chainId, opts).catch(() => null);
      if (m) return m;
    }
    throw e;
  }
  return analyseContract(vc, opts);
}
