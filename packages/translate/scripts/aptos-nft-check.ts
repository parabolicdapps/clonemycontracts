// usage: vite-node scripts/aptos-nft-check.ts: compiles the ERC-721 Digital Asset recipe in the sandbox
import { AptosPack } from '../src/targets/aptos/pack.js';
import { nftFiles } from '../src/targets/aptos/template-nft.js';
const c = await new AptosPack().compile(nftFiles());
console.log('nft recipe compiles:', c.ok, `${c.seconds.toFixed(0)}s`);
if (!c.ok) console.log(c.log.slice(0, 3000));
