import type { AbiParam, ClonePlan, PlanArg, PlanStep, StdJsonInput } from './types.js';
import { defaultEvmVersion } from './analyse/evm.js';
import { isRef } from './util/refs.js';

/**
 * Foundry scaffolding for a clone project. Every deployed contract becomes its own Foundry project under `contracts/<key>/`
 * (a plan can mix compiler versions, and Foundry compiles one exact `solc` per project), with:
 *  - `foundry.toml`: the exact compiler version, optimizer, EVM version, metadata settings and remappings of the verified build,
 *  - `src/`: the sources in a plain tree (machine-specific absolute prefixes removed, import resolution kept working through remappings),
 * and at the project root `deploy.sh`, the step-by-step `forge create` / `cast send` sequence of the plan.
 */

export interface ContractProject {
  /** path inside `contracts/<key>/` -> content */
  files: Record<string, string>;
  /** original source key (as in the standard JSON) -> path under the project root */
  paths: Record<string, string>;
  /** `src/<tree>/File.sol:Name` for `forge create` */
  target: string;
  remappings: string[];
}

const strip = (s: string) => s.replace(/^[a-zA-Z][\w+.-]*:\/+/, '');

/** Folder of a plan step's contract project under `contracts/`. */
export const projectDirName = (key: string) => key.replace(/[^\w.-]/g, '_');

/** Longest common directory prefix (ending in `/`) of the absolute keys. */
function commonDir(keys: string[]): string {
  if (!keys.length) return '';
  const parts = keys.map((k) => k.split('/').slice(0, -1));
  const first = parts[0]!;
  let n = first.length;
  for (const p of parts) { let i = 0; while (i < n && i < p.length && p[i] === first[i]) i++; n = i; }
  return n ? `${first.slice(0, n).join('/')}/` : '';
}

/** Map every source key to a plain relative path. Keys that are absolute lose their machine-specific prefix together, so relative imports between them keep working. */
export function mapSourcePaths(keys: string[]): { paths: Record<string, string>; map: (p: string) => string } {
  const norm = keys.map(strip);
  const abs = norm.filter((k) => k.startsWith('/'));
  // a Nix store path: /nix/store/<hash>-<name>/...; the hash is machine-specific
  const nixLess = (k: string) => k.replace(/^\/nix\/store\/[a-z0-9]{32}-/, '/');
  const absNix = abs.map(nixLess);
  const common = absNix.length > 1 ? commonDir(absNix) : absNix.length === 1 ? commonDir([absNix[0]!]) : '';
  const map = (p: string): string => {
    let q = strip(p);
    if (q.startsWith('/')) {
      q = nixLess(q);
      if (common && q.startsWith(common)) q = q.slice(common.length);
      else if (common === '' || !q.startsWith(common)) q = q.replace(/^\/+/, '');
    }
    const out: string[] = [];
    for (const seg of q.split('/')) { if (!seg || seg === '.') continue; if (seg === '..') continue; out.push(seg.replace(/[^\w.@+~-]/g, '_')); }
    return out.join('/');
  };
  const paths: Record<string, string> = {};
  const used = new Set<string>();
  for (const k of keys) {
    let m = map(k) || 'Source.sol';
    for (let n = 2; used.has(m); n++) m = m.replace(/(\.[^./]*)?$/, `_${n}$1`);
    used.add(m);
    paths[k] = m;
  }
  return { paths, map };
}

const IMPORT_RE = /^\s*import\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/gm;

