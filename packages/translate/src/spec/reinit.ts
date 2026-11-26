import { decodeFunctionResult, encodeFunctionData } from 'viem';
import type { ContractSpec, ScenarioSet } from '../types.js';
import type { ProxyReader } from './proxy.js';

export interface ReinitState { applied: { fn: string; variable: string; value: string }[]; notApplied: { fn: string; reason: string }[] }

const BOOKKEEPING = /^_?(initiali[sz]ed\w*|initiali[sz]ing|gap|__gap\w*|version)$/i;

/**
 * Re-initialisers (`initializeV2*`, `reinitializer(n)`) are never exposed by a rewrite, but the state they set on the source chain belongs to
 * the contract as it is deployed today. For every excluded initialiser that is not the one folded into the constructor, read the variables it
 * writes from the SOURCE chain (latest block, through the proxy) and return what can be applied as initial values and what cannot. Values that
 * code can determine are applied (uint / int / bool / string with a public getter, not written by any other function); everything else is
 * reported up front with the reason, and the verdict is capped at PARTIALLY-VERIFIED.
 */
export async function discoverReinitState(spec: ContractSpec, abi: any[], reader: ProxyReader | null, address: string | null): Promise<ReinitState> {
  const out: ReinitState = { applied: [], notApplied: [] };
  const inits = spec.functions.filter((f) => f.excluded?.category === 'initializer' && f.mutability !== 'view' && f.mutability !== 'pure' && f.name !== spec.foldedInitializer && (f.solidityName ?? f.name) !== (spec.proxy?.initializer ?? spec.foldedInitializer));
  for (const f of inits) {
    const vars = [...new Set(f.writes)].filter((v) => !BOOKKEEPING.test(v));
    const label = f.solidityName ?? f.name;
    if (!vars.length) { out.notApplied.push({ fn: label, reason: 'its effect cannot be determined (it writes no state variable that code can see, e.g. it only calls other contracts); check what it sets on the source chain and set it yourself' }); continue; }
    for (const v of vars) {
      const sv = spec.stateVars.find((s) => s.name === v);
      if (!sv) { out.notApplied.push({ fn: label, reason: `writes \`${v}\`, which is not a state variable of the rewritten contract` }); continue; }
      if (!['uint', 'int', 'bool', 'string', 'address'].includes(sv.type.kind)) { out.notApplied.push({ fn: label, reason: `writes \`${v}\` (${sv.type.kind}): the data it sets depends on its arguments and cannot be read back as one value; it is NOT in the rewrite` }); continue; }
      const getter = (abi ?? []).find((x) => x.type === 'function' && (x.stateMutability === 'view' || x.stateMutability === 'pure') && (x.inputs ?? []).length === 0 && (x.outputs ?? []).length === 1 && (x.name === v || x.name === v.replace(/^_+/, '')));
      if (!getter) { out.notApplied.push({ fn: label, reason: `writes \`${v}\`, which has no public getter to read it on the source chain; it is NOT in the rewrite` }); continue; }
      if (!reader || !address) { out.notApplied.push({ fn: label, reason: `writes \`${v}\`; the source chain was not read (rewrite of a local file)` }); continue; }
      let value: string;
      try {
        const data = encodeFunctionData({ abi: [getter], functionName: getter.name });
        const res = await reader.call(address, data);
        if (!res) throw new Error('empty answer');
        value = String(decodeFunctionResult({ abi: [getter], functionName: getter.name, data: res as `0x${string}` }));
      } catch (e) { out.notApplied.push({ fn: label, reason: `writes \`${v}\`; reading ${getter.name}() on the source chain failed (${(e as Error).message.slice(0, 80)}); it is NOT in the rewrite` }); continue; }
      const others = spec.functions.filter((g) => g !== f && g.kind === 'function' && !g.excluded && g.writes.includes(v));
      if (sv.type.kind === 'address') { out.notApplied.push({ fn: label, reason: `sets \`${v}\` = ${value} on the source chain; addresses are not applied automatically (they differ per chain): set it yourself at deployment` }); continue; }
      if (others.length) { out.notApplied.push({ fn: label, reason: `sets \`${v}\` (now ${value} on the source chain) but ${others.map((x) => x.name).slice(0, 3).join(', ')} also change it, so the value is not a constant; it is NOT in the rewrite` }); continue; }
      if ((spec.constructor?.writes ?? []).includes(v)) { out.notApplied.push({ fn: label, reason: `sets \`${v}\` = ${value} on the source chain, but the rewrite takes \`${v}\` as a deployment argument (the first initialiser's parameter); pass ${value.length > 40 ? 'that value' : `"${value}"`} at deployment` }); continue; }
      if (sv.initial && sv.initial.value === value) continue;
      sv.initial = { kind: sv.type.kind as 'uint' | 'int' | 'bool' | 'string', value, via: 'source-chain' };
      delete sv.initialUnresolved;
      out.applied.push({ fn: label, variable: v, value: value.length > 60 ? `${value.slice(0, 57)}...` : value });
    }
  }
  return out;
}

