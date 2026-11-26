import type { ContractSpec, ScenarioSet, TokenFacts } from '../../types.js';
import { classifyStandard } from '../../spec/standard.js';
import { DEFAULT_CONTAINER, extractResult, runToolchain, type ContainerConfig } from '../../pipeline/container.js';
import type { CompileResult, GenerateContext, ScenarioRun, TargetPack, TemplateResult } from '../pack.js';
import { buildProgramPlan, buildSplPlan, type RunnerResult } from './adapter.js';
import { checkConformance } from './conformance.js';
import { compareResults } from './compare.js';
import { buildDesign } from './design.js';
import type { SolanaDesign } from './design-types.js';
import { assembleProject } from './project.js';
import { SYSTEM, failingHandlers, behaviourRepairPrompt, firstErrorBlocks, hintsFor, instructionPrompt, repairPrompt, sourceLookup } from './prompts.js';
import { SOLANA_FEATURE_DETAIL } from './wording.js';
import { buildTemplateDesign, splRecipeFiles } from './template.js';

export class SolanaPack implements TargetPack<SolanaDesign> {
  readonly id = 'solana';
  readonly label = 'Solana (Rust / Anchor 1.2.2)';
  readonly language = 'Rust (Anchor)';
  constructor(private container: ContainerConfig = DEFAULT_CONTAINER) {}

  describeNonPortable(spec: ContractSpec) { return spec.nonPortable.map((n) => ({ ...n, detail: SOLANA_FEATURE_DETAIL[n.id] ?? n.detail })); }

  design(spec: ContractSpec, opts: { decimals?: number }): SolanaDesign { return buildDesign(spec, { solanaDecimals: opts.decimals ?? 9 }); }

  templates(spec: ContractSpec, opts: { decimals?: number; facts?: TokenFacts }): TemplateResult<SolanaDesign> | null {
    const v = classifyStandard(spec);
    if (!v.match) return null;
    const m = v.match;
    const origDec = opts.facts?.decimals ?? Number(spec.stateVars.find((s) => s.name === 'decimals')?.initial?.value ?? 18);
    const design = buildTemplateDesign(spec, m, m.standard === 'ERC-721' ? 0 : origDec, m.standard === 'ERC-721' ? 0 : opts.decimals ?? 9);
    const files = splRecipeFiles(spec, m, design, { ...(opts.facts ? { facts: opts.facts } : {}) });
    return { design, files, standard: m.standard, needsProgram: false, buildRun: (set) => buildSplPlan({ spec, design, set }, { initialSupplyParam: m.initialSupplyParam, decimalsFn: true, mintable: m.features.mintable, burnable: m.features.burnable, ownable: m.features.ownable }) };
  }

  units(design: SolanaDesign): string[] { return design.instructions.map((i) => i.name); }

  generatePrompt(ctx: GenerateContext<SolanaDesign>, unit: string) {
    const ins = ctx.design.instructions.find((i) => i.name === unit)!;
    return { system: SYSTEM, user: instructionPrompt(ctx.spec, ctx.design, ins, sourceLookup(ctx.sources)) };
  }

  assemble(spec: ContractSpec, design: SolanaDesign, bodies: Record<string, string>) { return assembleProject(spec, design, bodies); }

  async compile(files: Record<string, string>, onLog?: (s: string) => void): Promise<CompileResult> {
    const r = await runToolchain(this.container, 'compile', files, { wantOut: true, ...(onLog ? { onLog } : {}) });
    const artifacts: Record<string, Buffer> = {};
    for (const n of ['app.so', 'app.json']) if (r.out[n]) artifacts[n] = r.out[n]!;
    return { ok: r.code === 0 && !!artifacts['app.so'] && !!artifacts['app.json'], log: r.log, seconds: r.seconds, artifacts };
  }

  blame(log: string, design: SolanaDesign) { const f = failingHandlers(log, design); return { units: f.handlers, other: f.other || f.handlers.size === 0 }; }

  repairPrompt(design: SolanaDesign, unit: string, body: string, log: string) {
    const ins = design.instructions.find((i) => i.name === unit)!;
    // only the error blocks that point at this handler
    const blocks = firstErrorBlocks(log, 12, 20000).split(/\n\n(?=error)/).filter((b) => b.includes(`logic/${unit}.rs`));
    const text = (blocks.length ? blocks.slice(0, 4).join('\n\n') : firstErrorBlocks(log, 4, 5000));
    return { system: SYSTEM, user: repairPrompt(ins, body, text, hintsFor(text)) };
  }

  behaviourRepairPrompt(design: SolanaDesign, unit: string, body: string, problems: string[]) {
    return { system: SYSTEM, user: behaviourRepairPrompt(design.instructions.find((i) => i.name === unit)!, body, problems) };
  }

  unitOf(design: SolanaDesign, fn: string): string | null {
    if (fn === 'receive') return design.instructions.find((i) => i.kind === 'receive')?.name ?? null;
    if (fn === 'constructor') return 'initialize';
    return design.instructions.find((i) => i.solidity === fn)?.name ?? null;
  }

  async runScenarios(files: Record<string, string>, compiled: CompileResult, design: SolanaDesign, spec: ContractSpec, set: ScenarioSet): Promise<ScenarioRun> {
    const t0 = Date.now();
    let conformance: string[] = [];
    let built;
    if (design.mode === 'template') {
      const t = this.templates(spec, { decimals: design.decimals.solana })!;
      built = t.buildRun(set) as ReturnType<typeof buildSplPlan>;
    } else {
      try { conformance = checkConformance(JSON.parse(compiled.artifacts['app.json']!.toString('utf8')), design); } catch (e) { conformance = [`IDL unreadable: ${(e as Error).message}`]; }
      built = buildProgramPlan({ spec, design, set });
    }
    const project = { ...files, 'cmc/plan.json': JSON.stringify(built.plan) };
    const r = await runToolchain(this.container, 'run-plan', project, design.mode === 'program' ? { artifacts: compiled.artifacts } : {});
    const res = extractResult(r.log) as RunnerResult | null;
    if (!res) return { outcomes: [], seconds: (Date.now() - t0) / 1000, fatal: `the runner produced no result (exit ${r.code}): ${r.log.slice(-600)}`, conformance };
    return { outcomes: compareResults(set, built, res, design), seconds: (Date.now() - t0) / 1000, conformance };
  }

  deployCommands(design: SolanaDesign, spec: ContractSpec): string[] {
    if (design.mode === 'template') return ['bash deploy-devnet.sh   # creates the SPL mint, your token account and the initial supply on devnet'];
    return [
      'solana config set --url devnet && solana-keygen new -o ~/.config/solana/id.json   # skip if you have a keypair',
      'solana airdrop 2   # devnet SOL for fees and rent',
      'anchor build',
      'anchor keys sync   # replaces the placeholder program id with a fresh keypair',
      'anchor build && anchor deploy --provider.cluster devnet',
      `# then call \`initialize\` once (accounts: ${design.instructions[0]!.accounts.map((a) => a.name).join(', ')}), see design.json for every instruction's accounts and PDA seeds`,
      `# ${spec.name}: not audited`,
    ];
  }
}