function remappingsFor(std: StdJsonInput, paths: Record<string, string>, map: (p: string) => string): string[] {
  const out = new Map<string, string>();
  const keys = Object.keys(std.sources);
  const set = (from: string, to: string) => { if (!out.has(from)) out.set(from, to); };
  // the verified build's own remappings, solc syntax `[context:]prefix=target`, moved to the new tree.
  // An empty context (":@openzeppelin/=lib/x/") is the same as none; a real context is kept in Foundry's `context:prefix=target` form.
  for (const r of ((std.settings as { remappings?: string[] }).remappings ?? [])) {
    const eq = r.indexOf('=');
    if (eq < 1) continue;
    const lhs = r.slice(0, eq), to = r.slice(eq + 1);
    const colon = lhs.indexOf(':');
    const ctx = colon >= 0 ? lhs.slice(0, colon) : '';
    const from = colon >= 0 ? lhs.slice(colon + 1) : lhs;
    if (!from || !keys.some((k) => k.startsWith(to))) continue;
    const m = map(to);
    const target = `src/${m}${to.endsWith('/') && m && !m.endsWith('/') ? '/' : ''}`;
    const cm = ctx ? map(ctx) : '';
    set(ctx && cm ? `src/${cm}${ctx.endsWith('/') && !cm.endsWith('/') ? '/' : ''}:${from}` : from, target);
  }
  // direct imports by source-unit name ("@openzeppelin/contracts/x.sol", "contracts/y.sol"): resolve from src/
  for (const [k, f] of Object.entries(std.sources)) {
    for (const m of f.content.matchAll(IMPORT_RE)) {
      const imp = m[1]!;
      if (imp.startsWith('.')) continue;
      const key = keys.includes(imp) ? imp : keys.find((x) => x.endsWith(`/${imp}`));
      if (!key) continue;
      const first = imp.startsWith('@') ? imp.split('/').slice(0, 2).join('/') + '/' : imp.split('/')[0]! + '/';
      if (!imp.startsWith(first)) continue;
      const target = paths[key]!;
      const tail = imp.slice(first.length);
      if (!target.endsWith(tail)) continue;
      set(first, `src/${target.slice(0, target.length - tail.length)}`);
    }
    void k;
  }
  return [...out].map(([f, t]) => `${f}=${t}`);
}

const q = (s: string) => JSON.stringify(s);

/** The exact settings of the verified build, as a foundry.toml. */
export function foundryToml(c: { name: string; compilerVersion: string; evmVersion: string | null; stdJsonInput: StdJsonInput }, remappings: string[], note: string): string {
  const s = c.stdJsonInput.settings as Record<string, any>;
  const ver = c.compilerVersion.split('+')[0]!;
  const L: string[] = [`# ${note}`, '[profile.default]', 'src = "src"', 'out = "out"', 'cache_path = "cache"', 'libs = []', 'auto_detect_solc = false', `solc = ${q(ver)}`];
  L.push(`optimizer = ${!!s.optimizer?.enabled}`, `optimizer_runs = ${Number(s.optimizer?.runs ?? 200)}`);
  L.push(`evm_version = ${q(c.evmVersion ?? s.evmVersion ?? defaultEvmVersion(c.compilerVersion))}`);
  if (s.viaIR) L.push('via_ir = true');
  const md = s.metadata ?? {};
  L.push(`bytecode_hash = ${q(md.bytecodeHash ?? 'ipfs')}`);
  if (md.appendCBOR === false) L.push('cbor_metadata = false');
  if (md.useLiteralContent) L.push('use_literal_content = true');
  L.push(`remappings = [${remappings.map(q).join(', ')}]`);
  const d = s.optimizer?.details;
  if (d && typeof d === 'object') {
    const snake = (k: string) => k.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
    L.push('', '[profile.default.optimizer_details]');
    for (const [k, v] of Object.entries(d)) {
      if (k === 'yulDetails' && v && typeof v === 'object') continue;
      if (typeof v === 'boolean') L.push(`${snake(k)} = ${v}`);
    }
    const y = (d as any).yulDetails;
    if (y && typeof y === 'object') {
      L.push('', '[profile.default.optimizer_details.yul_details]');
      for (const [k, v] of Object.entries(y)) L.push(`${snake(k)} = ${typeof v === 'string' ? q(v) : v}`);
    }
  }
  return `${L.join('\n')}\n`;
}

/** The file that defines `contract|library|interface Name`. */
export function findDefinition(sources: Record<string, { content: string }>, name: string): string | null {
  const re = new RegExp(`^\\s*(?:abstract\\s+)?(?:contract|library|interface)\\s+${name}\\b`, 'm');
  for (const [k, f] of Object.entries(sources)) if (re.test(f.content)) return k;
  return null;
}

export function contractProject(c: { name: string; fullyQualifiedName: string | null; compilerVersion: string; evmVersion: string | null; stdJsonInput: StdJsonInput }, note: string): ContractProject {
  const { paths, map } = mapSourcePaths(Object.keys(c.stdJsonInput.sources));
  const files: Record<string, string> = {};
  for (const [k, f] of Object.entries(c.stdJsonInput.sources)) files[`src/${paths[k]}`] = f.content;
  const remappings = remappingsFor(c.stdJsonInput, paths, map);
  files['foundry.toml'] = foundryToml(c, remappings, note);
  const mainKey = c.fullyQualifiedName ? c.fullyQualifiedName.slice(0, c.fullyQualifiedName.lastIndexOf(':')) : findDefinition(c.stdJsonInput.sources, c.name);
  const mainPath = mainKey && paths[mainKey] ? paths[mainKey]! : Object.values(paths)[0] ?? '';
  return { files, paths, target: `src/${mainPath}:${c.name}`, remappings };
}

