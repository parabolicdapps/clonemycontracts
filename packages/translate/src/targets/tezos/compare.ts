import type { Scenario, ScenarioSet } from '../../types.js';
import type { BuiltPlan, ReadSpec, RunnerResult, RunnerStepResult, StepMeta } from './adapter.js';
import type { TypeMap } from './names.js';

export interface Mismatch { at: string; what: string; expected: unknown; actual: unknown; note?: string; documented?: string }

export interface ScenarioOutcome {
  id: string; title: string; kind: Scenario['kind']; fn?: string;
  status: 'passed' | 'failed' | 'not-runnable' | 'documented-difference';
  mismatches: Mismatch[]; notRunnable: string[]; checked: number; notes: string[];
}

// ------------------------------------------------------------ parsing the text SmartPy prints for a value
export type SpValue = string | boolean | null | SpValue[] | { [k: string]: SpValue };

/**
 * Parse the repr SmartPy's simulator gives a value: `12`, `True`, `'str'`, `sp.address('tz1..')`, `sp.timestamp(5)`, `sp.mutez(7)`, `sp.bytes('0xab')`,
 * `sp.record(a = 1, b = (2, 'x'))`, `[1, 2]`, `sp.Some(3)`, `None`, `{k : v}` (maps come back as an object whose keys are the printed keys).
 */
export function parseSpValue(text: string): SpValue {
  let i = 0;
  const ws = () => { while (i < text.length && /\s/.test(text[i]!)) i++; };
  const fail = (m: string): never => { throw new Error(`cannot parse SmartPy value at ${i}: ${m} in ${text.slice(0, 120)}`); };
  const str = (): string => {
    const q = text[i++]!; let out = '';
    while (i < text.length && text[i] !== q) { if (text[i] === '\\') { i++; out += text[i] === 'n' ? '\n' : text[i]; i++; } else out += text[i++]; }
    i++;
    return out;
  };
  const list = (close: string): SpValue[] => {
    const out: SpValue[] = []; ws();
    while (i < text.length && text[i] !== close) { out.push(value()); ws(); if (text[i] === ',') { i++; ws(); } }
    i++;
    return out;
  };
  function value(): SpValue {
    ws();
    const c = text[i]!;
    if (c === "'" || c === '"') return str();
    if (c === '(') { i++; const xs = list(')'); return xs.length === 1 ? xs[0]! : xs; }
    if (c === '[') { i++; return list(']'); }
    if (c === '{') {
      i++; const o: Record<string, SpValue> = {}; ws();
      while (i < text.length && text[i] !== '}') { const k = value(); ws(); if (text[i] === ':') i++; const v = value(); o[typeof k === 'string' ? k : JSON.stringify(k)] = v; ws(); if (text[i] === ',') { i++; ws(); } }
      i++;
      return o;
    }
    const m = /^-?\d+/.exec(text.slice(i));
    if (m) { i += m[0].length; return m[0]; }
    const id = /^[A-Za-z_][\w.]*/.exec(text.slice(i));
    if (!id) return fail('unexpected character');
    i += id[0].length;
    const name = id[0];
    if (name === 'True') return true;
    if (name === 'False') return false;
    if (name === 'None') return null;
    if (text[i] === '(') {
      i++; ws();
      if (name === 'sp.record') {
        const o: Record<string, SpValue> = {};
        while (i < text.length && text[i] !== ')') { const k = /^[A-Za-z_]\w*/.exec(text.slice(i))?.[0]; if (!k) fail('record field'); i += k!.length; ws(); if (text[i] === '=') i++; o[k!] = value(); ws(); if (text[i] === ',') { i++; ws(); } }
        i++;
        return o;
      }
      const xs = list(')');
      if (/^sp\.(Some|address|timestamp|mutez|tez|bytes|key|signature|chain_id|key_hash|nat|int|string|bool)$/.test(name)) return xs[0]!;
      return xs;
    }
    return name;
  }
  const v = value();
  return v;
}

const hexOf = (s: string) => (s.startsWith('0x') ? s.toLowerCase() : `0x${s.toLowerCase()}`);

/** Neutral names for addresses: actor:x, token:x, contract, zero (the runner reports `contract:app`, `contract:token_x`, `actor:x`). */
export function addressNamer(addresses: Record<string, string> | undefined, zero: string): (a: string) => string {
  const rev = new Map<string, string>();
  const bare = (s: string) => (parseSpValue(s) as string);
  for (const [k, v] of Object.entries(addresses ?? {})) { try { rev.set(bare(v), k === 'contract:app' ? 'contract' : k.startsWith('contract:token_') ? `token:${k.slice(15)}` : k); } catch { /* ignore */ } }
  return (a) => (a === zero ? 'zero' : rev.get(a) ?? a);
}

export function normValue(x: SpValue, t: TypeMap, name: (a: string) => string): unknown {
  if (x === null || x === undefined) return t.kind === 'address' ? 'zero' : x;
  switch (t.kind) {
    case 'address': return name(String(x));
    case 'uint': case 'int': case 'enum': return String(x);
    case 'bytes': return hexOf(String(x));
    case 'bool': return x === true || x === 'True' || x === 'true';
    case 'array': return Array.isArray(x) ? x.map((e) => normValue(e, t.elem!, name)) : x;
    default: return x;
  }
}

export function sameValue(orig: unknown, act: unknown): boolean {
  if (typeof orig === 'number') orig = String(orig);
  if (typeof act === 'number') act = String(act);
  if (Array.isArray(orig) && Array.isArray(act)) return orig.length === act.length && orig.every((o, i) => sameValue(o, act[i]));
  const isNum = (x: unknown): x is string => typeof x === 'string' && /^-?\d+$/.test(x);
  if (isNum(orig) && isNum(act)) return BigInt(orig) === BigInt(act);
  if (typeof orig === 'bigint' || typeof act === 'bigint') return String(orig) === String(act);
  if (typeof orig === 'string' && typeof act === 'string') return orig.toLowerCase() === act.toLowerCase();
  return JSON.stringify(orig) === JSON.stringify(act);
}

