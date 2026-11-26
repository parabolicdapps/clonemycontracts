import { detectSourceLicenses } from '../analyse/license.js';
import type { AbiItem, Address, ProxyInfo, StdJsonInput } from '../types.js';

/** Normalise compiler versions: strip leading `v`. Keeps the `+commit.x` suffix. */
export function normaliseCompilerVersion(v: string): string {
  return v.replace(/^v/, '').trim();
}

export function emptyProxy(): ProxyInfo {
  return { isProxy: false, type: null, implementations: [] };
}

/** The primary licence of the sources: the main file's SPDX tag or header text, else the first file that has one. `contractLicenseIds` (analyse/license.ts) lists them all. */
export function spdxFromSources(sources: Record<string, { content: string }>, preferFile?: string | null): string | null {
  return detectSourceLicenses(sources, preferFile).ids[0] ?? null;
}

export function parseAbi(raw: unknown): AbiItem[] {
  if (Array.isArray(raw)) return raw as AbiItem[];
  if (typeof raw === 'string') {
    try {
      const p = JSON.parse(raw);
      return Array.isArray(p) ? p : [];
    } catch {
      return [];
    }
  }
  return [];
}

export function defaultOutputSelection(): StdJsonInput['settings']['outputSelection'] {
  return {
    '*': {
      '*': ['abi', 'evm.bytecode.object', 'evm.bytecode.linkReferences', 'evm.deployedBytecode.object', 'evm.deployedBytecode.linkReferences', 'evm.deployedBytecode.immutableReferences'],
    },
  };
}

export function lc(a: string): Address {
  return a.toLowerCase() as Address;
}