/**
 * The ground truth runs the original locally with its first initialiser only. A variable set by a later initialiser (and written by nothing else)
 * reads the source-chain value on the rewrite, so the recorded expectation of its getter is replaced by that value.
 */
export function alignGetterExpectations(set: ScenarioSet, spec: ContractSpec, state: ReinitState, abi: any[]): void {
  for (const a of state.applied) {
    const sv = spec.stateVars.find((s) => s.name === a.variable);
    if (!sv?.initial) continue;
    const getter = (abi ?? []).find((x) => x.type === 'function' && (x.inputs ?? []).length === 0 && (x.name === a.variable || x.name === a.variable.replace(/^_+/, '')));
    if (!getter) continue;
    const v: unknown = sv.type.kind === 'bool' ? sv.initial.value === 'true' : sv.initial.value;
    for (const sc of set.scenarios) for (const st of sc.steps) if (st.type === 'view' && st.fn === getter.name && st.args.length === 0) st.expect = v as never;
  }
}

/**
 * Branches behind `if (<bool state variable>)` whose flag is FALSE on the source chain are dead (USDT: `if (deprecated) return Upgraded(...).transferByLegacy(...)`).
 * The flag is read at the latest block; when it is false the external calls inside that branch are removed from the spec, so they neither
 * make the function fail closed nor count as an unreproduced dependency. A flag that is true, or cannot be read, keeps the calls.
 */
export async function dropDeadBranches(spec: ContractSpec, abi: any[], reader: ProxyReader | null, address: string | null): Promise<string[]> {
  const notes: string[] = [];
  const flags = new Set<string>();
  for (const f of spec.functions) { for (const e of f.externalCalls) if (e.underFlag) flags.add(e.underFlag); for (const t of f.guardTaint ?? []) if (t.underFlag) flags.add(t.underFlag); }
  for (const flag of flags) {
    const getter = (abi ?? []).find((x) => x.type === 'function' && x.name === flag && (x.inputs ?? []).length === 0 && (x.outputs ?? []).length === 1);
    let value: string | null = null;
    if (getter && reader && address) {
      try { const res = await reader.call(address, encodeFunctionData({ abi: [getter], functionName: flag })); if (res) value = String(decodeFunctionResult({ abi: [getter], functionName: flag, data: res as `0x${string}` })); } catch { value = null; }
    }
    if (value !== 'false') { notes.push(`branch \`if (${flag})\`: flag is ${value ?? 'unreadable'} on the source chain, so its external calls are kept (functions that depend on them fail closed)`); continue; }
    let n = 0;
    for (const f of spec.functions) { const keep = f.externalCalls.filter((e) => e.underFlag !== flag); n += f.externalCalls.length - keep.length; f.externalCalls = keep; if (f.guardTaint) { const kt = f.guardTaint.filter((t) => t.underFlag !== flag); n += f.guardTaint.length - kt.length; if (kt.length) f.guardTaint = kt; else delete f.guardTaint; } }
    notes.push(`branch \`if (${flag})\` is dead: \`${flag}\` is false on the source chain (latest block); ${n} external call(s) inside it were dropped (the rewrite deploys the live path; if the flag could ever be set the branch would matter)`);
  }
  return notes;
}
