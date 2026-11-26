import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fetchJson } from '../util/http.js';
import { cacheDir } from '../compile/solc.js';
import { getClient } from '../util/rpc.js';
import type { Address, ChainInfo, Hex } from '../types.js';
import { isAddress } from '../util/hex.js';

export interface ExplorerTx {
  hash: Hex;
  from: Address;
  /** empty string / null for contract creation */
  to: Address | null;
  input: Hex;
  blockNumber: number;
  transactionIndex: number;
  failed: boolean;
}

/** Normalise an Etherscan-style `txlist` result (Etherscan V2 and Blockscout's compatible API return the same shape). */
export function normaliseTxList(raw: any): ExplorerTx[] {
  const rows: any[] = Array.isArray(raw?.result) ? raw.result : [];
  return rows
    .filter((r) => r && typeof r.hash === 'string' && typeof r.input === 'string')
    .map((r) => ({
      hash: r.hash as Hex,
      from: r.from as Address,
      to: typeof r.to === 'string' && isAddress(r.to) ? (r.to as Address) : null,
      input: r.input as Hex,
      blockNumber: Number(r.blockNumber),
      transactionIndex: Number(r.transactionIndex ?? 0),
      failed: r.isError === '1' || r.txreceipt_status === '0',
    }));
}

export interface EarlyTxResult { txs: ExplorerTx[]; source: 'etherscan' | 'blockscout' | 'rpc' | 'none'; note?: string }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rateLimited = (raw: any) => /too many|rate limit|limit reached/i.test(String(raw?.message ?? raw?.result ?? ''));

function historyCacheFile(chainId: number, address: string): string {
  const dir = join(cacheDir(), '..', 'history');
  mkdirSync(dir, { recursive: true });
  return join(dir, `${chainId}-${address.toLowerCase()}.json`);
}
/** Disk cache of successful lookups: a contract's first transactions never change. Disabled with CMC_NO_CACHE=1. */
function readCache(chainId: number, address: string): EarlyTxResult | null {
  if (process.env.CMC_NO_CACHE) return null;
  try { const f = historyCacheFile(chainId, address); return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as EarlyTxResult) : null; } catch { return null; }
}
function writeCache(chainId: number, address: string, r: EarlyTxResult) {
  if (process.env.CMC_NO_CACHE || !r.txs.length) return;
  try { writeFileSync(historyCacheFile(chainId, address), JSON.stringify(r)); } catch { /* cache is best effort */ }
}

async function getJsonRetrying(url: string): Promise<any> {
  // Blockscout/Etherscan answer rate limits with HTTP 200 and a message, so retry those here
  let raw: any = null;
  for (let i = 0; i < 4; i++) {
    raw = await fetchJson<any>(url);
    if (!rateLimited(raw)) return raw;
    await sleep(2000 * 2 ** i);
  }
  return raw;
}

/** The first `limit` transactions to or from `address`, oldest first (explorer API). Etherscan V2 when a key is set, else Blockscout. */
export async function fetchEarlyTransactions(chain: ChainInfo, address: Address, limit = 100): Promise<EarlyTxResult> {
  const notes: string[] = [];
  const key = process.env.ETHERSCAN_API_KEY;
  if (key && chain.explorer.etherscanV2) {
    try {
      const url = `https://api.etherscan.io/v2/api?chainid=${chain.chainId}&module=account&action=txlist&address=${address}&startblock=0&endblock=99999999&page=1&offset=${limit}&sort=asc&apikey=${key}`;
      const raw = await getJsonRetrying(url);
      const txs = normaliseTxList(raw);
      if (txs.length) return { txs, source: 'etherscan' };
      notes.push(`etherscan: ${raw?.message ?? 'no data'}`);
    } catch (e) { notes.push(`etherscan: ${(e as Error).message}`); }
  }
  if (chain.explorer.blockscoutApi) {
    try {
      const url = `${chain.explorer.blockscoutApi}/api?module=account&action=txlist&address=${address}&sort=asc&page=1&offset=${limit}`;
      const raw = await getJsonRetrying(url);
      const txs = normaliseTxList(raw);
      if (txs.length) return { txs, source: 'blockscout' };
      notes.push(`blockscout: ${raw?.message ?? 'no data'}`);
    } catch (e) { notes.push(`blockscout: ${(e as Error).message}`); }
  }
  return { txs: [], source: 'none', note: notes.join('; ') || 'no explorer API available for this chain' };
}

