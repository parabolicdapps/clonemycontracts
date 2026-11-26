import type { Scenario, ScenarioSet } from '../../types.js';
import type { BuiltPlan, RunnerResult, RunnerStepResult, StepMeta } from './adapter.js';
import type { CwDesign } from './design-types.js';
import type { TypeMap } from './names.js';

export interface Mismatch { at: string; what: string; expected: unknown; actual: unknown; note?: string; documented?: string }

export interface ScenarioOutcome {
  id: string; title: string; kind: Scenario['kind']; fn?: string;
  status: 'passed' | 'failed' | 'not-runnable' | 'documented-difference';
  mismatches: Mismatch[]; notRunnable: string[]; checked: number; notes: string[];
}

const b64ToHex = (b: string) => `0x${Buffer.from(b, 'base64').toString('hex')}`;

/** Neutral names for the addresses the runner reports: actor:x, token:x, contract, zero. */
export function addressNamer(addresses: Record<string, string> | undefined): (a: string) => string {
  const rev = new Map<string, string>();
  for (const [k, v] of Object.entries(addresses ?? {})) rev.set(v, k === 'app' ? 'contract' : k.startsWith('name:') ? `token:${k.slice(5)}` : k);
  return (a) => (a === '' ? 'zero' : rev.get(a) ?? a);
}

export function normWire(x: unknown, t: TypeMap, name: (a: string) => string): unknown {
  if (x === null || x === undefined) return t.kind === 'address' ? 'zero' : x;
  switch (t.kind) {
    case 'address': return name(String(x));
    case 'uint': case 'int': case 'enum': return String(x);
    case 'bytes': return b64ToHex(String(x));
    case 'array': return Array.isArray(x) ? x.map((e) => normWire(e, t.elem!, name)) : x;
    default: return x;
  }
}

export function sameValue(orig: unknown, act: unknown): boolean {
  // the original reports uint8..48 as JS numbers, the rewrite as strings or numbers: compare integers by value
  if (typeof orig === 'number') orig = String(orig);
  if (typeof act === 'number') act = String(act);
  if (Array.isArray(orig) && Array.isArray(act)) return orig.length === act.length && orig.every((o, i) => sameValue(o, act[i]));
  const isNum = (x: unknown): x is string => typeof x === 'string' && /^-?\d+$/.test(x);
  if (isNum(orig) && isNum(act)) return BigInt(orig) === BigInt(act);
  if (typeof orig === 'bigint' || typeof act === 'bigint') return String(orig) === String(act);
  if (typeof orig === 'string' && typeof act === 'string') return orig.toLowerCase() === act.toLowerCase();
  return JSON.stringify(orig) === JSON.stringify(act);
}

function readActual(meta: StepMeta, res: RunnerStepResult, design: CwDesign, name: (a: string) => string): { value: unknown } | { missing: string } {
  const r = meta.read;
  if (!r) return { missing: 'no reader' };
  if (!res.ok) return { missing: `query failed: ${res.error ?? 'error'}` };
  const d = res.data as any;
  switch (r.type) {
    case 'query': {
      const h = design.instructions.find((x) => x.unit === r.handler)!;
      const ret = h.returns!;
      if (ret.single) return { value: normWire(d, ret.t!, name) };
      return { value: ret.fields.map((f) => normWire(d?.[f.name], f.t, name)) };
    }
    case 'cw20-balance': return { value: String(d?.balance) };
    case 'cw20-allowance': return { value: String(d?.allowance) };
    case 'cw20-field': return { value: d?.[r.field] === undefined ? undefined : String(d[r.field]) };
    case 'cw20-minter': return { value: d?.minter ? name(String(d.minter)) : 'zero' };
  }
}

