import type { AbiItem, EvmFeature, Hex, StdJsonInput } from '../types.js';
import { CmcError } from '../types.js';
import { loadSolc } from './solc.js';
import { defaultOutputSelection } from '../fetch/common.js';
import { defaultEvmVersion, scanAssembly } from '../analyse/evm.js';

export { ensureSolcBinary, cacheDir } from './solc.js';

export interface CompiledContract {
  name: string;
  file: string;
  abi: AbiItem[];
  /** creation bytecode with `__$..$__` placeholders where libraries are unlinked */
  creation: { object: string; linkReferences: LinkRefs };
  runtime: { object: string; linkReferences: LinkRefs; immutableReferences: Record<string, { start: number; length: number }[]> };
  warnings: string[];
  /** newer-EVM features used by the compiled code; only filled when compiled with `assembly: true` */
  features?: EvmFeature[];
}
export type LinkRefs = Record<string, Record<string, { start: number; length: number }[]>>;

export interface CompileOptions {
  compilerVersion: string;
  stdJsonInput: StdJsonInput;
  /** `file:Name` or bare `Name` */
  contract: string;
  /** override evmVersion; `null` removes it (compiler default) */
  evmVersion?: string | null;
  /** keep the libraries from the input (default: strip so the output has placeholders to link ourselves) */
  keepLibraries?: boolean;
  /** also request solc's legacy assembly to detect PUSH0/MCOPY/TSTORE/... use (large output; only when needed) */
  assembly?: boolean;
}

export async function compileContract(o: CompileOptions): Promise<CompiledContract> {
  if (o.stdJsonInput.language !== 'Solidity') throw new CmcError(`Language ${o.stdJsonInput.language} is not supported in v1`, 'UNSUPPORTED');
  const input: StdJsonInput = structuredClone(o.stdJsonInput);
  input.settings.outputSelection = defaultOutputSelection();
  if (o.assembly) (input.settings.outputSelection as any)['*']['*'].push('evm.legacyAssembly');
  if (!o.keepLibraries) input.settings.libraries = {};
  if (o.evmVersion !== undefined) {
    if (o.evmVersion === null) delete input.settings.evmVersion;
    else input.settings.evmVersion = o.evmVersion;
  }
  const solc = await loadSolc(o.compilerVersion);
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors: any[] = out.errors ?? [];
  const fatal = errors.filter((e) => e.severity === 'error');
  if (fatal.length) {
    throw new CmcError(`solc ${o.compilerVersion} failed: ${fatal.map((e) => e.formattedMessage ?? e.message).join('\n').slice(0, 1500)}`, 'COMPILE');
  }
  const [wantFile, wantName] = o.contract.includes(':') ? [o.contract.slice(0, o.contract.lastIndexOf(':')), o.contract.slice(o.contract.lastIndexOf(':') + 1)] : [null, o.contract];
  const candidates: { file: string; name: string; c: any }[] = [];
  for (const [file, cs] of Object.entries<any>(out.contracts ?? {})) {
    for (const [name, c] of Object.entries<any>(cs)) {
      if (name === wantName && (!wantFile || file === wantFile)) candidates.push({ file, name, c });
    }
  }
  if (candidates.length === 0) throw new CmcError(`Contract ${o.contract} not found in compiler output`, 'COMPILE');
  if (candidates.length > 1) throw new CmcError(`Contract name ${o.contract} is ambiguous (${candidates.map((c) => c.file).join(', ')})`, 'COMPILE');
  const { file, name, c } = candidates[0]!;
  return {
    name,
    file,
    abi: c.abi ?? [],
    creation: { object: c.evm?.bytecode?.object ?? '', linkReferences: c.evm?.bytecode?.linkReferences ?? {} },
    runtime: {
      object: c.evm?.deployedBytecode?.object ?? '',
      linkReferences: c.evm?.deployedBytecode?.linkReferences ?? {},
      immutableReferences: c.evm?.deployedBytecode?.immutableReferences ?? {},
    },
    warnings: errors.filter((e) => e.severity === 'warning').map((e) => e.formattedMessage ?? e.message),
    ...(o.assembly ? { features: [...scanAssembly(c.evm?.legacyAssembly, (input.settings.evmVersion as string | undefined) ?? defaultEvmVersion(o.compilerVersion))] } : {}),
  };
}

