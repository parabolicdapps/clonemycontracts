// usage: vite-node live-demo.ts <rewrite-out-dir> <scenario-id>
// Compiles the rewrite project, builds the plan for one scenario and runs it against a local solana-test-validator in the toolchain image.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_CONTAINER, extractResult, runToolchain, readTree } from '../src/pipeline/container.js';
import { buildProgramPlan } from '../src/targets/solana/adapter.js';

const dir = process.argv[2]!, id = process.argv[3]!;
const spec = JSON.parse(readFileSync(join(dir, 'spec.json'), 'utf8'));
const design = JSON.parse(readFileSync(join(dir, 'design.json'), 'utf8'));
const set = JSON.parse(readFileSync(join(dir, 'scenarios.json'), 'utf8'));
set.scenarios = set.scenarios.filter((s: any) => s.id === id);
const files = Object.fromEntries(Object.entries(readTree(join(dir, 'project'))).map(([k, v]) => [k, v.toString('utf8')]));
const c = await runToolchain(DEFAULT_CONTAINER, 'compile', files, { wantOut: true });
console.log('compile exit', c.code, c.seconds.toFixed(0), 's');
const built = buildProgramPlan({ spec, design, set });
const plan = JSON.stringify(built.plan);
writeFileSync(join(dir, 'live-plan.json'), plan);
const arts: Record<string, Buffer> = { 'app.so': c.out['app.so']!, 'app.json': c.out['app.json']! };
const seccompPath = new URL('../../../toolchains/solana/seccomp-io-uring.json', import.meta.url).pathname;
const r = await runToolchain(DEFAULT_CONTAINER, 'live-demo', { ...files, 'cmc/plan.json': plan }, { artifacts: arts, dockerArgs: `--security-opt seccomp=${seccompPath}` });
writeFileSync(join(dir, 'live-demo.log'), r.log);
console.log(r.log.split('===CMC_RESULT_BEGIN===')[0]!.slice(-1500));
const res: any = extractResult(r.log);
console.log('mode', res?.mode, 'fatal', res?.scenarios?.[0]?.fatal);
for (const s of res?.scenarios?.[0]?.steps ?? []) console.log(s.index, s.op, s.id ?? '', s.ok ?? s.exists, s.error_name ?? s.error ?? '', s.value ? JSON.stringify(s.value).slice(0, 120) : '', s.units ?? '');
