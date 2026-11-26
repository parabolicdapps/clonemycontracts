import type { Scenario, ScenarioSet } from '../../types.js';
import type { BuiltPlan, RunnerResult, RunnerStepResult, StepMeta } from './adapter.js';
import { SYSTEM_ZERO } from './adapter.js';
import type { SolanaDesign } from './design-types.js';

export interface Mismatch {
  /** `deploy`, or the index of the scenario step */
  at: string;
  what: string;
  expected: unknown;
  actual: unknown;
  note?: string;
  documented?: string;
}

export interface ScenarioOutcome {
  id: string;
  title: string;
  kind: Scenario['kind'];
  fn?: string;
  status: 'passed' | 'failed' | 'not-runnable' | 'documented-difference';
  mismatches: Mismatch[];
  notRunnable: string[];
  /** number of checks that agreed (statuses and values) */
  checked: number;
  /** compared under an alternate scaling (token amount vs ratio ambiguity) */
  notes: string[];
}

function bytesFromB64(b64: string): Buffer { return Buffer.from(b64, 'base64'); }

export function parseReturn(rust: string, b64: string): string | boolean | null {
  const b = bytesFromB64(b64);
  if (rust === 'bool') return b[0] === 1;
  const m = /^([ui])(\d+)$/.exec(rust);
  if (!m) return null;
  const n = Number(m[2]) / 8;
  if (b.length < n) return null;
  let v = 0n;
  for (let i = n - 1; i >= 0; i--) v = (v << 8n) | BigInt(b[i]!);
  if (m[1] === 'i' && v >= 1n << BigInt(Number(m[2]) - 1)) v -= 1n << BigInt(Number(m[2]));
  return v.toString();
}

function normSol(v: unknown): unknown {
  if (v === SYSTEM_ZERO) return 'zero';
  if (Array.isArray(v)) return v.map(normSol);
  if (typeof v === 'number') return String(v);
  return v;
}

export function sameValue(orig: unknown, sol: unknown, scale: string | undefined, divisor: bigint): { ok: boolean; note?: string } {
  if (Array.isArray(orig) && Array.isArray(sol)) {
    if (orig.length !== sol.length) return { ok: false };
    let note: string | undefined;
    for (let i = 0; i < orig.length; i++) { const r = sameValue(orig[i], sol[i], scale, divisor); if (!r.ok) return { ok: false }; note = note ?? r.note; }
    return { ok: true, ...(note ? { note } : {}) };
  }
  const isNum = (x: unknown): x is string => typeof x === 'string' && /^-?\d+$/.test(x);
  if (isNum(orig) && isNum(sol)) {
    const o = BigInt(orig), s = BigInt(sol);
    const tryScale = (mult: bigint): { ok: boolean; note?: string } => {
      if (o === s * mult) return { ok: true };
      const diff = o > s * mult ? o - s * mult : s * mult - o;
      if (mult > 1n && diff < mult) return { ok: true, note: `matched after rounding to the target's base units (difference ${diff} < ${mult})` };
      return { ok: false };
    };
    if (scale === 'token') return tryScale(divisor);
    if (scale === 'plain' || scale === undefined) { const r = tryScale(1n); return r; }
    // ratio / unknown: either
    const a = tryScale(1n);
    if (a.ok) return a;
    const b = tryScale(divisor);
    return b.ok ? { ok: true, note: `${b.note ?? 'matched'} (value scaled by the token unit conversion)` } : { ok: false };
  }
  if (typeof orig === 'boolean' || typeof sol === 'boolean') return { ok: orig === sol };
  return { ok: JSON.stringify(orig) === JSON.stringify(sol) };
}

function readActual(meta: StepMeta, res: RunnerStepResult, design: SolanaDesign): { value: unknown } | { missing: string } {
  const r = meta.read;
  if (!r) return { missing: 'no reader' };
  if (r.type === 'return') {
    if (!res.ok) return { missing: `view instruction failed: ${res.error_name ?? res.error ?? 'error'}` };
    if (!res.return_data) return { missing: 'no return data' };
    const v = parseReturn(r.rust, res.return_data.base64);
    return v === null ? { missing: `cannot decode return type ${r.rust}` } : { value: v };
  }
  if (!res.exists) {
    if (r.type === 'field' && r.default !== undefined) return { value: r.default };
    if (r.type === 'token') return { value: '0' };
    if (r.type === 'allowance') return { value: '0' };
    return { missing: 'account does not exist' };
  }
  const v = res.value;
  switch (r.type) {
    case 'field': {
      let cur: any = v;
      for (const p of r.path) cur = cur?.[p as any];
      if (cur === undefined) return { missing: `field ${r.path.join('.')} not found` };
      return { value: normSol(cur) };
    }
    case 'membership': return { value: Array.isArray(v?.owners) ? v.owners.includes(r.actor) : false };
    case 'mint-token': { const x = v?.[r.field]; return { value: r.map[x] ?? x } };
    case 'token': return { value: v?.[r.field] };
    case 'allowance': {
      const delegate = v?.delegate;
      return { value: delegate && delegate === r.spender ? v.delegated_amount : '0' };
    }
    case 'const': return { value: r.value };
  }
  void design;
}

