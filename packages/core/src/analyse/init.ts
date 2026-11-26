import type {
  AbiItem, Address, AddressFinding, CloneAnalysis, DecodedArg, DecodedCallInfo, DiscoveredCall, Hex, InitialisationInfo, ProxyInfo, VerifiedContract,
} from '../types.js';
import { findAddresses } from '../util/abi.js';
import { decodeCall, initialiserFunctions, INITIALISER_NAME, signatureOf, selectorOf } from '../util/calls.js';
import type { EarlyTxResult } from '../fetch/history.js';

export const ERC1967_ADMIN_SLOT: Hex = '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103';
export const ZOS_ADMIN_SLOT: Hex = '0x10d6a54a4754c8869d6886b5f5d7fbfa5b4522237ea5c60d11bc4e7a1ff9390b';

type Classify = (addr: Address) => Promise<Pick<AddressFinding, 'classification' | 'label' | 'kind'>>;

export interface InitContext {
  vc: VerifiedContract;
  proxy: ProxyInfo;
  implementation: CloneAnalysis | null;
  constructorArgs: DecodedArg[] | null;
  classify: Classify;
  readStorage: ((slot: Hex) => Promise<Hex | undefined>) | null;
  fetchEarly: (limit: number) => Promise<EarlyTxResult>;
}

async function toCallInfo(target: 'proxy' | 'implementation', abiItem: AbiItem, selector: Hex, values: unknown[], classify: Classify): Promise<DecodedCallInfo> {
  const inputs = abiItem.inputs ?? [];
  const args: DecodedCallInfo['args'] = [];
  for (const [i, p] of inputs.entries()) {
    const addresses = [];
    for (const f of findAddresses(p, values[i])) {
      const c = await classify(f.address);
      addresses.push({ path: f.path, address: f.address, classification: c.classification, label: c.label, kind: c.kind });
    }
    args.push({ index: i, name: p.name || `arg${i}`, type: p.type, abiParam: p, value: values[i], addresses });
  }
  return { target, selector, function: abiItem.name!, signature: signatureOf(abiItem), inputs, args };
}

/** Constructors / initialisers that mark an implementation as protected against being initialised directly. */
export function implementationLooksProtected(vc: VerifiedContract): boolean | null {
  const srcs = Object.values(vc.stdJsonInput.sources).map((s) => s.content);
  if (srcs.some((c) => /_disableInitializers\s*\(/.test(c))) return true;
  if (srcs.some((c) => /constructor\s*\([^)]*\)[^{]*\{[^}]*\b_?initialized\s*=\s*(true|1|type\s*\(\s*uint\d*\s*\)\s*\.max)/s.test(c))) return true;
  if (srcs.some((c) => /\bInitializable\b|\binitializer\b|\bonlyInitializing\b/.test(c)) || initialiserFunctions(vc.abi).length > 0) return false;
  return null;
}

export const isAdminChangeFn = (i: AbiItem) => i.type === 'function' && i.name === 'changeAdmin';

export async function analyseInitialisation(c: InitContext): Promise<InitialisationInfo> {
  const implAbi = c.implementation?.contract.abi ?? [];
  const proxyAbi = c.vc.abi;
  const info: InitialisationInfo = {
    constructorCall: null,
    constructorDataUndecoded: null,
    adminAddress: null,
    ifAdminProxy: false,
    discovered: [],
    discoveredAdminCalls: [],
    abiInitialisers: initialiserFunctions(implAbi).map((i) => ({ function: i.name!, signature: signatureOf(i), inputs: i.inputs ?? [] })),
    discovery: { source: 'none', scanned: 0 },
    implementationProtected: c.implementation ? implementationLooksProtected(c.implementation.contract) : null,
  };

  // admin on the source chain
  if (c.readStorage) {
    for (const slot of [ERC1967_ADMIN_SLOT, ZOS_ADMIN_SLOT]) {
      try {
        const v = await c.readStorage(slot);
        if (v && /^0x0{24}[0-9a-fA-F]{40}$/.test(v) && !/^0x0+$/.test(v)) { info.adminAddress = `0x${v.slice(26)}` as Address; break; }
      } catch { /* rpc unavailable */ }
    }
  }
  const ctorAdmin = (c.vc.abi.find((i) => i.type === 'constructor')?.inputs ?? []).some((p) => p.type === 'address' && /admin|owner/i.test(p.name ?? ''));
  info.ifAdminProxy = proxyAbi.some(isAdminChangeFn) && proxyAbi.some((i) => i.type === 'function' && i.name === 'admin') && proxyAbi.some((i) => i.type === 'function' && /^upgradeTo/.test(i.name ?? '')) && !ctorAdmin;

  // constructor `_data`
  if (c.implementation && c.constructorArgs) {
    for (const a of c.constructorArgs) {
      if (a.type !== 'bytes' || typeof a.value !== 'string' || a.value.length < 10) continue;
      const d = decodeCall(implAbi, a.value);
      if (d) {
        info.constructorCall = { ...(await toCallInfo('implementation', d.item, d.selector, d.values, c.classify)), argName: a.name };
        break;
      }
      info.constructorDataUndecoded = { argName: a.name, data: a.value as Hex };
    }
  }

  // early transactions to the proxy
  const early = await c.fetchEarly(100);
  info.discovery = { source: early.source, scanned: early.txs.length, note: early.note };
  const seen = new Set<string>();
  let order = 0;
  for (const tx of early.txs) {
    if (tx.failed || !tx.to || tx.to.toLowerCase() !== c.vc.address.toLowerCase() || tx.input.length < 10) continue;
    const selector = tx.input.slice(0, 10).toLowerCase();
    const dImpl = decodeCall(implAbi, tx.input);
    const dProxy = dImpl ? null : decodeCall(proxyAbi, tx.input);
    if (dProxy && isAdminChangeFn(dProxy.item) && !seen.has(selector)) {
      seen.add(selector);
      info.discoveredAdminCalls.push({ ...(await toCallInfo('proxy', dProxy.item, dProxy.selector, dProxy.values, c.classify)), txHash: tx.hash, from: tx.from, blockNumber: tx.blockNumber, order: order++ });
    } else if (dImpl && INITIALISER_NAME.test(dImpl.item.name ?? '') && !seen.has(selector)) {
      seen.add(selector);
      info.discovered.push({ ...(await toCallInfo('implementation', dImpl.item, dImpl.selector, dImpl.values, c.classify)), txHash: tx.hash, from: tx.from, blockNumber: tx.blockNumber, order: order++ });
    }
  }
  return info;
}

export { selectorOf };
