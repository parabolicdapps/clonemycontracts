/** `{"$ref":"step:<id>"}` (address of a deployed step) or `{"$ref":"deployer"}` (the account that signs the deployment). */
export const isRef = (v: unknown): v is { $ref: string } => !!v && typeof v === 'object' && '$ref' in (v as object);
export const stepRef = (stepId: string) => ({ $ref: `step:${stepId}` });
export const DEPLOYER_REF = { $ref: 'deployer' } as const;

/** Replace refs by the zero address so a value can be checked against its ABI type. */
export function stripRefs(v: unknown): unknown {
  if (isRef(v)) return '0x0000000000000000000000000000000000000000';
  if (Array.isArray(v)) return v.map(stripRefs);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, stripRefs(x)]));
  return v;
}

/** In a parsed `--set` value, turn the string `deployer` into a deployer ref (also inside arrays/objects). */
export function deployerWords(v: unknown): unknown {
  if (v === 'deployer') return { ...DEPLOYER_REF };
  if (Array.isArray(v)) return v.map(deployerWords);
  if (v && typeof v === 'object' && !isRef(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deployerWords(x)]));
  return v;
}