export function compareResults(set: ScenarioSet, built: BuiltPlan, result: RunnerResult, design: SolanaDesign): ScenarioOutcome[] {
  const div = BigInt(design.decimals.divisor);
  const out: ScenarioOutcome[] = [];
  for (const sc of set.scenarios) {
    const base = { id: sc.id, title: sc.title, kind: sc.kind, ...(sc.fn ? { fn: sc.fn } : {}) };
    const nrAll = built.notRunnable.get(sc.id);
    if (nrAll) { out.push({ ...base, status: 'not-runnable', mismatches: [], notRunnable: [nrAll], checked: 0, notes: [] }); continue; }
    const rs = result.scenarios.find((x) => x.id === sc.id);
    const meta = built.meta.get(sc.id) ?? [];
    if (!rs || rs.fatal) { out.push({ ...base, status: 'not-runnable', mismatches: [], notRunnable: [rs?.fatal ?? 'the runner returned no result for this scenario'], checked: 0, notes: [] }); continue; }
    const mismatches: Mismatch[] = [];
    const nr: string[] = [];
    const notes: string[] = [];
    let checked = 0;
    let stop = false;
    let blocked = false;
    for (const [idx, m] of meta.entries()) {
      const res = rs.steps[idx];
      if (!res) { nr.push(`no result for runner step ${idx}`); break; }
      if (m.kind === 'setup') { if (res.runner_error || res.ok === false) { nr.push(`fixture step failed: ${res.runner_error ?? res.error}`); blocked = true; stop = true; break; } continue; }
      if (m.kind === 'time') continue;
      if (m.kind === 'deploy') {
        const exp = sc.deploy.expect?.status;
        if (res.runner_error) { nr.push(`deploy: ${res.runner_error}`); blocked = true; stop = true; break; }
        const act = res.ok ? 'success' : 'revert';
        if (exp && exp !== act) { mismatches.push({ at: 'deploy', what: 'deployment', expected: `${exp}${sc.deploy.expect?.reason ? ` (${sc.deploy.expect.reason})` : ''}`, actual: act === 'revert' ? `revert (${res.error_name ?? res.error_message ?? res.error})` : 'success', ...(m.documented ? { documented: m.documented } : {}) }); stop = true; break; }
        checked++;
        if (exp === 'revert') { stop = true; break; }
        continue;
      }
      const step = m.scenarioStep !== undefined ? sc.steps[m.scenarioStep] : undefined;
      if (!step) continue;
      if (m.skip) continue;
      if (m.notRunnable) { nr.push(`${step.type === 'call' ? step.fn : (step as any).label}: ${m.notRunnable}`); if (m.kind === 'call') { blocked = true; stop = true; break; } continue; }
      if (res.runner_error) { nr.push(`${step.type === 'call' ? step.fn : (step as any).label}: ${res.runner_error}`); if (m.kind === 'call') { blocked = true; stop = true; break; } continue; }
      if (m.kind === 'call' && step.type === 'call') {
        const exp = step.expect?.status;
        const act = res.ok ? 'success' : 'revert';
        if (exp && exp !== act) {
          mismatches.push({ at: String(m.scenarioStep), what: `${step.fn}(${step.args.map((a) => JSON.stringify(a)).join(', ')}) by ${step.actor}`, expected: `${exp}${step.expect?.reason ? ` (${step.expect.reason})` : ''}`, actual: act === 'revert' ? `revert (${res.error_name ?? res.error_message ?? res.error})` : 'success', ...(m.documented ? { documented: m.documented } : {}) });
          stop = true; break;
        }
        checked++;
        continue;
      }
      if (m.kind === 'view' && step.type === 'view') {
        const exp = step.expect as any;
        if (exp && typeof exp === 'object' && '__revert' in exp) { nr.push(`${step.label}: the original view reverts`); continue; }
        const act = readActual(m, res, design);
        if ('missing' in act) { nr.push(`${step.label}: ${act.missing}`); continue; }
        const cmp = sameValue(exp, act.value, m.scale, div);
        if (!cmp.ok) { mismatches.push({ at: String(m.scenarioStep), what: step.label, expected: exp, actual: act.value, ...(m.documented ? { documented: m.documented } : {}) }); continue; }
        if (cmp.note) notes.push(`${step.label}: ${cmp.note}`);
        checked++;
      }
    }
    void stop;
    const hard = mismatches.filter((x) => !x.documented);
    const status: ScenarioOutcome['status'] = hard.length ? 'failed' : mismatches.length ? 'documented-difference' : blocked || checked === 0 ? 'not-runnable' : 'passed';
    out.push({ ...base, status, mismatches, notRunnable: nr, checked, notes });
  }
  return out;
}

export interface OutcomeCounts { passed: number; failed: number; notRunnable: number; documented: number; total: number }
export function countOutcomes(o: ScenarioOutcome[]): OutcomeCounts {
  return { passed: o.filter((x) => x.status === 'passed').length, failed: o.filter((x) => x.status === 'failed').length, notRunnable: o.filter((x) => x.status === 'not-runnable').length, documented: o.filter((x) => x.status === 'documented-difference').length, total: o.length };
}
