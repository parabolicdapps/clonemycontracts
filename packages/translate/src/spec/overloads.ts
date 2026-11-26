/** Overloaded public functions are keyed by their full signature everywhere (spec, design, units, scenarios, coverage, report). */

/** `uint256`, `address`, `struct IAllowanceTransfer.PermitSingle[]` -> `uint256`, `address`, `PermitSingleArr` */
export function typeKey(t: string): string {
  return t.trim().replace(/ (memory|calldata|storage ref|storage pointer|storage|payable)$/g, '').replace(/^(struct|contract|enum) /, '').split('.').pop()!.replace(/\[(\d*)\]/g, (_m, n: string) => `Arr${n}`).replace(/[^A-Za-z0-9]/g, '');
}

/** unique key of a function among its overloads: `name_t1_t2` (`name_` for no parameters) */
export const overloadKey = (name: string, paramTypes: string[]): string => `${name}_${paramTypes.map(typeKey).join('_')}`;

/** key of every ABI function: the plain name when it is not overloaded, else the signature key */
export function abiFunctionKeys(abi: any[]): Map<string, any> {
  const fns = abi.filter((x) => x.type === 'function');
  const count = new Map<string, number>();
  for (const f of fns) count.set(f.name, (count.get(f.name) ?? 0) + 1);
  const out = new Map<string, any>();
  for (const f of fns) out.set(count.get(f.name)! > 1 ? overloadKey(f.name, (f.inputs ?? []).map((i: any) => i.internalType ?? i.type)) : f.name, f);
  return out;
}
