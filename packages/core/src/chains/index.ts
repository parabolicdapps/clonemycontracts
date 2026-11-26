import raw from './chains.json' with { type: 'json' };
import { CmcError, type ChainInfo } from '../types.js';

export const CHAINS = raw as unknown as ChainInfo[];

export function getChain(idOrAlias: string | number): ChainInfo {
  const s = String(idOrAlias).toLowerCase();
  const c = CHAINS.find((c) => String(c.chainId) === s || c.alias === s || c.name.toLowerCase() === s);
  if (!c) {
    throw new CmcError(`Unknown chain "${idOrAlias}" (use a chain id or one of the aliases of the supported chains)`, 'INPUT');
  }
  return c;
}

/** The one message for a chain that cannot be used (zkSync-style chains need a different compiler); every surface uses it. */
export function unsupportedChainMessage(chain: ChainInfo): string {
  return `${chain.name} is not supported (zkSync-style chains need zksolc)`;
}

/** RPC URLs to try, in order: env override CMC_RPC_<CHAINID> (comma separated allowed), then registry defaults. */
export function rpcUrls(chain: ChainInfo): string[] {
  const env = process.env[`CMC_RPC_${chain.chainId}`];
  const extra = env ? env.split(',').map((s) => s.trim()).filter(Boolean) : [];
  return [...extra, ...chain.rpcUrls];
}

/** Find known counterparts of an address (any chain) by well-known kind. */
export function findWellKnown(address: string, chainId: number): { kind: string; label: string } | null {
  const chain = CHAINS.find((c) => c.chainId === chainId);
  if (!chain) return null;
  const a = address.toLowerCase();
  if (chain.wrappedNative && chain.wrappedNative.address.toLowerCase() === a) {
    return { kind: 'wrapped-native', label: chain.wrappedNative.symbol };
  }
  for (const [kind, addr] of Object.entries(chain.wellKnown)) {
    if (addr.toLowerCase() === a) return { kind, label: kind };
  }
  for (const [pair, f] of Object.entries(chain.chainlinkFeeds ?? {})) {
    if (f.address.toLowerCase() === a) return { kind: `chainlink:${pair}`, label: `Chainlink ${pair}` };
  }
  return null;
}

export function counterpartOf(kind: string, chainId: number): string | null {
  const chain = CHAINS.find((c) => c.chainId === chainId);
  if (!chain) return null;
  if (kind === 'wrapped-native') return chain.wrappedNative?.address ?? null;
  if (kind.startsWith('chainlink:')) return chain.chainlinkFeeds?.[kind.slice('chainlink:'.length)]?.address ?? null;
  return chain.wellKnown[kind] ?? null;
}
