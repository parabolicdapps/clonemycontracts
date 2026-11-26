import type { ScenarioSet, Step } from '../../types.js';
import type { ScenarioOutcomeLike } from '../pack.js';
import { sameValue } from '../solana/compare.js';
import type { AptosDesign } from './design-types.js';
import { ACTOR_ADDR, type Mark, type TestMeta, type TestPlan, type TestResult } from './adapter.js';

const deepStr = (v: unknown): unknown => (typeof v === 'number' ? String(v) : Array.isArray(v) ? v.map(deepStr) : v);
const canon = (a: string): string => { const h = a.replace(/^@?0x/, '').toLowerCase().replace(/^0+/, ''); return h === '' ? '0' : h; };

/** Printed Move value -> the neutral representation used by the original side. */
export function normalizePrinted(raw: string, names: Map<string, string>): unknown {
  const v = raw.trim();
  if (/^@0x[0-9a-fA-F]+$/.test(v)) { const c = canon(v); return c === '0' ? 'zero' : names.get(c) ?? `@0x${c}`; }
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^\d+$/.test(v)) return v;
  if (/^".*"$/s.test(v)) return v.slice(1, -1);
  if (/^0x[0-9a-fA-F]*$/.test(v)) return v.toLowerCase();
  return v;
}

function nameMap(r: TestResult): Map<string, string> {
  const m = new Map<string, string>();
  for (const [a, addr] of Object.entries(ACTOR_ADDR)) m.set(canon(addr === '@app' ? '@0xcafe' : addr), `actor:${a}`);
  for (const [k, v] of r.prints) { const t = /^tok:(.+)\|0$/.exec(k); if (t) m.set(canon(v), `token:${t[1]}`); if (k === 'contract|0') m.set(canon(v), 'contract'); }
  return m;
}

const fmtFailure = (r: TestResult): string => { const f = r.failure; return f ? (f.kind === 'abort' ? `abort code ${f.abortCode}${f.location ? ` in ${f.location}` : ''}` : `${f.message}${f.location ? ` in ${f.location}` : ''}`) : 'failed'; };
const stepText = (st: Step): string => (st.type === 'call' ? `${st.fn}(${st.args.map((a) => JSON.stringify(a)).join(', ')}) by ${st.actor}` : st.label);

