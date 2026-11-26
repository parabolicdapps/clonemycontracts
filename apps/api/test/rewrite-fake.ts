import type { RewriteBackend } from '../src/rewrite.js';

/** A rewrite pipeline that never finishes on its own and stops when aborted. */
export function runRewriteFake(): RewriteBackend {
  return {
    targets: () => [],
    health: async () => ({ ok: true, model: { ok: true, message: '' }, sandbox: { ok: true, message: '' }, images: { solana: true, cosmwasm: true, aptos: true, tezos: true } }),
    plan: async () => { throw new Error('unused'); },
    run: (_req, o) => new Promise((_, reject) => { o.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); }),
  };
}
