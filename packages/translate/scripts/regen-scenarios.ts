// usage: vite-node scripts/regen-scenarios.ts <rewrite-out-dir>   regenerate scenarios.json (ground truth on anvil) for the contract of spec.json with the CURRENT explorer
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fetchVerifiedContract } from '@cmc/core';
import { compileVerified } from '../src/spec/compile.js';
import { OriginalRunner } from '../src/scenario/original.js';
import { generateScenarios, recordGroundTruth, verifyInitialValues } from '../src/scenario/generate.js';

const dir = process.argv[2]!;
const spec = JSON.parse(readFileSync(join(dir, 'spec.json'), 'utf8'));
const vc = await fetchVerifiedContract(spec.source.chainId ?? 'eth', spec.source.address);
const comp = await compileVerified(vc);
const runner = await OriginalRunner.start(comp.abi, comp.creation);
try {
  await verifyInitialValues(spec, runner);
  const set = await generateScenarios(spec, runner, { onProgress: (m) => console.log(m) });
  const gt = await recordGroundTruth(set, runner, () => {});
  set.scenarios = set.scenarios.filter((s) => !gt.fatal.some((f) => f.startsWith(`${s.id}:`)));
  writeFileSync(join(dir, 'scenarios.json'), JSON.stringify(set, null, 2) + '\n');
  console.log(`${set.scenarios.length} scenarios`);
} finally { await runner.stop(); }
