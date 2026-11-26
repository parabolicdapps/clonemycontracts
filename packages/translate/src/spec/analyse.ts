import { fetchVerifiedContract, getChain, type VerifiedContract } from '@cmc/core';
import { compileVerified, type AstCompile } from './compile.js';
import { resolveRewriteTarget } from './proxy.js';
import { extractSpec } from './extract.js';
import { checkSpecAgainstAbi, type GateResult } from './gate.js';
import type { ContractSpec } from '../types.js';

export interface RewriteAnalysis { vc: VerifiedContract; comp: AstCompile; spec: ContractSpec; gate: GateResult }

const cache = new Map<string, { at: number; p: Promise<RewriteAnalysis> }>();
const TTL_MS = 30 * 60_000, MAX = 32;

/**
 * Fetch + compile (AST and ABI only, optimizer off) + spec + sanity gate for the plan, cached in memory per chain/address (30 min, in-flight requests
 * are shared). Unsupported sources (Vyper, Solidity < 0.4.12) reject with UnsupportedSourceError (code UNSUPPORTED).
 */
export function analyseForRewrite(chain: string | number, address: string, opts: { fresh?: boolean } = {}): Promise<RewriteAnalysis> {
  const key = `${getChain(chain).chainId}:${address.toLowerCase()}`;
  const hit = cache.get(key);
  if (hit && !opts.fresh && Date.now() - hit.at < TTL_MS) return hit.p;
  const p = (async () => {
    const given = await fetchVerifiedContract(chain as string, address);
    const tgt = await resolveRewriteTarget(chain, given);
    const vc = tgt.vc;
    const comp = await compileVerified(vc, { astOnly: true });
    const spec = extractSpec(comp, { address, chainId: vc.chainId, license: vc.license, ...(tgt.proxy ? { proxy: tgt.proxy } : {}) });
    return { vc, comp, spec, gate: checkSpecAgainstAbi(spec, comp.abi, vc.abi as any[]) };
  })();
  cache.set(key, { at: Date.now(), p });
  p.catch(() => cache.delete(key));
  while (cache.size > MAX) cache.delete(cache.keys().next().value as string);
  return p;
}