// ---- deploy.sh --------------------------------------------------------------------------------

const varName = (id: string) => `ADDR_${id.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '')}`;
const argVar = (stepId: string, name: string) => `ARG_${stepId.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_${name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;

/** Inside double quotes: escape what the shell would interpret. */
const esc = (s: string) => s.replace(/[\\"$`]/g, (m) => `\\${m}`);

/** A value in the text syntax of `forge create --constructor-args` / `cast send`, as the inside of a double-quoted shell word. */
function lit(p: AbiParam, v: unknown): string {
  if (isRef(v)) return v.$ref === 'deployer' ? '${DEPLOYER}' : `\${${varName(v.$ref.replace(/^step:/, ''))}}`;
  if (p.type.endsWith(']')) {
    const inner = { ...p, type: p.type.replace(/\[\d*\]$/, '') } as AbiParam;
    return `[${(Array.isArray(v) ? v : []).map((x) => lit(inner, x)).join(',')}]`;
  }
  if (p.type === 'tuple') {
    const comps = p.components ?? [];
    const arr = Array.isArray(v) ? v : comps.map((cp) => (v as Record<string, unknown>)[cp.name ?? '']);
    return `(${comps.map((cp, i) => lit(cp, arr[i])).join(',')})`;
  }
  if (p.type === 'string') return `${esc(String(v))}`;
  return esc(String(v));
}

/** One argument as a shell word. Arguments that still need input become environment variables (with the suggestion as the default). */
function argWord(step: PlanStep, a: PlanArg): { word: string; needs?: string } {
  if (a.call) {
    const inner = a.call.args.map((x) => argWord(step, x));
    const sig = a.call.signature;
    return { word: `"$(cast calldata ${q(sig)} ${inner.map((x) => x.word).join(' ')})"`, needs: inner.map((x) => x.needs).filter(Boolean).join(' ') || undefined };
  }
  if (a.action === 'needs-input') {
    const name = argVar(step.id, a.name);
    const sug = a.suggestion;
    const def = isRef(sug) && sug.$ref === 'deployer' ? '${DEPLOYER}' : typeof sug === 'string' ? esc(sug) : null;
    return { word: def !== null ? `"\${${name}:-${def}}"` : `"\${${name}:?set ${name} to the ${esc(a.type)} value for ${esc(a.name)}}"`, needs: name };
  }
  return { word: `"${lit(a.abiParam, a.value)}"` };
}

export interface ScaffoldInput {
  plan: ClonePlan;
  projects: Record<string, ContractProject>;
  toName: string;
  /** the library file for a link whose key has no file (Etherscan-style) */
  libraryFile?: (contractKey: string, name: string) => string | null;
}