/** Replace library placeholders with addresses. `addresses` is keyed `file:Name`, `Name`, or (for original settings) file -> name. */
export function linkBytecode(object: string, refs: LinkRefs, addressFor: (file: string, name: string) => string | undefined): { linked: string; missing: string[] } {
  const chars = object.split('');
  const missing: string[] = [];
  for (const [file, libs] of Object.entries(refs)) {
    for (const [name, positions] of Object.entries(libs)) {
      const addr = addressFor(file, name);
      if (!addr) {
        missing.push(`${file}:${name}`);
        continue;
      }
      const hex = addr.replace(/^0x/, '').toLowerCase();
      for (const p of positions) {
        for (let i = 0; i < 40; i++) chars[p.start * 2 + i] = hex[i]!;
      }
    }
  }
  return { linked: chars.join(''), missing };
}

export function librariesLookup(libs: Record<string, Record<string, string>>): (file: string, name: string) => string | undefined {
  return (file, name) => libs[file]?.[name] ?? libs['']?.[name] ?? Object.values(libs).map((m) => m[name]).find(Boolean);
}

export interface BytecodeComparison {
  result: 'exact' | 'match' | 'mismatch';
  detail: string;
}

function stripMetadata(hex: string): string {
  // hex without 0x. The last 2 bytes encode the CBOR length.
  if (hex.length < 4) return hex;
  const len = parseInt(hex.slice(-4), 16);
  if (len * 2 + 4 > hex.length || len > 200) return hex;
  return hex.slice(0, hex.length - len * 2 - 4);
}

/** Compare on-chain runtime code with the recompiled (linked) runtime code. */
export function compareRuntime(onchain: Hex | string, recompiled: string, immutableRefs: Record<string, { start: number; length: number }[]>): BytecodeComparison {
  const a = onchain.replace(/^0x/, '').toLowerCase();
  const b = recompiled.replace(/^0x/, '').toLowerCase();
  if (a === b) return { result: 'exact', detail: 'byte-for-byte identical' };
  if (a.length !== b.length) {
    const sa = stripMetadata(a), sb = stripMetadata(b);
    if (sa.length !== sb.length) return { result: 'mismatch', detail: `length differs: on-chain ${a.length / 2} bytes vs recompiled ${b.length / 2} bytes` };
  }
  const mask = (s: string) => {
    const chars = s.split('');
    for (const refs of Object.values(immutableRefs)) {
      for (const r of refs) for (let i = 0; i < r.length * 2; i++) if (r.start * 2 + i < chars.length) chars[r.start * 2 + i] = '0';
    }
    return chars.join('');
  };
  const ma = stripMetadata(mask(a));
  const mb = stripMetadata(mask(b));
  if (ma === mb) {
    const n = Object.values(immutableRefs).reduce((s, r) => s + r.length, 0);
    return { result: 'match', detail: `identical apart from CBOR metadata${n ? ` and ${n} immutable slot(s)` : ''}` };
  }
  let i = 0;
  while (i < ma.length && ma[i] === mb[i]) i++;
  return { result: 'mismatch', detail: `first difference at byte ${Math.floor(i / 2)}` };
}

import type { VerifiedContract } from '../types.js';
import { fixLibrarySelfRuntime } from './self.js';

/** Recompile a verified contract exactly as published and compare with the code on its chain. */
export async function recompileCheck(vc: VerifiedContract, getCode: (a: `0x${string}`) => Promise<string | undefined>): Promise<BytecodeComparison & { compiler: string }> {
  const compiled = await compileContract({
    compilerVersion: vc.compilerVersion,
    stdJsonInput: vc.stdJsonInput,
    contract: vc.fullyQualifiedName ?? vc.name,
    keepLibraries: true,
  });
  const lookup = librariesLookup(vc.libraries);
  const { linked, missing } = linkBytecode(compiled.runtime.object, compiled.runtime.linkReferences, lookup);
  if (missing.length) return { result: 'mismatch', detail: `no address for libraries ${missing.join(', ')}`, compiler: vc.compilerVersion };
  const onchain = (await getCode(vc.address)) ?? '0x';
  if (onchain === '0x') return { result: 'mismatch', detail: 'no code at the original address', compiler: vc.compilerVersion };
  const cmp = compareRuntime(onchain, fixLibrarySelfRuntime(linked, onchain), compiled.runtime.immutableReferences);
  return { ...cmp, compiler: vc.compilerVersion };
}
