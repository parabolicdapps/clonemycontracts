// Verifies chains.json against live RPCs: chain id, wrapped token symbol, code at every well-known address, PUSH0 support.
import { createPublicClient, http, parseAbi } from 'viem';
import { readFileSync } from 'node:fs';
const chains = JSON.parse(readFileSync(new URL('../src/chains/chains.json', import.meta.url), 'utf8'));
let bad = 0;
for (const c of chains) {
  if (c.kind !== 'evm') { console.log(`${c.alias}: skipped (${c.kind})`); continue; }
  let client, id;
  for (const u of c.rpcUrls) {
    try { client = createPublicClient({ transport: http(u, { timeout: 15000 }) }); id = await client.getChainId(); if (id === c.chainId) break; } catch {}
  }
  if (id !== c.chainId) { console.log(`${c.alias}: FAIL chain id ${id}`); bad++; continue; }
  const out = [];
  if (c.wrappedNative) {
    const sym = await client.readContract({ address: c.wrappedNative.address, abi: parseAbi(['function symbol() view returns (string)']), functionName: 'symbol' }).catch(() => null);
    out.push(`wrapped=${sym}${sym === c.wrappedNative.symbol ? '' : ' MISMATCH'}`); if (sym !== c.wrappedNative.symbol) bad++;
  }
  for (const [k, a] of Object.entries(c.wellKnown)) {
    const code = await client.getCode({ address: a }).catch(() => undefined);
    const ok = !!code && code !== '0x'; out.push(`${k}=${ok ? 'ok' : 'NOCODE'}`); if (!ok) bad++;
  }
  const p0 = await client.call({ data: '0x5f5ff3' }).then(() => true, () => false);
  out.push(`push0=${p0}${p0 === c.push0 ? '' : ' MISMATCH'}`); if (p0 !== c.push0) bad++;
  if (c.explorer.blockscoutApi) {
    const r = await fetch(`${c.explorer.blockscoutApi}/api/v2/stats`, { headers: { 'User-Agent': 'clonemycontracts/0.1' } }).catch(() => null);
    out.push(`blockscout=${r?.status}`); if (!r?.ok) bad++;
  }
  console.log(`${c.alias}: ${out.join(' ')}`);
}
process.exit(bad ? 1 : 0);