/** The plan as a shell sequence: `forge create` for deployments, `cast send` for initialiser and admin calls. */
export function deployScript(i: ScaffoldInput): string {
  const { plan } = i;
  const L: string[] = [
    '#!/usr/bin/env bash',
    `# Deployment sequence generated from plan.json: ${plan.steps.length} step(s) on ${i.toName} (chain id ${plan.to.chainId}).`,
    '# Review plan.json and report.md first. Nothing here copies state from the original contract.',
    '#   RPC_URL      an RPC endpoint of the target chain',
    '#   PRIVATE_KEY  the deploying account (keep it out of shell history and version control)',
    '# Arguments the plan could not fill in are read from the ARG_* environment variables named below.',
    'set -euo pipefail',
    `: "\${RPC_URL:?set RPC_URL to a ${esc(i.toName)} endpoint (chain id ${plan.to.chainId})}"`,
    ': "${PRIVATE_KEY:?set PRIVATE_KEY to the key of the deploying account}"',
    'DEPLOYER=$(cast wallet address --private-key "$PRIVATE_KEY")',
    'echo "deploying from $DEPLOYER on chain $(cast chain-id --rpc-url "$RPC_URL")"',
    'addr() { tr -d " \\r\\n" | grep -o "\\"$1\\":\\"0x[0-9a-fA-F]\\{40\\}\\"" | head -1 | cut -d\'"\' -f4; }',
    '',
  ];
  for (const s of plan.steps) {
    L.push(`# ${s.id}: ${s.label}`);
    const words = s.args.map((a) => argWord(s, a));
    const needs = [...new Set(words.flatMap((w) => (w.needs ?? '').split(' ').filter(Boolean)))];
    if (needs.length) L.push(`# needs input (set before running): ${needs.join(', ')}`);
    if (s.kind === 'initialise' || s.kind === 'admin') {
      const target = s.call!.target;
      const send = `cast send "\${${varName(target)}}" ${q(s.call!.signature)} ${words.map((w) => w.word).join(' ')} --rpc-url "$RPC_URL" --private-key "$PRIVATE_KEY"`.replace(/ +/g, ' ');
      L.push(s.call!.optional ? `# optional (not seen on the source chain): ${send}` : send, '');
      continue;
    }
    const v = varName(s.id);
    if (s.kind === 'minimal-proxy') {
      const impl = varName(s.dependsOn[0] ?? 'implementation');
      L.push(`${v}=$(cast send --json --create "0x3d602d80600a3d3981f3363d3d373d3d3d363d73\${${impl}#0x}5af43d82803e903d91602b57fd5bf3" --rpc-url "$RPC_URL" --private-key "$PRIVATE_KEY" | addr contractAddress)`, `echo "${s.id}: $${v}"`, '');
      continue;
    }
    const proj = i.projects[s.contractKey];
    if (!proj) { L.push(`# (no source for ${s.id})`, ''); continue; }
    const libs = Object.entries(s.links).map(([k, target]) => {
      const name = k.slice(k.lastIndexOf(':') + 1);
      const key = k.includes(':') ? k.slice(0, k.lastIndexOf(':')) : '';
      const file = key ? (proj.paths[key] ? `src/${proj.paths[key]}` : key) : i.libraryFile?.(s.contractKey, name) ?? '';
      const addr = target.startsWith('step:') ? `\${${varName(target.slice(5))}}` : target;
      return `--libraries "${file}:${name}:${addr}"`;
    });
    L.push(
      `${v}=$(forge create --root ${q(`contracts/${projectDirName(s.contractKey)}`)} --rpc-url "$RPC_URL" --private-key "$PRIVATE_KEY" --broadcast --json ${libs.join(' ')} ${q(proj.target)}${words.length ? ` --constructor-args ${words.map((w) => w.word).join(' ')}` : ''} | addr deployedTo)`.replace(/ +/g, ' '),
      `echo "${s.id}: $${v}"`, '',
    );
  }
  return `${L.join('\n')}\n`;
}

export function projectReadme(i: { plan: ClonePlan; name: string; fromChain: string; toName: string; keys: string[]; projects: Record<string, ContractProject> }): string {
  const { plan } = i;
  const L: string[] = [
    `# ${i.name}: clone project`, '',
    `Clone of \`${plan.from.address}\` (${i.fromChain}) for ${i.toName} (chain id ${plan.to.chainId}), generated by CloneMyContracts.`, '',
    '> State is not copied: the clone is a fresh contract. Unaudited: read the sources, `plan.json` and `report.md` before deploying anything that holds funds.', '',
    '## Contents', '',
    '- `report.md`, `plan.json`, `analysis.json`: what the tool found and what it will do, step by step',
    '- `contracts/<step>/`: one Foundry project per deployed contract, because a plan can mix compiler versions',
    '  - `foundry.toml`: the exact compiler version, optimizer, EVM version, metadata and remappings of the verified build',
    '  - `src/`: the verified sources in a plain tree (machine-specific absolute prefixes removed; imports keep resolving through the remappings)',
    '  - `standard-input.json`: the original solc input, with the original source paths',
    '  - `abi.json`',
    '- `deploy.sh`: the plan as a `forge create` / `cast send` sequence', '',
    '## Build', '',
    'Foundry downloads the pinned compiler on first use.', '', '```sh',
    ...i.keys.flatMap((k) => [`(cd contracts/${projectDirName(k)} && forge build)   # ${i.projects[k]!.target}`]), '```', '',
    'The runtime bytecode equals the verified build apart from the CBOR metadata suffix (it embeds source paths, which were normalised).', '',
    '## Deploy', '',
    'Read `deploy.sh` first: it lists the steps in order and every `ARG_*` value you still have to provide.', '', '```sh',
    'export RPC_URL=<an RPC endpoint of the target chain>', 'export PRIVATE_KEY=<the deploying account>', 'bash deploy.sh', '```', '',
    '## Steps', '', ...plan.steps.map((s) => `- \`${s.id}\`: ${s.label}`), '',
  ];
  if (plan.needsInput.length) L.push('## Needs your input', '', ...plan.needsInput.map((n) => `- \`${n}\``), '');
  if (plan.warnings.length) L.push('## Warnings', '', ...plan.warnings.map((w) => `- ${w}`), '');
  return `${L.join('\n')}\n`;
}
