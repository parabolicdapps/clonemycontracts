// usage: vite-node scripts/tezos-example-run.ts <outDir> [FixtureName]   full rewrite of the Locker fixture with the worked example's bodies as the "model" (no LLM): checks the whole pipeline incl. scenarios
import { ScriptedProvider } from '../src/llm/client.js';
import { rewrite } from '../src/pipeline/rewrite.js';
import { TezosPack } from '../src/targets/tezos/pack.js';
import { workedExample } from '../src/targets/tezos/prompts.js';
import { fixture } from '../test/helpers.js';

const bodies: Record<string, string> = {};
for (const m of workedExample().matchAll(/=== BODY: (\w+) ===\n([\s\S]*?)\n=== END BODY ===/g)) bodies[m[1]!] = m[2]!;
const llm = new ScriptedProvider((msgs) => { const u = msgs[msgs.length - 1]!.content; const unit = /Function to implement: `(\w+)`/.exec(u)?.[1] ?? /for `(\w+)`/.exec(u)?.[1] ?? ''; return `=== BODY: ${unit} ===\n${bodies[unit] ?? 'pass'}\n=== END BODY ===\nFIDELITY ${unit}: scripted`; });
const res = await rewrite({ source: { kind: 'file', path: fixture(process.argv[3] ?? 'CosmwasmLocker') }, pack: new TezosPack(), llm, outDir: process.argv[2]!, onProgress: (l) => console.log(l) });
console.log(res.status, JSON.stringify(res.report.behaviour).slice(0, 400));
