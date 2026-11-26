// Probes each chain's RPC for the newest EVM hardfork it executes, using eth_call of tiny init code (no state needed):
//   shanghai: PUSH0   cancun: TSTORE/TLOAD + MCOPY + BLOBHASH   prague: BLS12-381 G1ADD precompile (0x0b)   osaka: CLZ opcode
// Writes `latestHardfork` (highest fork whose probes all pass) and per-opcode `opcodes` support into src/chains/chains.json (null when the RPC could not be reached). Usage: node probe-hardforks.mjs [--write]
import { readFileSync, writeFileSync } from 'node:fs';
const file = new URL('../src/chains/chains.json', import.meta.url);
const chains = JSON.parse(readFileSync(file, 'utf8'));
const rpc = async (url, method, params) => {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'clonemycontracts/0.1' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(20000) });
  const j = await r.json();
  return j;
};
const T = '505f5ff3'; // POP PUSH0 PUSH0 RETURN
const opcodeProbes = {
  PUSH0: '0x5f5ff3',
  MCOPY: '0x600060006000' + '5e' + '5f5ff3',
  TSTORE: '0x60016000' + '5d' + '5f5ff3',
  TLOAD: '0x6000' + '5c' + T,
  BLOBHASH: '0x5f49' + T,
  BLOBBASEFEE: '0x4a' + T,
  CLZ: '0x600' + '11e' + T,
};
async function ok(url, data) {
  const j = await rpc(url, 'eth_call', [{ data }, 'latest']);
  return !j.error;
}
async function bls(url) {
  const j = await rpc(url, 'eth_call', [{ to: '0x000000000000000000000000000000000000000b', data: '0x' + '00'.repeat(256) }, 'latest']);
  return !j.error && typeof j.result === 'string' && j.result.length === 2 + 128 * 2;
}
const out = {};
for (const c of chains) {
  if (c.kind !== 'evm') continue;
  let res = null;
  for (const url of c.rpcUrls) {
    try {
      const id = parseInt((await rpc(url, 'eth_chainId', [])).result, 16);
      if (id !== c.chainId) continue;
      const opcodes = {};
      for (const [name, data] of Object.entries(opcodeProbes)) opcodes[name] = await ok(url, data);
      const prague = await bls(url);
      let latest = opcodes.PUSH0 ? 'shanghai' : 'paris';
      // blob opcodes are excluded here: chains without blobs (Arbitrum, Polygon) lack them but run Cancun's EVM semantics; they are recorded per opcode instead
      const cancun = ['MCOPY', 'TSTORE', 'TLOAD'].every((k) => opcodes[k]);
      if (opcodes.PUSH0 && cancun) latest = 'cancun';
      if (latest === 'cancun' && prague) latest = 'prague';
      if (latest === 'prague' && opcodes.CLZ) latest = 'osaka';
      const pass = { ...opcodes, BLS12_381: prague };
      res = { latest, pass, opcodes, url };
      break;
    } catch (e) { /* try next RPC */ }
  }
  out[c.alias] = res;
  console.log(c.alias.padEnd(18), res ? `${res.latest.padEnd(8)} ${JSON.stringify(res.pass)} via ${new URL(res.url).host}` : 'UNREACHABLE (left null)');
  c.latestHardfork = res ? res.latest : null;
  if (res) c.opcodes = res.opcodes; else delete c.opcodes;
}
if (process.argv.includes('--write')) { writeFileSync(file, JSON.stringify(chains, null, 2) + '\n'); console.log('wrote chains.json'); }
