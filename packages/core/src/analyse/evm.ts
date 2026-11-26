export const EVM_VERSIONS = ['homestead', 'tangerineWhistle', 'spuriousDragon', 'byzantium', 'constantinople', 'petersburg', 'istanbul', 'berlin', 'london', 'paris', 'shanghai', 'cancun', 'prague', 'osaka'] as const;

function ver(v: string): [number, number, number] {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
}
const gte = (a: [number, number, number], b: [number, number, number]) => a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] >= b[2];

/** solc's default EVM version for a compiler release (per the solc changelog). */
export function defaultEvmVersion(compilerVersion: string): string {
  const v = ver(compilerVersion);
  const table: [[number, number, number], string][] = [
    [[0, 8, 30], 'prague'], [[0, 8, 25], 'cancun'], [[0, 8, 20], 'shanghai'], [[0, 8, 18], 'paris'], [[0, 8, 7], 'london'],
    [[0, 8, 5], 'berlin'], [[0, 5, 14], 'istanbul'], [[0, 5, 5], 'petersburg'], [[0, 4, 21], 'byzantium'], [[0, 0, 0], 'homestead'],
  ];
  return table.find(([min]) => gte(v, min))![1];
}

export function evmIndex(v: string): number {
  return EVM_VERSIONS.indexOf(v as (typeof EVM_VERSIONS)[number]);
}

export const requiresPush0 = (evmVersion: string) => evmIndex(evmVersion) >= evmIndex('shanghai');

export function supportsStandardJson(compilerVersion: string): boolean {
  return gte(ver(compilerVersion), [0, 4, 11]);
}

import type { EvmFeature } from '../types.js';

/** First hardfork that has each feature. */
export const FEATURE_FORK: Record<EvmFeature, string> = {
  PUSH0: 'shanghai', MCOPY: 'cancun', TSTORE: 'cancun', TLOAD: 'cancun', BLOBHASH: 'cancun', BLOBBASEFEE: 'cancun', CLZ: 'osaka', PREVRANDAO: 'paris',
};

const OPCODE_FEATURES: Record<string, EvmFeature> = { PUSH0: 'PUSH0', MCOPY: 'MCOPY', TSTORE: 'TSTORE', TLOAD: 'TLOAD', BLOBHASH: 'BLOBHASH', BLOBBASEFEE: 'BLOBBASEFEE', CLZ: 'CLZ', PREVRANDAO: 'PREVRANDAO' };

/** Features used by compiled code, from solc's `evm.legacyAssembly` output (walks sub-assemblies; precise, no byte-scanning false positives). */
export function scanAssembly(asm: any, evmVersion?: string | null, found: Set<EvmFeature> = new Set()): Set<EvmFeature> {
  if (!asm || typeof asm !== 'object') return found;
  for (const op of asm['.code'] ?? asm.code ?? []) {
    const f = OPCODE_FEATURES[op?.name];
    if (f) found.add(f);
    // the legacy assembly writes PUSH0 as `PUSH 0`; solc emits the PUSH0 opcode for it from Shanghai on
    if (op?.name === 'PUSH' && op.value === '0' && evmVersion && evmIndex(evmVersion) >= evmIndex('shanghai')) found.add('PUSH0');
  }
  for (const sub of Object.values<any>(asm['.data'] ?? asm.data ?? {})) scanAssembly(sub, evmVersion, found);
  return found;
}

/** Features visible in source text (inline assembly calls, `block.prevrandao`, transient storage). Hints only: the compiled assembly is authoritative. */
export function scanSourceFeatures(sources: Record<string, { content: string }>): { feature: EvmFeature; file: string; line: number }[] {
  const out: { feature: EvmFeature; file: string; line: number }[] = [];
  const pats: [EvmFeature, RegExp][] = [
    ['PREVRANDAO', /\bblock\.prevrandao\b/],
    ['MCOPY', /\bmcopy\s*\(/],
    ['TSTORE', /\btstore\s*\(|\btransient\b/],
    ['TLOAD', /\btload\s*\(/],
    ['BLOBHASH', /\bblobhash\s*\(/],
    ['BLOBBASEFEE', /\bblobbasefee\s*\(|\bblock\.blobbasefee\b/],
    ['CLZ', /\bclz\s*\(/],
  ];
  for (const [file, { content }] of Object.entries(sources)) {
    const lines = content.split('\n');
    lines.forEach((l, i) => {
      const code = l.replace(/\/\/.*$/, '');
      for (const [feature, re] of pats) if (re.test(code)) out.push({ feature, file, line: i + 1 });
    });
  }
  return out;
}

/**
 * Which of `features` the target cannot run. `latestHardfork` is the registry's verified value (null = unknown);
 * `push0` is the older boolean probe, used when the hardfork is unknown.
 */
export function unsupportedOnTarget(features: Iterable<EvmFeature>, target: { latestHardfork?: string | null; push0: boolean; opcodes?: Partial<Record<EvmFeature, boolean>> }): { feature: EvmFeature; needs: string; certain: boolean }[] {
  const bad: { feature: EvmFeature; needs: string; certain: boolean }[] = [];
  for (const f of features) {
    const needs = FEATURE_FORK[f];
    const probed = target.opcodes?.[f];
    if (probed !== undefined) {
      if (!probed) bad.push({ feature: f, needs, certain: true });
    } else if (target.latestHardfork) {
      if (evmIndex(needs) > evmIndex(target.latestHardfork)) bad.push({ feature: f, needs, certain: true });
    } else if (f === 'PUSH0' && !target.push0) bad.push({ feature: f, needs, certain: true });
  }
  return bad;
}

/** The newest solc evmVersion at or below the cap, used when downgrading for a target. */
export function capEvmVersion(version: string, cap: string | null | undefined): string {
  if (!cap || evmIndex(cap) < 0 || evmIndex(version) <= evmIndex(cap)) return version;
  return cap;
}
