import type { ContractSpec, ScenarioSet, TokenFacts } from '../types.js';

export type ProjectFiles = Record<string, string>;

export interface CompileResult {
  ok: boolean;
  log: string;
  seconds: number;
  /** binary artifacts needed to run scenarios (e.g. the .so and IDL) */
  artifacts: Record<string, Buffer>;
}

export interface ScenarioOutcomeLike {
  id: string; title: string; kind: string; fn?: string;
  status: 'passed' | 'failed' | 'not-runnable' | 'documented-difference';
  mismatches: { at: string; what: string; expected: unknown; actual: unknown; documented?: string }[];
  notRunnable: string[]; checked: number; notes: string[];
}

export interface ScenarioRun {
  outcomes: ScenarioOutcomeLike[];
  seconds: number;
  /** problems that prevented running at all */
  fatal?: string;
  /** design/IDL conformance problems (account names, seeds) that made scenarios unrunnable */
  conformance: string[];
}

export interface TemplateResult<D> {
  design: D;
  /** files of the deployment recipe / any extra program */
  files: ProjectFiles;
  /** why this contract was treated as a standard */
  standard: string;
  /** whether a program is needed at all */
  needsProgram: boolean;
  /** scenario runner info */
  buildRun: (set: ScenarioSet) => unknown;
}

export interface GenerateContext<D> {
  spec: ContractSpec;
  design: D;
  /** source text of the original */
  sources: Record<string, string>;
}

/**
 * One target language/chain. The pipeline core (spec, scenarios, model client, repair loops, report) is target independent and only
 * talks to this interface. A pack owns: the deterministic design mapping, standard-first templates, prompts, the compiler sandbox
 * and the scenario runner for its chain.
 */
export interface TargetPack<D = unknown> {
  readonly id: string;
  readonly label: string;
  /** the language the rewrite is written in, for display */
  readonly language?: string;
  /** optional report wording (default: the Solana wording) */
  /** optional: target specific wording of the non-portable feature list (default: spec.nonPortable) */
  describeNonPortable?(spec: ContractSpec): ContractSpec['nonPortable'];
  readonly reportLabels?: { runtime: string; template: string; model: string; deployTitle: string };
  /** deterministic mapping rules: spec -> design the generator must follow */
  design(spec: ContractSpec, opts: { decimals?: number }): D;
  /** standard-first: a hand-written recipe for plain token standards, or null when the model path is needed */
  templates(spec: ContractSpec, opts: { decimals?: number; facts?: TokenFacts }): TemplateResult<D> | null;
  /** units of generation (instructions/modules) */
  units(design: D): string[];
  /** system + user prompt for one unit */
  generatePrompt(ctx: GenerateContext<D>, unit: string): { system: string; user: string };
  /** assemble the project from per-unit model outputs (anything missing becomes a stub) */
  assemble(spec: ContractSpec, design: D, bodies: Record<string, string>): ProjectFiles;
  /** compile in the sandbox */
  compile(files: ProjectFiles, onLog?: (s: string) => void): Promise<CompileResult>;
  /** which units a compiler log blames (and whether anything outside the units failed) */
  blame(log: string, design: D): { units: Set<string>; other: boolean };
  repairPrompt(design: D, unit: string, body: string, log: string): { system: string; user: string };
  behaviourRepairPrompt(design: D, unit: string, body: string, problems: string[]): { system: string; user: string };
  /** run the neutral scenarios against the compiled rewrite */
  runScenarios(files: ProjectFiles, compiled: CompileResult, design: D, spec: ContractSpec, set: ScenarioSet): Promise<ScenarioRun>;
  /** maps a Solidity function name to the unit that implements it */
  unitOf(design: D, fn: string): string | null;
  deployCommands(design: D, spec: ContractSpec): string[];
}