export function compareResults(set: ScenarioSet, built: BuiltPlan, result: RunnerResult, design: CwDesign): ScenarioOutcome[] {
  const out: ScenarioOutcome[] = [];
  const who = (st: any) => `${st.fn}(${st.args.map((a: unknown) => JSON.stringify(a)).join(', ')}) by ${st.actor}`;
  for (const sc of set.scenarios) {
    const base = { id: sc.id, title: sc.title, kind: sc.kind, ...(sc.fn ? { fn: sc.fn } : {}) };
    const nrAll = built.notRunnable.get(sc.id);
    if (nrAll) { out.push({ ...base, status: 'not-runnable', mismatches: [], notRunnable: [nrAll], checked: 0, notes: [] }); continue; }
    const rs = result.scenarios.find((x) => x.id === sc.id);
    const meta = built.meta.get(sc.id) ?? [];
    if (!rs || rs.fatal) { out.push({ ...base, status: 'not-runnable', mismatches: [], notRunnable: [rs?.fatal ?? 'the runner returned no result for this scenario'], checked: 0, notes: [] }); continue; }
    const name = addressNamer(rs.addresses);
    const mismatches: Mismatch[] = [];
    const nr: string[] = [];
    const notes: string[] = [];
    let checked = 0, blocked = false;
    for (const [idx, m] of meta.entries()) {
      const res = rs.steps[idx];
      if (!res) { nr.push(`no result for runner step ${idx}`); blocked = true; break; }
      if (m.kind === 'setup') { if (res.runner_error || res.ok === false) { if (!(rs.steps.find((s, i) => meta[i]?.kind === 'deploy' && s.ok === false))) { nr.push(`fixture step failed: ${res.runner_error ?? res.error}`); blocked = true; } break; } continue; }
      if (m.kind === 'time') continue;
      if (m.kind === 'deploy') {
        const exp = sc.deploy.expect?.status;
        if (res.runner_error) { nr.push(`deploy: ${res.runner_error}`); blocked = true; break; }
        const act = res.ok ? 'success' : 'revert';
        if (exp && exp !== act) {
          const doc = exp === 'success' && act === 'revert' && m.documentedZero ? m.documentedZero : m.documented;
          mismatches.push({ at: 'deploy', what: 'deployment', expected: `${exp}${sc.deploy.expect?.reason ? ` (${sc.deploy.expect.reason})` : ''}`, actual: act === 'revert' ? `revert (${res.error})` : 'success', ...(doc ? { documented: doc } : {}) });
          break;
        }
        checked++;
        if (exp === 'revert') break;
        continue;
      }
      const step = m.scenarioStep !== undefined ? sc.steps[m.scenarioStep] : undefined;
      if (!step) continue;
      if (m.skip) continue;
      if (m.notRunnable) { nr.push(`${step.type === 'call' ? step.fn : (step as any).label}: ${m.notRunnable}`); if (m.kind === 'call') { blocked = true; break; } continue; }
      if (res.runner_error) { nr.push(`${step.type === 'call' ? step.fn : (step as any).label}: ${res.runner_error}`); if (m.kind === 'call') { blocked = true; break; } continue; }
      if (m.kind === 'call' && step.type === 'call') {
        const exp = step.expect?.status;
        const act = res.ok ? 'success' : 'revert';
        if (exp && exp !== act) {
          const doc = exp === 'success' && act === 'revert' && m.documentedZero ? m.documentedZero : m.documented;
          mismatches.push({ at: String(m.scenarioStep), what: who(step), expected: `${exp}${step.expect?.reason ? ` (${step.expect.reason})` : ''}`, actual: act === 'revert' ? `revert (${res.error})` : 'success', ...(doc ? { documented: doc } : {}) });
          break;
        }
        if (m.documented && exp === act) notes.push(`${step.fn}: ${m.documented}`);
        checked++;
        continue;
      }
      if (m.kind === 'view' && step.type === 'view') {
        const exp = step.expect as any;
        if (exp && typeof exp === 'object' && '__revert' in exp) { nr.push(`${step.label}: the original view reverts`); continue; }
        const act = readActual(m, res, design, name);
        if ('missing' in act) { nr.push(`${step.label}: ${act.missing}`); continue; }
        if (!sameValue(exp, act.value)) { mismatches.push({ at: String(m.scenarioStep), what: step.label, expected: exp, actual: act.value, ...(m.documented ? { documented: m.documented } : {}) }); continue; }
        checked++;
      }
    }
    const hard = mismatches.filter((x) => !x.documented);
    const status: ScenarioOutcome['status'] = hard.length ? 'failed' : mismatches.length ? 'documented-difference' : blocked || checked === 0 ? 'not-runnable' : 'passed';
    out.push({ ...base, status, mismatches, notRunnable: nr, checked, notes });
  }
  return out;
}
