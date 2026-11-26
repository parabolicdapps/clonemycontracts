#!/usr/bin/env node
// usage: node results-table.mjs <runs-dir> -> prints the markdown results table from <runs-dir>/*/report.json
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const dir = process.argv[2];
const rows = [];
for (const d of readdirSync(dir).sort()) {
  const f = join(dir, d, 'report.json');
  if (!existsSync(f)) continue;
  const r = JSON.parse(readFileSync(f, 'utf8'));
  const b = r.behaviour;
  rows.push(`| ${d} | ${r.path === 'template' ? `template (${r.standard})` : 'model'} | ${r.compile.ok ? (r.compile.round === 0 && r.path === 'template' ? 'n/a (no program)' : `round ${r.compile.round}`) : 'FAILED'} | ${b.ran ? `${b.passed} / ${b.failed} / ${b.notRunnable} / ${b.documented}` : 'not run'} | ${r.status} | ${Math.round(r.wallSecs)} s | ${r.usage.tokensIn} / ${r.usage.tokensOut} (${r.usage.requests} req) |`);
}
console.log('| contract | path | compile round | scenarios passed / failed / not runnable / documented | result | wall time | tokens in / out |');
console.log('|---|---|---|---|---|---|---|');
console.log(rows.join('\n'));
