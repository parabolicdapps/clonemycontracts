// Builds `chainlinkFeeds` in src/chains/chains.json from Chainlink's official reference data
// (https://reference-data-directory.vercel.app, the data behind docs.chain.link/data-feeds/price-feeds/addresses),
// and VERIFIES every address live: the proxy's `description()` must equal the pair name and `decimals()` must match.
// Entries that fail verification are dropped. Usage: node build-chainlink-feeds.mjs [--write]
import { readFileSync, writeFileSync } from 'node:fs';
import { createPublicClient, http, parseAbi, getAddress } from 'viem';
const file = new URL('../src/chains/chains.json', import.meta.url);
const chains = JSON.parse(readFileSync(file, 'utf8'));
const FILES = {
  eth: 'feeds-mainnet', arbitrum: 'feeds-ethereum-mainnet-arbitrum-1', base: 'feeds-ethereum-mainnet-base-1', optimism: 'feeds-ethereum-mainnet-optimism-1',
  polygon: 'feeds-matic-mainnet', bnb: 'feeds-bsc-mainnet', avalanche: 'feeds-avalanche-mainnet', gnosis: 'feeds-xdai-mainnet',
  sepolia: 'feeds-ethereum-testnet-sepolia', 'arbitrum-sepolia': 'feeds-ethereum-testnet-sepolia-arbitrum-1', 'base-sepolia': 'feeds-ethereum-testnet-sepolia-base-1', 'optimism-sepolia': 'feeds-ethereum-testnet-sepolia-optimism-1',
};
const PAIRS = ['ETH / USD', 'BTC / USD', 'USDC / USD', 'USDT / USD', 'DAI / USD', 'LINK / USD', 'EUR / USD', 'ETH / BTC', 'MATIC / USD', 'POL / USD', 'BNB / USD', 'AVAX / USD', 'AAVE / USD', 'UNI / USD', 'STETH / USD'];
const abi = parseAbi(['function description() view returns (string)', 'function decimals() view returns (uint8)']);
for (const c of chains) {
  const f = FILES[c.alias];
  if (!f) continue;
  const res = await fetch(`https://reference-data-directory.vercel.app/${f}.json`, { headers: { 'user-agent': 'clonemycontracts/0.1' } });
  const data = await res.json();
  let client;
  for (const u of c.rpcUrls) { try { const cl = createPublicClient({ transport: http(u, { timeout: 20000 }) }); if ((await cl.getChainId()) === c.chainId) { client = cl; break; } } catch {} }
  if (!client) { console.log(c.alias, 'no RPC; skipped'); continue; }
  const feeds = {};
  for (const pair of PAIRS) {
    // the plain feed (not an SVR / MEV-recapture variant)
    // the canonical feed: path is the pair slug (`eth-usd`); never SVR, hidden or backup variants
    const slug = pair.toLowerCase().replace(/ \/ /, '-');
    const cand = data
      .filter((x) => x.name === pair && x.proxyAddress && !x.svrDisplayLabel && !/svr|backup/i.test(x.path ?? '') && !x.docs?.hidden)
      .sort((a, b) => Number(b.path === slug) - Number(a.path === slug));
    for (const x of cand) {
      try {
        const address = getAddress(x.proxyAddress);
        const [d, dec] = await Promise.all([client.readContract({ address, abi, functionName: 'description' }), client.readContract({ address, abi, functionName: 'decimals' })]);
        if (d === pair && Number(dec) === Number(x.decimals)) { feeds[pair] = { address, decimals: Number(dec) }; break; }
        console.log(`  ${c.alias} ${pair}: MISMATCH description=${JSON.stringify(d)} decimals=${dec}`);
      } catch (e) { console.log(`  ${c.alias} ${pair}: not readable (${e.shortMessage ?? e.message?.split('\n')[0]})`); }
    }
  }
  c.chainlinkFeeds = feeds;
  console.log(c.alias.padEnd(18), Object.keys(feeds).length, 'feeds verified:', Object.keys(feeds).join(', '));
}
if (process.argv.includes('--write')) { writeFileSync(file, JSON.stringify(chains, null, 2) + '\n'); console.log('wrote chains.json'); }