function readActual(r: ReadSpec | undefined, res: RunnerStepResult, name: (a: string) => string): { value: unknown } | { missing: string } {
  if (!r) return { missing: 'no reader' };
  if (!res.ok) return { missing: `view failed: ${res.error ?? res.runner_error ?? 'error'}` };
  let v: SpValue;
  try { v = parseSpValue(res.value ?? ''); } catch (e) { return { missing: (e as Error).message }; }
  if (r.type === 'value') return { value: normValue(v, r.t, name) };
  const o = v as { [k: string]: SpValue };
  return { value: r.fields.map((f) => normValue(o?.[f.name] ?? null, f.t, name)) };
}

/** Documented differences classified by code: the original refuses what a Solidity integer width cannot hold, a Tezos nat has no width. */
export function widthDifference(reason: string | undefined, hugeArg: boolean | undefined): string | undefined {
  if (!reason) return undefined;
  if (/^bad arguments/i.test(reason)) return 'the Solidity ABI rejects a value that does not fit the declared integer width (uint8, uint64, ...); a Tezos nat has no width, so the entrypoint accepts it (documented: widths below 256 are not range checked)';
  if (/^panic 17$/.test(reason) && hugeArg) return 'the original reverts on a uint256 arithmetic overflow (panic 17); a nat is arbitrary precision, so the rewrite does not revert unless the body wraps the result in u256() (documented difference)';
  return undefined;
}

export function compareResults(set: ScenarioSet, built: BuiltPlan, result: RunnerResult): ScenarioOutcome[] {
  const out: ScenarioOutcome[] = [];
  const who = (st: any) => `${st.fn}(${st.args.map((a: unknown) => JSON.stringify(a)).join(', ')}) by ${st.actor}`;
  for (const sc of set.scenarios) {
    const base = { id: sc.id, title: sc.title, kind: sc.kind, ...(sc.fn ? { fn: sc.fn } : {}) };
    const nrAll = built.notRunnable.get(sc.id);
    if (nrAll) { out.push({ ...base, status: 'not-runnable', mismatches: [], notRunnable: [nrAll], checked: 0, notes: [] }); continue; }
    const rs = result.scenarios.find((x) => x.id === sc.id);
    const meta = built.meta.get(sc.id) ?? [];
    if (!rs || rs.fatal) { out.push({ ...base, status: 'not-runnable', mismatches: [], notRunnable: [rs?.fatal ?? 'the runner returned no result for this scenario'], checked: 0, notes: [] }); continue; }
    const name = addressNamer(rs.addresses, built.plan.zero);
    const mismatches: Mismatch[] = [];
    const nr: string[] = [];
    const notes: string[] = [];
    let checked = 0, blocked = false;
    const reason = (res: RunnerStepResult) => res.error ?? res.runner_error ?? 'error';
    for (const [idx, m] of meta.entries()) {
      const res = rs.steps[idx];
      if (!res) { nr.push(`no result for runner step ${idx}`); blocked = true; break; }
      if (m.kind === 'setup') { if (!res.ok) { nr.push(`fixture step failed: ${reason(res)}`); blocked = true; break; } continue; }
      if (m.kind === 'time') continue;
      if (m.kind === 'deploy') {
        const exp = sc.deploy.expect?.status;
        if (res.runner_error) { nr.push(`deploy: ${res.runner_error}`); blocked = true; break; }
        const act = res.ok ? 'success' : 'revert';
        if (exp && exp !== act) {
          mismatches.push({ at: 'deploy', what: 'deployment', expected: `${exp}${sc.deploy.expect?.reason ? ` (${sc.deploy.expect.reason})` : ''}`, actual: act === 'revert' ? `revert (${reason(res)})` : 'success', ...(m.documented ? { documented: m.documented } : {}) });
          break;
        }
        checked++;
        if (exp === 'revert') break;
        continue;
      }
      const step = m.scenarioStep !== undefined ? sc.steps[m.scenarioStep] : undefined;
      if (!step) continue;
      if (m.notRunnable) { nr.push(`${step.type === 'call' ? step.fn : (step as any).label}: ${m.notRunnable}`); if (m.kind === 'call') { blocked = true; break; } continue; }
      if (res.runner_error) { nr.push(`${step.type === 'call' ? step.fn : (step as any).label}: ${res.runner_error}`); if (m.kind === 'call') { blocked = true; break; } continue; }
      if (m.kind === 'call' && step.type === 'call') {
        const exp = step.expect?.status;
        const act = res.ok ? 'success' : 'revert';
        if (exp && exp !== act) {
          const doc = exp === 'revert' && act === 'success' ? widthDifference(step.expect?.reason, m.hugeArg) : undefined;
          mismatches.push({ at: String(m.scenarioStep), what: who(step), expected: `${exp}${step.expect?.reason ? ` (${step.expect.reason})` : ''}`, actual: act === 'revert' ? `revert (${reason(res)})` : 'success', ...(doc ?? m.documented ? { documented: (doc ?? m.documented)! } : {}) });
          break;
        }
        if (m.documented && exp === act) notes.push(`${step.fn}: ${m.documented}`);
        checked++;
        continue;
      }
      if (m.kind === 'view' && step.type === 'view') {
        const exp = step.expect as any;
        if (exp && typeof exp === 'object' && '__revert' in exp) { nr.push(`${step.label}: the original view reverts`); continue; }
        const act = readActual(m.read, res, name);
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
export type { StepMeta };
