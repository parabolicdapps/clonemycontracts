import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { CloneAnalysis, ClonePlan } from './types.js';
import { contractProject, deployScript, findDefinition, projectDirName, projectReadme, type ContractProject } from './scaffold.js';
import { getChain } from './chains/index.js';
import type { SimulationReport } from './deploy/index.js';
import type { StepResult } from './deploy/execute.js';
import type { DeploymentRecord, VerifyResult } from './verify/index.js';

/** The one rendering of a structured check level (CLI, job log and report.md all use it). */
export function checkLabel(level: 'pass' | 'warn' | 'fail' | 'skipped'): string {
  return `[${level === 'pass' ? 'PASS' : level === 'warn' ? 'WARN' : level === 'skipped' ? 'SKIP' : 'FAIL'}]`;
}

export interface ReportInput {
  analysis: CloneAnalysis;
  plan: ClonePlan;
  recompile?: { name: string; result: string; detail: string; compiler: string }[];
  simulation?: SimulationReport | null;
  deployment?: StepResult[] | null;
  /** the signing account of a real deployment (recorded in deployment.json) */
  deployer?: `0x${string}`;
  verification?: VerifyResult[] | null;
  /** rewords human text for the surface that produces the project (the API says `overrides`, the CLI says `--set`); sources and ABI are never touched */
  surface?: { text: (s: string) => string; deep: <T>(v: T) => T };
}

/** deployment.json: what `cmc verify --from-plan` needs to find each step's address. */
export function deploymentRecord(plan: ClonePlan, results: StepResult[], deployer?: `0x${string}`): DeploymentRecord {
  return { chainId: plan.to.chainId, ...(deployer ? { deployer } : {}), steps: results.map((r) => ({ stepId: r.stepId, kind: r.kind ?? 'deploy', address: r.address, txHash: r.txHash })) };
}

export function renderReport(r: ReportInput): string {
  const { analysis: a, plan } = r;
  const L: string[] = [];
  L.push(`# Clone report: ${a.contract.name}`, '');
  L.push(`- Source: \`${a.contract.address}\` on chain ${plan.from.chainId} (provider: ${a.contract.provider})`);
  L.push(`- Destination chain: ${plan.to.chainId}`);
  L.push(`- Licence: ${a.license.id ?? 'none'} (${a.license.class})`);
  if (a.tokenStandards.length) L.push(`- Token standards: ${a.tokenStandards.join(', ')}`);
  L.push('', '> State is not copied. Unaudited: review the sources and plan before deploying real funds.', '');
  L.push('## Steps', '');
  for (const s of plan.steps) {
    L.push(`### ${s.id} (${s.kind}) - ${s.label ?? s.name}`, `source: \`${s.sourceAddress}\``);
    if (s.call) L.push(`call: \`${s.call.signature}\` on step \`${s.call.target}\` (${s.call.discovered ? 'seen on the source chain' : 'detected from the ABI'}${s.call.optional ? ', optional' : ''}${s.call.sourceTx ? `, original tx ${s.call.sourceTx}` : ''})`);
    if (s.create2) L.push(`create2: predicted address ${s.create2.predictedAddress ? `\`${s.create2.predictedAddress}\`` : '(not predictable yet)'}${s.create2.note ? ` - ${s.create2.note}` : ''}`);
    for (const x of s.args) {
      L.push(`- arg ${x.index} \`${x.name}\` (${x.type}): ${x.action}${x.note ? ` - ${x.note}` : ''}\n  - original: \`${JSON.stringify(x.original)}\`\n  - used: \`${JSON.stringify(x.value)}\`${x.suggestion ? '\n  - suggestion: the deploying account' : ''}`);
      if (x.call) for (const y of x.call.args) L.push(`  - ${x.call.function}.${y.name} (${y.type}): ${y.action}${y.note ? ` - ${y.note}` : ''}; used \`${JSON.stringify(y.value)}\``);
    }
    L.push('');
  }
  if (plan.sourceLiterals?.length) {
    L.push('## Hard-coded addresses in source', '');
    for (const l of plan.sourceLiterals) L.push(`- \`${l.original}\` ${l.action}${l.value.toLowerCase() !== l.original.toLowerCase() ? ` -> \`${l.value}\`` : ''} (${l.classification}${l.label ? `, ${l.label}` : ''}) at ${l.locations.map((x) => `${x.file}:${x.line}`).join(', ')}${l.note ? ` - ${l.note}` : ''}`);
    L.push('');
  }
  if (plan.create2) L.push('## Deterministic address', '', `${plan.create2.mode.toUpperCase()} via CreateX \`${plan.create2.factory}\` (present on target: ${plan.create2.factoryVerified}); salt \`${plan.create2.salt}\`${plan.create2.saltDerived ? ' (derived)' : ''}`, '');
  if (plan.warnings.length) L.push('## Warnings', '', ...plan.warnings.map((w) => `- ${w}`), '');
  if (plan.unsupported.length) L.push('## Unsupported', '', ...plan.unsupported.map((w) => `- ${w}`), '');
  if (r.recompile?.length) L.push('## Recompile check (source chain)', '', ...r.recompile.map((x) => `- ${x.name}: **${x.result}** with solc ${x.compiler} (${x.detail})`), '');
  if (r.simulation) {
    L.push('## Fork simulation', '', `Forked via ${r.simulation.forkedFrom}; overall: **${r.simulation.ok ? 'PASS' : 'FAIL'}**`, '');
    for (const x of r.simulation.results) L.push(x.kind === 'call' ? `- called ${x.name} on \`${x.address}\` (gas ${x.gasUsed})` : `- deployed ${x.name} at \`${x.address}\` (gas ${x.gasUsed}, runtime ${x.runtimeMatch.result}: ${x.modifiedSource ? 'modified source, bytecode intentionally differs from the original; ' : ''}${x.runtimeMatch.detail}${x.create2 ? `; CREATE2 predicted ${x.create2.predicted}, actual ${x.create2.actual}` : ''})`);
    L.push('', ...r.simulation.checks.map((c) => `- ${checkLabel(c.level)} ${c.name}: ${c.detail}${c.reason && c.level !== 'pass' ? ` (${c.reason})` : ''}`), '');
  }
  if (r.deployment) L.push('## Deployment', '', ...r.deployment.map((x) => `- ${x.kind === 'call' ? `called ${x.name} on` : `${x.name}:`} \`${x.address}\` (tx ${x.txHash})`), '');
  if (r.verification?.length) L.push('## Explorer verification', '', ...r.verification.map((v) => `- ${v.stepId} on ${v.explorer}: **${v.status}** - ${v.detail}${v.url ? ` (${v.url})` : ''}`), '');
  return L.join('\n');
}

