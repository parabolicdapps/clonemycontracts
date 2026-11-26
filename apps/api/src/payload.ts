import { CmcError, type ClonePlan, type PlanStep, type StepTransaction } from '@cmc/core';
import type { Backend } from './backend.js';
import { assertPlannable } from './service.js';

/** `done`: the browser already deployed or sent this step (nothing is built for it). */
export type PayloadStatus = 'ready' | 'waiting' | 'skipped' | 'unsupported' | 'done';

export interface StepPayload {
  id: string;
  kind: string;
  label: string;
  name: string;
  status: PayloadStatus;
  waitingFor: string[];
  /** null for a contract creation; the target contract for call steps */
  to: `0x${string}` | null;
  data: `0x${string}` | null;
  value: `0x${string}`;
  /** call steps: the function being called */
  call?: { signature: string; function: string; target: string; optional: boolean; discovered: boolean };
  /** why the step is skipped / waiting / cannot be built */
  note?: string;
  /** skipped because a required step lacks input: a real deployment cannot go on */
  blocking?: boolean;
}

export const isCall = (s: PlanStep) => s.kind === 'initialise' || s.kind === 'admin';

/**
 * For each plan step, the unsigned transaction the browser wallet should send, built by the core's
 * `buildStepTransaction` (the same code the CLI executor uses, including the per-chain opcode refusal).
 * The server compiles and encodes but never signs: there is no key here.
 */
export async function buildPayload(
  backend: Backend,
  plan: ClonePlan,
  state: { deployed: Record<string, `0x${string}`>; deployer?: `0x${string}`; completed: string[] },
): Promise<StepPayload[]> {
  assertPlannable(plan);
  if (plan.needsInput.length) throw new CmcError(`These arguments still need a value: ${plan.needsInput.join(', ')}`, 'INPUT');
  if (plan.create2) throw new CmcError('Plans with CREATE2/CREATE3 are not supported in the browser yet. Use the cmc CLI.', 'UNSUPPORTED');
  const out: StepPayload[] = [];
  const skipped: string[] = [];
  const done = new Set([...Object.keys(state.deployed), ...state.completed]);
  for (const step of plan.steps as PlanStep[]) {
    const base = {
      id: step.id, kind: step.kind as string, label: step.label ?? `${step.kind} ${step.name}`, name: step.name,
      waitingFor: [] as string[], to: null as `0x${string}` | null, data: null as `0x${string}` | null, value: '0x0' as const,
      ...(isCall(step) && step.call ? { call: { signature: step.call.signature, function: step.call.function, target: step.call.target, optional: step.call.optional, discovered: step.call.discovered } } : {}),
    };
    if (done.has(step.id)) { out.push({ ...base, status: 'done' }); continue; }
    const tx: StepTransaction = await backend.buildStep(plan, step.id, { deployed: state.deployed, deployer: state.deployer, completed: state.completed, skipped });
    if (tx.status === 'unsupported') throw new CmcError(`${step.label ?? step.name}: ${tx.reason ?? 'cannot be built'}`, tx.errorCode ?? 'UNSUPPORTED');
    if (tx.status === 'skipped') skipped.push(step.id);
    out.push({
      ...base,
      status: tx.status,
      waitingFor: tx.waitingFor ?? [],
      to: tx.status === 'ready' ? (tx.to ?? null) : null,
      data: tx.status === 'ready' ? (tx.data ?? null) : null,
      ...(tx.reason ? { note: tx.reason } : {}),
      ...(tx.blocking ? { blocking: true } : {}),
    });
  }
  return out;
}
