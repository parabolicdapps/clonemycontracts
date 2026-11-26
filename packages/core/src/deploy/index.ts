import { getChain } from '../chains/index.js';
import { CmcError, type ChainInfo, type ClonePlan } from '../types.js';
import { privateKeyToAccount } from 'viem/accounts';
import { ANVIL_DEV_KEY, startAnvil } from './anvil.js';
import { defaultUrls, executePlanDetailed, makeClients, type ExecuteOutcome, type SkippedStep, type StepResult } from './execute.js';
import { loadAccount } from './keys.js';
import { smokeChecks, type SmokeCheck } from './smoke.js';
import { predictCreate2 } from './create2.js';

export { startAnvil, ANVIL_DEV_KEY } from './anvil.js';
export { executePlan, executePlanDetailed, buildStepTransaction, compileStep, buildInitCode, resolveArgs, isCallStep, unresolvedCall, type StepTransaction, type StepTransactionContext, type StepResult, type SkippedStep, type ExecuteOutcome } from './execute.js';
export { predictCreate2, type Create2Options } from './create2.js';
export { CREATEX, CREATEX_ABI, makeSalt, normaliseSalt, guardSalt, computeCreate2, computeCreate3 } from './createx.js';
export { smokeChecks, pickViewFunctions, type SmokeCheck, type CheckLevel, type CheckKind } from './smoke.js';
export { loadAccount } from './keys.js';

export interface SimulationReport {
  forkedFrom: string;
  results: StepResult[];
  checks: SmokeCheck[];
  ok: boolean;
  /** call steps that were not run (arguments missing) */
  skipped?: SkippedStep[];
}

function assertDeployable(plan: ClonePlan) {
  if (plan.unsupported.length) throw new CmcError(`cannot proceed: ${plan.unsupported.join('; ')}`, 'UNSUPPORTED');
}

/** Execute the plan on a local anvil fork of the target chain and run the smoke checks. */
export async function simulate(plan: ClonePlan, opts: { allowUnresolved?: boolean; onProgress?: (m: string) => void; signal?: AbortSignal } = {}): Promise<SimulationReport> {
  assertDeployable(plan);
  if (plan.create2) {
    // the fork is signed by the anvil dev account, so re-derive the (sender-dependent) CreateX addresses for it
    const dev = privateKeyToAccount(ANVIL_DEV_KEY).address;
    if (!plan.create2.deployer || plan.create2.deployer.toLowerCase() !== dev.toLowerCase()) {
      const simPlan = structuredClone(plan);
      simPlan.warnings = [];
      await predictCreate2(simPlan, { mode: plan.create2.mode, salt: plan.create2.saltDerived ? undefined : plan.create2.salt, deployer: dev });
      if (plan.create2.saltDerived || plan.create2.deployer) opts.onProgress?.('simulation signs with the anvil dev account, so the CreateX addresses differ from the plan (the sender is part of a permissioned salt)');
      plan = simPlan;
    }
  }
  const chain = getChain(plan.to.chainId);
  const anvil = await startAnvil(chain, { signal: opts.signal });
  const stopOnAbort = () => void anvil.stop();
  opts.signal?.addEventListener('abort', stopOnAbort, { once: true });
  try {
    if (opts.signal?.aborted) throw new CmcError('cancelled', 'INTERNAL');
    opts.onProgress?.(`forked ${chain.name} via ${new URL(anvil.forkUrl).host}`);
    const { pub, wallet } = makeClients(chain, [anvil.url], privateKeyToAccount(ANVIL_DEV_KEY));
    const { results, skipped } = await executePlanDetailed(plan, { chain, pub, wallet, allowUnresolved: opts.allowUnresolved ?? true, onProgress: opts.onProgress });
    const checks = await smokeChecks(plan, results, pub, { deployer: wallet.account!.address, skipped });
    return { forkedFrom: new URL(anvil.forkUrl).host, results, checks, ok: checks.every((c) => c.ok) && results.every((r) => r.runtimeMatch.result !== 'mismatch'), skipped };
  } finally {
    opts.signal?.removeEventListener('abort', stopOnAbort);
    await anvil.stop();
  }
}

export interface DeployOptions {
  yes: boolean;
  mainnet?: boolean;
  allowUnresolved?: boolean;
  onProgress?: (m: string) => void;
  /** called with the deployer address and chain before sending; return false to abort */
  confirm?: (info: { chain: ChainInfo; deployer: string; steps: number }) => Promise<boolean> | boolean;
}

/** Deploy for real with the user's own key. Requires `yes` (or an interactive `confirm`), and `mainnet` for non-testnets. */
export async function deployPlanDetailed(plan: ClonePlan, opts: DeployOptions): Promise<ExecuteOutcome> {
  assertDeployable(plan);
  const chain = getChain(plan.to.chainId);
  if (!chain.testnet && !opts.mainnet) throw new CmcError(`${chain.name} is a mainnet: add --mainnet to confirm you intend to spend real funds`, 'INPUT');
  const account = loadAccount();
  if (!opts.yes) {
    const ok = opts.confirm ? await opts.confirm({ chain, deployer: account.address, steps: plan.steps.length }) : false;
    if (!ok) throw new CmcError('deployment not confirmed (pass --yes)', 'INPUT');
  }
  const { pub, wallet } = makeClients(chain, defaultUrls(chain), account);
  const bal = await pub.getBalance({ address: account.address }).catch((e) => { throw new CmcError(`RPC for ${chain.name} failed: ${(e as Error).message.split('\n')[0]}`, 'RPC'); });
  if (bal === 0n) throw new CmcError(`deployer ${account.address} has no ${chain.nativeCurrency} on ${chain.name}`, 'DEPLOY');
  return executePlanDetailed(plan, { chain, pub, wallet, allowUnresolved: opts.allowUnresolved, onProgress: opts.onProgress });
}

/** Deploy for real (see {@link deployPlanDetailed}); returns only the step results. */
export async function deployPlan(plan: ClonePlan, opts: DeployOptions): Promise<StepResult[]> {
  return (await deployPlanDetailed(plan, opts)).results;
}
