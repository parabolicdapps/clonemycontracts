import { createRequire } from 'node:module';
import { assertSupportedSource, normalizeAst } from './legacy.js';
import { ensureSolcBinary, CmcError, type StdJsonInput, type VerifiedContract } from '@cmc/core';

const require = createRequire(import.meta.url);
export const DEFAULT_SOLC = '0.8.28+commit.7893614a';

export interface AstCompile {
  compilerVersion: string;
  contractName: string;
  contractFile: string;
  /** file path -> AST SourceUnit */
  asts: Record<string, any>;
  /** file path -> numeric source id */
  ids: Record<string, number>;
  sources: Record<string, string>;
  abi: any[];
  creation: string;
  runtime: string;
  linkReferences: Record<string, unknown>;
  warnings: string[];
}

const wrappers = new Map<string, any>();
async function loadWrapper(longVersion: string): Promise<{ compile(input: string): string }> {
  const hit = wrappers.get(longVersion);
  if (hit) return hit;
  const file = await ensureSolcBinary(longVersion);
  const w = require('solc/wrapper')(require(file));
  wrappers.set(longVersion, w);
  return w;
}

export function stdInputForSource(file: string, content: string, evmVersion?: string): StdJsonInput {
  return { language: 'Solidity', sources: { [file]: { content } }, settings: { optimizer: { enabled: true, runs: 200 }, ...(evmVersion ? { evmVersion } : {}) } };
}

/** Pick a cached-friendly compiler for a local source from its pragma; falls back to DEFAULT_SOLC. */
export function pickCompilerForPragma(content: string): string {
  const m = /pragma\s+solidity\s+([^;]+);/.exec(content);
  if (m && /0\.8\.(?:\d+)/.test(m[1]!) && !/\^?0\.8\.(2[9]|3\d)/.test(m[1]!)) return DEFAULT_SOLC;
  return DEFAULT_SOLC;
}

export async function compileWithAst(opts: { compilerVersion: string; stdJsonInput: StdJsonInput; contract: string; /** AST + ABI only, optimizer off (no bytecode): several times faster, enough for the spec and the plan */ astOnly?: boolean }): Promise<AstCompile> {
  const input: StdJsonInput = structuredClone(opts.stdJsonInput);
  input.settings.outputSelection = { '*': { '': ['ast'], '*': opts.astOnly ? ['abi'] : ['abi', 'evm.bytecode.object', 'evm.bytecode.linkReferences', 'evm.deployedBytecode.object'] } };
  if (opts.astOnly) input.settings.optimizer = { enabled: false, runs: 200 };
  input.settings.libraries = {};
  const solc = await loadWrapper(opts.compilerVersion);
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors: any[] = out.errors ?? [];
  const fatal = errors.filter((e) => e.severity === 'error');
  if (fatal.length) throw new CmcError(`solc ${opts.compilerVersion} failed: ${fatal.map((e) => e.formattedMessage ?? e.message).join('\n').slice(0, 1500)}`, 'COMPILE');
  const [wantFile, wantName] = opts.contract.includes(':') ? [opts.contract.slice(0, opts.contract.lastIndexOf(':')), opts.contract.slice(opts.contract.lastIndexOf(':') + 1)] : [null, opts.contract];
  const found: { file: string; c: any }[] = [];
  for (const [file, cs] of Object.entries<any>(out.contracts ?? {})) for (const [name, c] of Object.entries<any>(cs)) if (name === wantName && (!wantFile || file === wantFile)) found.push({ file, c });
  if (found.length !== 1) throw new CmcError(found.length ? `contract name ${opts.contract} is ambiguous` : `contract ${opts.contract} not found in compiler output`, 'COMPILE');
  const { file, c } = found[0]!;
  const asts: Record<string, any> = {};
  const ids: Record<string, number> = {};
  const sources: Record<string, string> = {};
  for (const [f, s] of Object.entries<any>(out.sources ?? {})) {
    asts[f] = normalizeAst(s.ast, opts.compilerVersion);
    ids[f] = s.id;
    sources[f] = input.sources[f]?.content ?? '';
  }
  return {
    compilerVersion: opts.compilerVersion, contractName: wantName, contractFile: file, asts, ids, sources,
    abi: c.abi ?? [], creation: c.evm?.bytecode?.object ?? '', runtime: c.evm?.deployedBytecode?.object ?? '',
    linkReferences: c.evm?.bytecode?.linkReferences ?? {},
    warnings: errors.filter((e) => e.severity === 'warning').map((e) => e.formattedMessage ?? e.message),
  };
}

export async function compileVerified(vc: VerifiedContract, o: { astOnly?: boolean } = {}): Promise<AstCompile> {
  assertSupportedSource(vc.language, vc.compilerVersion);
  return compileWithAst({ compilerVersion: vc.compilerVersion, stdJsonInput: vc.stdJsonInput, contract: vc.fullyQualifiedName ?? vc.name, ...(o.astOnly ? { astOnly: true } : {}) });
}

/** Compile an arbitrary helper source (mock token) and return deployable bytecode. */
export async function compileHelper(name: string, content: string, compilerVersion = DEFAULT_SOLC): Promise<{ abi: any[]; bytecode: `0x${string}` }> {
  const r = await compileWithAst({ compilerVersion, stdJsonInput: stdInputForSource(`${name}.sol`, content), contract: name });
  return { abi: r.abi, bytecode: `0x${r.creation}` };
}
