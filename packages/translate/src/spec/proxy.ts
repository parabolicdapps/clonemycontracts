import { CmcError, fetchVerifiedContract, getChain, getClient, initialiserFunctions, parseMinimalProxy, type AbiItem, type VerifiedContract } from '@cmc/core';
import type { ProxyInfoSpec } from '../types.js';

export interface ProxyReader {
  getCode(address: string): Promise<string | undefined>;
  getStorageAt(address: string, slot: string): Promise<string | undefined>;
  call(to: string, data: string): Promise<string | undefined>;
}

const SLOTS = [
  { name: 'EIP-1967', slot: '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc' },
  { name: 'ZeppelinOS', slot: '0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3' },
];
const BEACON_SLOT = '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50';
const SEL_BEACON_IMPLEMENTATION = '0x5c60da1b';
const word = (v?: string) => (v && /^0x0{24}[0-9a-fA-F]{40}$/.test(v) && !/^0x0+$/.test(v) ? (`0x${v.slice(26)}` as string) : null);

export const chainReader = (chain: string | number): ProxyReader => {
  const c = getClient(getChain(chain)) as any;
  return {
    getCode: (address) => c.getCode({ address }),
    getStorageAt: (address, slot) => c.getStorageAt({ address, slot }),
    call: async (to, data) => (await c.call({ to, data })).data,
  };
};

/**
 * Is `vc` a proxy, and where is its implementation? Provider flag first, then EIP-1967 / ZeppelinOS slots, EIP-1967 beacon, EIP-1167 minimal proxy.
 * Returns null when it is not a proxy. Returns `{ implementation: null }` when it looks like a proxy shell whose implementation cannot be resolved.
 */
export async function detectProxy(vc: Pick<VerifiedContract, 'address' | 'name' | 'proxy' | 'abi'>, reader: ProxyReader | null): Promise<{ type: string; implementation: string | null } | null> {
  if (vc.proxy?.isProxy) return { type: vc.proxy.type ?? 'proxy', implementation: vc.proxy.implementations[0] ?? null };
  if (reader) {
    for (const s of SLOTS) { try { const a = word(await reader.getStorageAt(vc.address, s.slot)); if (a) return { type: s.name, implementation: a }; } catch { /* rpc */ } }
    try {
      const beacon = word(await reader.getStorageAt(vc.address, BEACON_SLOT));
      if (beacon) { const impl = word(await reader.call(beacon, SEL_BEACON_IMPLEMENTATION).catch(() => undefined)); return { type: 'EIP-1967 beacon', implementation: impl }; }
    } catch { /* rpc */ }
    try { const m = parseMinimalProxy(await reader.getCode(vc.address)); if (m) return { type: 'EIP-1167', implementation: m }; } catch { /* rpc */ }
  }
  // a verified proxy shell (TransparentUpgradeableProxy, ERC1967Proxy, ...) that no slot resolved: never rewrite the shell silently
  if (/Proxy/i.test(vc.name) && !(vc.abi as AbiItem[]).some((i) => i.type === 'function' && ['transfer', 'balanceOf', 'totalSupply'].includes(i.name ?? ''))) return { type: 'proxy (unresolved)', implementation: null };
  return null;
}

/** The ABI initialiser to run behind the proxy (the longest `initialize*` function), or null. */
export function pickInitializer(abi: AbiItem[]): AbiItem | null {
  const c = initialiserFunctions(abi).sort((a, b) => (b.inputs?.length ?? 0) - (a.inputs?.length ?? 0));
  return c[0] ?? null;
}

export interface RewriteTarget { vc: VerifiedContract; proxy: ProxyInfoSpec | null }

/** Resolve what a rewrite targets: the contract itself, or - for a proxy - the implementation behind it (refusing when it cannot be resolved). */
export async function resolveRewriteTarget(chain: string | number, vc: VerifiedContract, opts: { reader?: ProxyReader | null; fetchImpl?: (chain: string | number, address: string) => Promise<VerifiedContract> } = {}): Promise<RewriteTarget> {
  const reader = opts.reader === undefined ? (() => { try { return chainReader(chain); } catch { return null; } })() : opts.reader;
  const d = await detectProxy(vc, reader);
  if (!d) return { vc, proxy: null };
  if (!d.implementation) throw new CmcError(`${vc.address} is a proxy (${d.type}) whose implementation could not be resolved: refusing to rewrite the proxy shell (${vc.name}), which holds no logic`, 'UNSUPPORTED');
  const implVc = await (opts.fetchImpl ?? ((c, a) => fetchVerifiedContract(c as string, a)))(chain, d.implementation);
  const init = pickInitializer(implVc.abi as AbiItem[]);
  return { vc: implVc, proxy: { address: vc.address, type: d.type, implementation: d.implementation, proxyName: vc.name, implementationName: implVc.name, ...(init ? { initializer: init.name! } : {}) } };
}
