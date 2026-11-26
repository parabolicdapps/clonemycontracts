// usage: vite-node mutant.ts <rewrite-out-dir>   (vesting): turns the vault into a seeded PDA token account in `fund` while initialize still creates an ATA
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SolanaPack } from '../src/targets/solana/pack.js';
import { readTree } from '../src/pipeline/container.js';

const dir = process.argv[2]!;
const spec = JSON.parse(readFileSync(join(dir, 'spec.json'), 'utf8'));
const design = JSON.parse(readFileSync(join(dir, 'design.json'), 'utf8'));
const set = JSON.parse(readFileSync(join(dir, 'scenarios.json'), 'utf8'));
const files = Object.fromEntries(Object.entries(readTree(join(dir, 'project'))).map(([k, v]) => [k, v.toString('utf8')]));
const ctx = files['programs/app/src/ctxs.rs']!;
const start = ctx.indexOf('pub struct FundAccounts');
const end = ctx.indexOf('}', start);
const seg = ctx.slice(start, end);
const mutated = seg.replace(/#\[account\(mut, associated_token::mint = token_mint, associated_token::authority = config, associated_token::token_program = token_program\)\]\n(\s*)pub token_vault/, '#[account(mut, seeds = [b"vault", token_mint.key().as_ref()], bump, token::mint = token_mint, token::authority = config, token::token_program = token_program)]\n$1pub token_vault');
if (mutated === seg) throw new Error('mutation did not apply');
files['programs/app/src/ctxs.rs'] = ctx.slice(0, start) + mutated + ctx.slice(end);
const pack = new SolanaPack();
const c = await pack.compile(files);
console.log('mutant compiles:', c.ok);
const run = await pack.runScenarios(files, c, design, spec, set);
const failed = run.outcomes.filter((o) => o.status === 'failed');
console.log('conformance:', run.conformance);
console.log(`scenarios: ${run.outcomes.length}, failed ${failed.length}, passed ${run.outcomes.filter((o) => o.status === 'passed').length}, not runnable ${run.outcomes.filter((o) => o.status === 'not-runnable').length}`);
for (const f of failed.slice(0, 4)) console.log(f.id, JSON.stringify(f.mismatches[0]).slice(0, 220));
