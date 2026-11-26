import { createPublicClient, fallback, http, type PublicClient } from 'viem';
import { getChain, rpcUrls } from '../chains/index.js';
import { CmcError, type ChainInfo } from '../types.js';

const clients = new Map<number, PublicClient>();

export function getClient(chainOrId: ChainInfo | number | string): PublicClient {
  const chain = typeof chainOrId === 'object' ? chainOrId : getChain(chainOrId);
  const cached = clients.get(chain.chainId);
  if (cached) return cached;
  const urls = rpcUrls(chain);
  const client = createPublicClient({
    transport: fallback(urls.map((u) => http(u, { timeout: 20_000, retryCount: 1 })), { retryCount: 1 }),
  }) as PublicClient;
  clients.set(chain.chainId, client);
  return client;
}

export function rpcError(chain: ChainInfo, e: unknown): CmcError {
  const msg = (e as Error)?.message?.split('\n')[0] ?? String(e);
  return new CmcError(`RPC for ${chain.name} (chain ${chain.chainId}) failed: ${msg}. Set CMC_RPC_${chain.chainId} to another endpoint.`, 'RPC');
}
