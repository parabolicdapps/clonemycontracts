import type { ContractSpec, InitialValue, StateVarSpec } from '../types.js';

export interface InitialPlan {
  sv: StateVarSpec;
  value: InitialValue;
  /** true when the value is the type's zero (nothing to apply: every target starts at zero) */
  zero: boolean;
}

/**
 * State variables with an inline initialiser whose value code could evaluate (literals, unit literals like `60 days`/`1 ether`,
 * constant expressions, other constants). Mappings/arrays/structs cannot carry an inline value. Non-constant variables only
 * (constants are inlined by the target pack). Applying these is done by generated code on every target, never by the model.
 */
export function initialPlans(spec: ContractSpec): InitialPlan[] {
  const out: InitialPlan[] = [];
  for (const sv of spec.stateVars) {
    if (sv.constant || !sv.initial) continue;
    if (!['uint', 'int', 'bool', 'address', 'string'].includes(sv.type.kind)) continue;
    const v = sv.initial;
    const zero = (v.kind === 'uint' || v.kind === 'int') ? BigInt(v.value) === 0n : v.kind === 'bool' ? v.value === 'false' : v.kind === 'string' ? v.value === '' : /^0x0+$/.test(v.value);
    out.push({ sv, value: v, zero });
  }
  return out;
}

/** inline initialisers that code could not evaluate: the model must set them in the constructor, and the report says so */
export function unresolvedInitials(spec: ContractSpec): StateVarSpec[] {
  return spec.stateVars.filter((sv) => !sv.constant && sv.initialUnresolved && !['mapping', 'array', 'struct'].includes(sv.type.kind));
}
