import { getChain, getClient } from '@cmc/core';
import type { TokenFacts } from '../types.js';

const ABI = [
  { type: 'function', name: 'name', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  { type: 'function', name: 'totalSupply', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
] as const;

/**
 * name / symbol / decimals / totalSupply of the ORIGINAL token read from the source chain (never from test fixtures).
 * Anything that cannot be read stays undefined: the deploy recipes then carry marked placeholders that fail when left unset.
 */
export async function readTokenFacts(chain: string, address: string): Promise<TokenFacts> {
  const facts: TokenFacts = {};
  try {
    const client = getClient(getChain(chain));
    const read = async <T>(fn: (typeof ABI)[number]['name']): Promise<T | undefined> => {
      try { return (await (client as any).readContract({ address, abi: ABI, functionName: fn })) as T; } catch { return undefined; }
    };
    const [name, symbol, decimals, totalSupply] = await Promise.all([read<string>('name'), read<string>('symbol'), read<number>('decimals'), read<bigint>('totalSupply')]);
    if (typeof name === 'string' && name) facts.name = name;
    if (typeof symbol === 'string' && symbol) facts.symbol = symbol;
    if (decimals !== undefined) facts.decimals = Number(decimals);
    if (totalSupply !== undefined) facts.totalSupply = totalSupply.toString();
    if (Object.keys(facts).length) facts.source = `${chain}:${address}`;
  } catch { /* RPC unreachable: placeholders */ }
  return facts;
}

/** UI amount string (whole tokens with at most `to` decimals) for `base` units of an `from`-decimals token; the remainder that does not fit is returned too. */
export function uiAmount(base: bigint, from: number, to: number): { ui: string; dust: bigint } {
  const div = 10n ** BigInt(Math.max(0, from - to));
  const kept = base / div;
  const dust = base - kept * div;
  const whole = kept / 10n ** BigInt(to);
  const frac = (kept % 10n ** BigInt(to)).toString().padStart(to, '0').replace(/0+$/, '');
  return { ui: frac ? `${whole}.${frac}` : `${whole}`, dust };
}
