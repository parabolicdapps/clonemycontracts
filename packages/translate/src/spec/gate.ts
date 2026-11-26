import type { ContractSpec } from '../types.js';
import { abiFunctionKeys } from './overloads.js';

export interface GateResult { ok: boolean; problems: string[] }

const sigOf = (name: string, n: number) => `${name}/${n}`;

/**
 * Hard sanity gate between the compiler's ABI (the ground truth about what the contract exposes) and the extracted spec.
 * The extractor reads the AST; the ABI comes from the same compiler run (and equals the verified ABI of the source);
 * if the two disagree the extraction is wrong (e.g. an AST dialect the extractor does not understand) and nothing
 * downstream may be reported as a success. Every ABI function/event must be in the spec and vice versa.
 */
export function checkSpecAgainstAbi(spec: ContractSpec, abi: any[], verifiedAbi?: any[]): GateResult {
  const problems: string[] = [];
  const abis: [string, any[]][] = [['compiler ABI', abi], ...(verifiedAbi && verifiedAbi.length ? [['verified ABI from the explorer', verifiedAbi] as [string, any[]]] : [])];
  const pub = spec.functions.filter((f) => f.kind === 'function' && (f.visibility === 'public' || f.visibility === 'external'));
  const specFns = new Map<string, number>();
  for (const f of pub) specFns.set(sigOf(f.solidityName ?? f.name, f.params.length), (specFns.get(sigOf(f.solidityName ?? f.name, f.params.length)) ?? 0) + 1);
  // public state variables generate getters: name with 0..n key parameters
  const getterNames = new Set(spec.stateVars.filter((v) => v.visibility === 'public').map((v) => v.name));
  const unnamed = spec.functions.filter((f) => !f.name).length;
  if (unnamed) problems.push(`${unnamed} function(s) in the spec have no name (AST dialect not understood)`);

  for (const [label, a] of abis) {
    const fns = a.filter((x: any) => x.type === 'function');
    const evs = a.filter((x: any) => x.type === 'event');
    if (fns.length > 0 && pub.length === 0 && getterNames.size === 0) problems.push(`the ${label} has ${fns.length} functions but the spec has none`);
    const keys = abiFunctionKeys(a);
    const specNames = new Set(pub.map((f) => f.name));
    const initName = spec.proxy?.initializer ?? spec.foldedInitializer;
    for (const [k, f] of keys) if (!specNames.has(k) && !getterNames.has(k) && !(initName && f.name === initName)) problems.push(`${label} function ${f.name}(${(f.inputs ?? []).map((i: any) => i.type).join(',')}) is missing in the spec`);
    for (const f of pub) if (!keys.has(f.name)) problems.push(`spec function ${f.name} is not in the ${label}`);
    const specEv = new Set(spec.events.map((e) => e.name));
    const abiEv = new Set(evs.map((e: any) => e.name));
    for (const e of abiEv) if (!specEv.has(e)) problems.push(`${label} event ${e} is missing in the spec`);
    for (const e of specEv) if (!abiEv.has(e as string)) problems.push(`spec event ${e} is not in the ${label}`);
    const ctor = a.find((x: any) => x.type === 'constructor');
    const ctorN = ctor ? (ctor.inputs ?? []).length : 0;
    if (spec.proxy || spec.foldedInitializer) { /* the constructor of the implementation is not the deployment behind a proxy */ } else if (ctorN > 0 && !spec.constructor) problems.push(`the ${label} has a constructor with ${ctorN} parameter(s) but the spec has none`);
    if (!spec.proxy && !spec.foldedInitializer && spec.constructor && spec.constructor.params.length !== ctorN) problems.push(`constructor parameters differ: ${label} ${ctorN}, spec ${spec.constructor.params.length}`);
    const abiRecv = a.some((x: any) => x.type === 'receive');
    if (abiRecv !== spec.hasReceive) problems.push(`receive(): ${label} ${abiRecv}, spec ${spec.hasReceive}`);
    const abiFb = a.some((x: any) => x.type === 'fallback');
    if (abiFb !== spec.hasFallback) problems.push(`fallback(): ${label} ${abiFb}, spec ${spec.hasFallback}`);
  }
  return { ok: problems.length === 0, problems: [...new Set(problems)] };
}