export function compareResults(set: ScenarioSet, plan: TestPlan, results: Map<string, TestResult>, design: AptosDesign): ScenarioOutcomeLike[] {
  const dropped = new Map((design.droppedFns ?? []).map((d) => [d.fn, d.reason]));
  const out: ScenarioOutcomeLike[] = [];
  for (const sc of set.scenarios) {
    const base = { id: sc.id, title: sc.title, kind: sc.kind, ...(sc.fn ? { fn: sc.fn } : {}) };
    const nr0 = plan.notRunnable.get(sc.id);
    if (nr0) { out.push({ ...base, status: 'not-runnable', mismatches: [], notRunnable: [nr0], checked: 0, notes: [] }); continue; }
    const mismatches: ScenarioOutcomeLike['mismatches'] = [];
    const notRunnable: string[] = []; const notes: string[] = [];
    let checked = 0; let blocked = false;
    const markOf = (r: TestResult): Mark | undefined => { const l = r.failure?.line; const mk = l !== undefined ? plan.marks.get(l) : undefined; return mk && mk.test === r.name ? mk : undefined; };
    for (const t of plan.tests.filter((x) => x.scenarioId === sc.id)) {
      const r = results.get(t.name);
      if (!r) { notRunnable.push(`${t.name}: the test did not run`); blocked = true; continue; }
      const doc = (step: number | undefined) => (step !== undefined ? t.documented.get(step) : undefined);
      if (t.kind === 'revert-deploy') {
        if (r.passed) mismatches.push({ at: 'deploy', what: 'deployment', expected: `revert${sc.deploy.expect?.reason ? ` (${sc.deploy.expect.reason})` : ''}`, actual: 'success' });
        else checked++;
        continue;
      }
      if (t.kind === 'revert-step') {
        const st = sc.steps[t.step!]!;
        const exp = st.type === 'call' ? `revert${st.expect?.reason ? ` (${st.expect.reason})` : ''}` : 'revert';
        if (r.passed) { mismatches.push({ at: String(t.step), what: stepText(st), expected: exp, actual: 'success', ...(doc(t.step) ? { documented: doc(t.step)! } : {}) }); continue; }
        const mk = markOf(r);
        if (mk && mk.step === t.step) { checked++; if (r.failure?.kind === 'abort' && st.type === 'call' && st.expect?.reason) notes.push(`${stepText(st)}: reverted (original: "${st.expect.reason}", rewrite: ${fmtFailure(r)})`); }
        else if (mk && mk.kind === 'deploy') { notRunnable.push(`step ${t.step}: the deployment itself aborted (${fmtFailure(r)})`); blocked = true; }
        else if (mk) { notRunnable.push(`step ${t.step}: an earlier step ${mk.step} aborted first (${fmtFailure(r)})`); blocked = true; }
        else { notRunnable.push(`step ${t.step}: aborted at an unmapped place (${fmtFailure(r)})`); blocked = true; }
        continue;
      }
      // main test
      let failedAt = Infinity;
      if (!r.passed) {
        const mk = markOf(r);
        if (!mk) { mismatches.push({ at: '?', what: 'scenario run', expected: 'success', actual: fmtFailure(r) }); failedAt = -1; }
        else if (mk.kind === 'deploy') { mismatches.push({ at: 'deploy', what: 'deployment', expected: 'success', actual: `revert (${fmtFailure(r)})` }); failedAt = -1; }
        else {
          const st = sc.steps[mk.step!]!;
          mismatches.push({ at: String(mk.step), what: stepText(st), expected: 'success', actual: `revert (${fmtFailure(r)})`, ...(doc(mk.step) ? { documented: doc(mk.step)! } : {}) });
          failedAt = mk.step!;
        }
      }
      if (failedAt !== -1) checked += 1 + t.calls.filter((i) => i < failedAt).length;
      const names = nameMap(r);
      for (const v of t.views) {
        if (v.step >= failedAt) continue;
        const st = sc.steps[v.step] as Extract<Step, { type: 'view' }>;
        const got: unknown[] = [];
        let missing = false;
        for (let j = 0; j < v.count; j++) { const raw = r.prints.get(`${v.step}|${j}`); if (raw === undefined) { missing = true; break; } got.push(normalizePrinted(raw, names)); }
        if (missing) { notRunnable.push(`${v.label}: no value was printed`); continue; }
        const exp = deepStr(st.expect);
        const actual = v.count === 1 ? got[0] : got;
        const scale = v.scales.length === 1 ? (v.scales[0] === 'token-balance' ? 'token' : v.scales[0]) : undefined;
        let ok: { ok: boolean; note?: string };
        if (v.count > 1 && Array.isArray(exp) && exp.length === v.count) {
          ok = { ok: true };
          for (let j = 0; j < v.count && ok.ok; j++) { const sj = v.scales[j]; ok = sameValue(exp[j], got[j], sj === 'token-balance' ? 'token' : sj, BigInt(design.decimals.divisor)); }
        } else ok = sameValue(exp, actual, scale, BigInt(design.decimals.divisor));
        if (!ok.ok) mismatches.push({ at: String(v.step), what: v.label, expected: exp, actual, ...(doc(v.step) ? { documented: doc(v.step)! } : {}) });
        else { checked++; if (ok.note) notes.push(`${v.label}: ${ok.note}`); }
      }
    }
    // functions the design deliberately does not have
    for (const [i, st] of sc.steps.entries()) {
      if (!dropped.has(st.fn)) continue;
      const exp = st.type === 'call' ? st.expect?.status ?? 'success' : JSON.stringify(st.expect);
      if (sc.fn === st.fn && !mismatches.some((x) => x.what === stepText(st))) mismatches.push({ at: String(i), what: stepText(st), expected: exp, actual: 'no equivalent in the Aptos design', documented: `${st.fn}: ${dropped.get(st.fn)}` });
      else if (!notes.some((n) => n.startsWith(`${st.fn} `))) notes.push(`${st.fn} is used as a setup step or read of this scenario and has no equivalent in the Aptos design: it was left out (see the design notes); the other checks still ran`);
    }
    const hard = mismatches.filter((x) => !x.documented);
    const status: ScenarioOutcomeLike['status'] = hard.length ? 'failed' : mismatches.length ? 'documented-difference' : blocked || checked === 0 ? 'not-runnable' : 'passed';
    out.push({ ...base, status, mismatches, notRunnable, checked, notes });
  }
  return out;
}
export type { TestMeta };
