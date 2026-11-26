import {
  CmcError, analyseContract, analyseMinimalProxy, buildStepTransaction, fetchEarlyTransactions, fetchVerifiedContract, getChain, getClient, planClone, recompileCheck, simulate,
  type CloneAnalysis, type ClonePlan, type Overrides, type SimulationReport, type StepTransaction, type StepTransactionContext, type VerifiedContract,
} from '@cmc/core';
import { isAddress } from 'viem';

export interface RecompileResult { name: string; result: string; detail: string; compiler: string }

/** Everything the API needs from the core. Tests inject fixtures here; production uses the live core. */
export interface Backend {
  /** `onStage` receives real progress texts (source fetched, implementation, history scan ...). */
  analyse(address: string, chainId: number, onStage?: (text: string) => void): Promise<CloneAnalysis>;
  plan(analysis: CloneAnalysis, toChainId: number, overrides: Overrides, onLibrary?: (vc: VerifiedContract) => void): Promise<ClonePlan>;
  recompile(vc: VerifiedContract): Promise<RecompileResult>;
  simulate(plan: ClonePlan, onProgress: (m: string) => void, signal?: AbortSignal): Promise<SimulationReport>;
  /** The unsigned transaction for one plan step (the same function the CLI executor uses). */
  buildStep(plan: ClonePlan, stepId: string, ctx: StepTransactionContext): Promise<StepTransaction>;
}

export const coreBackend: Backend = {
  // `analyse()` of the core, unrolled so the real stages can be reported
  async analyse(address, chainId, onStage = () => {}) {
    const chain = getChain(chainId);
    if (!isAddress(address)) throw new CmcError(`"${address}" is not a valid address`, 'INPUT');
    onStage(`Fetching the verified source from ${chain.name} (Sourcify, then explorers)…`);
    const opts = {
      fetchEarlyTransactions: async (...a: Parameters<typeof fetchEarlyTransactions>) => {
        onStage('Reading the proxy’s early transactions to find its initialiser (explorer history, can take up to a minute)…');
        const r = await fetchEarlyTransactions(...a);
        onStage(`History read (${r.source}).`);
        return r;
      },
      fetchImplementation: async (id: number, a: `0x${string}`) => {
        onStage('Fetching the implementation source…');
        return fetchVerifiedContract(id, a);
      },
      // linked libraries: only their licence is read
      fetchLibrary: (id: number, a: `0x${string}`) => fetchVerifiedContract(id, a),
    };
    let vc: VerifiedContract;
    try {
      vc = await fetchVerifiedContract(chain.chainId, address);
    } catch (e) {
      if (e instanceof CmcError && e.code === 'UNVERIFIED') {
        const m = await analyseMinimalProxy(address as `0x${string}`, chain.chainId, opts).catch(() => null);
        if (m) return m;
      }
      throw e;
    }
    onStage(`Source fetched (${vc.name}, ${vc.provider}). Analysing proxies, libraries and addresses…`);
    const a = await analyseContract(vc, opts);
    onStage('Analysis done.');
    return a;
  },
  plan: (analysis, toChainId, overrides, onLibrary) => planClone(analysis, toChainId, overrides, {
    onLibrary,
    // the verified name of a contract dependency, to explain it in the plan (best effort)
    contractName: async (id, a) => (await fetchVerifiedContract(id, a).catch(() => null))?.name ?? null,
  }),
  async recompile(vc) {
    const reader = getClient(getChain(vc.chainId));
    try {
      const r = await recompileCheck(vc, async (a) => reader.getCode({ address: a }));
      return { name: vc.name, ...r };
    } catch (e) {
      return { name: vc.name, result: 'error', detail: (e as Error).message.split('\n')[0]!, compiler: vc.compilerVersion };
    }
  },
  simulate: (plan, onProgress, signal) => simulate(plan, { allowUnresolved: true, onProgress, signal }),
  buildStep: (plan, stepId, ctx) => buildStepTransaction(plan, stepId, ctx),
};