/** Write a self-contained project folder: sources, standard JSON input, plan.json, report.md. */
export async function writeProject(dir: string, r: ReportInput): Promise<string[]> {
  const written: string[] = [];
  const sf = r.surface ?? { text: (x: string) => x, deep: <T,>(v: T) => v };
  const put = async (rel: string, content: string) => {
    const f = join(dir, rel);
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, content);
    written.push(rel);
  };
  const projects: Record<string, ContractProject> = {};
  for (const [key, c] of Object.entries(r.plan.contracts)) {
    const base = projectDirName(key);
    const proj = contractProject(c, `${c.name}, exactly as verified on chain ${r.plan.from.chainId} (${c.compilerVersion}). Generated by CloneMyContracts.`);
    projects[key] = proj;
    for (const [rel, content] of Object.entries(proj.files)) await put(join('contracts', base, rel), content);
    await put(join('contracts', base, 'standard-input.json'), JSON.stringify(c.stdJsonInput, null, 2));
    await put(join('contracts', base, 'abi.json'), JSON.stringify(c.abi, null, 2));
  }
  const toName = (() => { try { return getChain(r.plan.to.chainId).name; } catch { return `chain ${r.plan.to.chainId}`; } })();
  const fromName = (() => { try { return getChain(r.plan.from.chainId).name; } catch { return `chain ${r.plan.from.chainId}`; } })();
  await put('deploy.sh', sf.text(deployScript({ plan: r.plan, projects, toName, libraryFile: (ck, name) => { const c = r.plan.contracts[ck]; const f = c ? findDefinition(c.stdJsonInput.sources, name) : null; return f ? `src/${projects[ck]!.paths[f]}` : null; } })));
  await chmod(join(dir, 'deploy.sh'), 0o755);
  await put('README.md', sf.text(projectReadme({ plan: r.plan, name: r.analysis.contract.name, fromChain: fromName, toName, keys: Object.keys(r.plan.contracts), projects })));
  await put('plan.json', JSON.stringify(sf.deep(r.plan), null, 2));
  if (r.deployment) await put('deployment.json', JSON.stringify(deploymentRecord(r.plan, r.deployment, r.deployer), null, 2));
  await put('analysis.json', JSON.stringify(sf.deep({ ...r.analysis, contract: { ...r.analysis.contract, stdJsonInput: '(see contracts/*/standard-input.json)' }, implementation: r.analysis.implementation ? { ...r.analysis.implementation, contract: { ...r.analysis.implementation.contract, stdJsonInput: '(see contracts/*/standard-input.json)' } } : null }), null, 2));
  await put('report.md', sf.text(renderReport(r)));
  return written;
}