/** Creation transaction hash of a contract: Blockscout address endpoint, then Etherscan `getcontractcreation`. */
export async function fetchCreationTxHash(chain: ChainInfo, address: Address): Promise<Hex | null> {
  if (chain.explorer.blockscoutApi) {
    try {
      const raw = await fetchJson<any>(`${chain.explorer.blockscoutApi}/api/v2/addresses/${address}`);
      const h = raw?.creation_transaction_hash ?? raw?.creation_tx_hash;
      if (typeof h === 'string' && /^0x[0-9a-fA-F]{64}$/.test(h)) return h as Hex;
    } catch { /* try next */ }
  }
  const key = process.env.ETHERSCAN_API_KEY;
  if (key && chain.explorer.etherscanV2) {
    try {
      const raw = await fetchJson<any>(`https://api.etherscan.io/v2/api?chainid=${chain.chainId}&module=contract&action=getcontractcreation&contractaddresses=${address}&apikey=${key}`);
      const h = raw?.result?.[0]?.txHash;
      if (typeof h === 'string' && /^0x[0-9a-fA-F]{64}$/.test(h)) return h as Hex;
    } catch { /* give up */ }
  }
  return null;
}

export interface EarlyHints { creationBlock?: number | null; creationTxHash?: Hex | null }

/**
 * Keyless fallback: read the contract's first transactions straight from the chain RPC. Scans the creation block and the next
 * `window` blocks for transactions sent to `address`. Needs an RPC that still serves those blocks (archive access for old contracts).
 */
export async function scanRpcForCalls(chain: ChainInfo, address: Address, creationBlock: number, window = 120): Promise<EarlyTxResult> {
  const c = getClient(chain);
  const head = Number(await c.getBlockNumber());
  const last = Math.min(head, creationBlock + window);
  const txs: ExplorerTx[] = [];
  let failed = 0;
  for (let start = creationBlock; start <= last; start += 10) {
    const nums = Array.from({ length: Math.min(10, last - start + 1) }, (_, i) => start + i);
    const blocks = await Promise.all(nums.map((n) => c.getBlock({ blockNumber: BigInt(n), includeTransactions: true }).catch(() => null)));
    for (const b of blocks) {
      if (!b) { failed++; continue; }
      for (const t of b.transactions as any[]) {
        if (typeof t === 'string' || (t.to ?? '').toLowerCase() !== address.toLowerCase()) continue;
        txs.push({ hash: t.hash, from: t.from, to: t.to, input: t.input, blockNumber: Number(t.blockNumber), transactionIndex: Number(t.transactionIndex ?? 0), failed: false });
      }
    }
  }
  if (failed > (last - creationBlock + 1) / 2) return { txs: [], source: 'none', note: `RPC could not serve blocks ${creationBlock}..${last} (pruned? set CMC_RPC_${chain.chainId} to an archive endpoint)` };
  // reverted transactions must not be mistaken for initialisation
  for (const t of txs) {
    const r = await c.getTransactionReceipt({ hash: t.hash }).catch(() => null);
    if (r && r.status !== 'success') t.failed = true;
  }
  return { txs, source: 'rpc', note: `scanned blocks ${creationBlock}..${last}${failed ? ` (${failed} unavailable)` : ''}` };
}

/** Explorer API (with retries and a disk cache), then the keyless RPC scan around the creation block. */
export async function discoverEarlyTransactions(chain: ChainInfo, address: Address, limit = 100, hints: EarlyHints = {}): Promise<EarlyTxResult> {
  if (process.env.CMC_NO_HISTORY) return { txs: [], source: 'none', note: 'history lookup disabled (CMC_NO_HISTORY)' };
  const cached = readCache(chain.chainId, address);
  if (cached) return { ...cached, note: `${cached.source} (cached)` };
  const ex = await fetchEarlyTransactions(chain, address, limit);
  if (ex.txs.length) { writeCache(chain.chainId, address, ex); return ex; }
  let block = hints.creationBlock ?? null;
  try {
    if (block === null) {
      const hash = hints.creationTxHash ?? (await fetchCreationTxHash(chain, address));
      if (hash) block = Number((await getClient(chain).getTransactionReceipt({ hash })).blockNumber);
    }
  } catch { /* fall through to the note below */ }
  if (block === null) return { ...ex, note: `${ex.note ?? ''}; creation block unknown, so no RPC scan`.replace(/^; /, '') };
  try {
    const r = await scanRpcForCalls(chain, address, block);
    if (r.txs.length) writeCache(chain.chainId, address, r);
    return r.txs.length ? { ...r, note: `${r.note}; explorer: ${ex.note ?? 'none'}` } : { ...r, note: `${r.note ?? ''}; explorer: ${ex.note ?? 'none'}` };
  } catch (e) {
    return { ...ex, note: `${ex.note ?? ''}; RPC scan failed: ${(e as Error).message.split('\n')[0]}` };
  }
}
