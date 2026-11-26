import type { PublicClient } from 'viem';
import { getClient } from '../util/rpc.js';
import { getChain } from '../chains/index.js';
import { PROXY_IMPL_SLOTS } from '../analyse/index.js';
import { jsonSafe } from '../util/abi.js';
import { showValue } from '../util/hex.js';
import type { AbiItem, Address, ClonePlan, Hex } from '../types.js';
import { BEACON_SLOT, SEL_BEACON_IMPLEMENTATION, addressFromWord } from '../analyse/proxies.js';
import type { SkippedStep, StepResult } from './execute.js';

export type CheckLevel = 'pass' | 'warn' | 'fail' | 'skipped';
export type CheckKind = 'code-present' | 'view-call' | 'proxy-slot' | 'initialised' | 'patched-literal' | 'skipped-step' | 'recompile' | 'deploy' | 'call';

/**
 * `ok` and `detail` are the original pass/fail and text. The structured fields are additive:
 * `level` (warn = passed but needs a look), `kind`, `subject` (step id), and for comparisons with the original
 * `cloneValue`, `originalValue`, `relation` and `reason`.
 */
export interface SmokeCheck {
  name: string; ok: boolean; detail: string;
  level: CheckLevel;
  kind: CheckKind;
  subject: string;
  cloneValue?: unknown;
  originalValue?: unknown;
  relation?: 'same' | 'differs-expected' | 'differs';
  reason?: string;
}

/** View functions whose value is expected to differ on a clone (owner, supply, chain-bound constants). */
const EXPECTED_DIFFERENT = /^(owner|admin|totalSupply|DOMAIN_SEPARATOR|getChainId|chainId|CHAIN_ID|_?chainId|.*[Oo]wner|.*[Aa]dmin|pendingOwner|nonce|.*[Ss]igner|.*[Mm]inter|.*[Pp]auser|.*[Bb]lacklister)$/;

const PREFERRED = ['name', 'symbol', 'decimals', 'totalSupply', 'owner', 'WETH', 'WETH9', 'factory', 'version', 'paused', 'implementation', 'admin', 'asset'];

export function pickViewFunctions(abi: AbiItem[], max = 10): AbiItem[] {
  const views = abi.filter((i) => i.type === 'function' && (i.stateMutability === 'view' || i.stateMutability === 'pure') && (i.inputs?.length ?? 0) === 0 && (i.outputs?.length ?? 0) > 0);
  const score = (i: AbiItem) => { const k = PREFERRED.indexOf(i.name ?? ''); return k === -1 ? 100 : k; };
  return [...views].sort((a, b) => score(a) - score(b)).slice(0, max);
}

async function tryCall(c: PublicClient, address: Address, item: AbiItem): Promise<{ ok: boolean; value?: unknown; err?: string }> {
  try {
    const v = await c.readContract({ address, abi: [item] as any, functionName: item.name! as any });
    return { ok: true, value: jsonSafe(v) };
  } catch (e) {
    return { ok: false, err: (e as Error).message.split('\n')[0] };
  }
}

const ZERO = '0x0000000000000000000000000000000000000000';

/** Run smoke checks on the deployed steps. `target` is the (forked) target chain client. */
export async function smokeChecks(plan: ClonePlan, results: StepResult[], target: PublicClient, ctx: { deployer?: Address; skipped?: SkippedStep[] } = {}): Promise<SmokeCheck[]> {
  const checks: SmokeCheck[] = [];
  const source = getClient(getChain(plan.from.chainId));
  const deploys = results.filter((r) => r.kind !== 'call');
  const ranInit = results.some((r) => r.kind === 'call' && plan.steps.find((x) => x.id === r.stepId)?.kind === 'initialise') || deploys.some((r) => r.callData && r.callData !== '0x');
  const expectsInit = !!plan.initialisation && plan.initialisation.mode !== 'none';
  // values that are remapped on purpose (so a difference from the original is expected)
  const remappedNow = new Set<string>(), remappedWas = new Set<string>();
  const collect = (a: { action: string; value: unknown; original: unknown }) => { if (a.action === 'remap' || a.action === 'keep') { if (typeof a.value === 'string' && typeof a.original === 'string' && a.value !== a.original) { remappedNow.add(a.value.toLowerCase()); remappedWas.add(a.original.toLowerCase()); } } };
  for (const st of plan.steps) for (const a of st.args) { collect(a); for (const y of a.call?.args ?? []) collect(y); }
  for (const l of plan.sourceLiterals ?? []) if (l.value.toLowerCase() !== l.original.toLowerCase()) { remappedNow.add(l.value.toLowerCase()); remappedWas.add(l.original.toLowerCase()); }
  for (const r of deploys) {
    const step = plan.steps.find((s) => s.id === r.stepId)!;
    const code = await target.getCode({ address: r.address });
    checks.push({ kind: 'code-present', subject: r.stepId, level: code && code !== '0x' ? 'pass' : 'fail', name: `${r.stepId}: code present`, ok: !!code && code !== '0x', detail: `${code ? (code.length - 2) / 2 : 0} bytes at ${r.address}` });
    if (step.kind === 'library') continue;
    const abi = plan.contracts[step.contractKey]!.abi;
    const useAbi = step.kind === 'proxy' || step.kind === 'minimal-proxy' ? plan.contracts['implementation']?.abi ?? abi : abi;
    for (const fn of pickViewFunctions(useAbi, 8)) {
      const t = await tryCall(target, r.address, fn);
      const s = await tryCall(source, step.sourceAddress, fn);
      const fmt = (x: { ok: boolean; value?: unknown; err?: string }) => (x.ok ? showValue(x.value) : `reverted`);
      // pass unless it worked on the source chain and fails on the clone
      const fnName = fn.name ?? '';
      const ok = t.ok || !s.ok;
      let level: CheckLevel = ok ? 'pass' : 'fail';
      let relation: SmokeCheck['relation'];
      let reason: string | undefined;
      if (t.ok && s.ok) {
        const same = JSON.stringify(t.value) === JSON.stringify(s.value);
        const lc = (v: unknown) => (typeof v === 'string' ? v.toLowerCase() : '');
        const uninitProxy = ['proxy', 'minimal-proxy'].includes(step.kind) && expectsInit && !ranInit;
        if (same) relation = 'same';
        else if (uninitProxy) { relation = 'differs'; level = 'warn'; reason = 'the proxy clone was not initialised (its initialiser did not run), so its state is empty'; }
        else if (EXPECTED_DIFFERENT.test(fnName)) { relation = 'differs-expected'; reason = 'owner/supply/chain-bound values differ on a fresh clone'; }
        else if (remappedNow.has(lc(t.value)) || remappedWas.has(lc(s.value))) { relation = 'differs-expected'; reason = 'address remapped for the target chain'; }
        else if (step.id === 'implementation' && step.kind === 'implementation') { relation = 'differs-expected'; reason = 'the implementation is deliberately a fresh, uninitialised contract'; }
        else { relation = 'differs'; level = 'warn'; reason = 'value differs from the original and is not an expected difference'; }
      } else if (!t.ok && s.ok) { reason = 'the call reverts on the clone but works on the original'; relation = 'differs'; }
      checks.push({ kind: 'view-call', subject: r.stepId, level, relation, reason, cloneValue: t.ok ? t.value : undefined, originalValue: s.ok ? s.value : undefined, name: `${r.stepId}: ${fn.name}()`, ok, detail: `clone=${fmt(t)} original=${s.err && !s.ok ? 'unavailable' : fmt(s)}` });
    }
  }
  // patched hard-coded addresses: the new one must show up in the deployed code or early storage, the old one must not be in the code
  for (const r of deploys) {
    const lits = (plan.sourceLiterals ?? []).filter((l) => l.stepId === r.stepId && l.value.toLowerCase() !== l.original.toLowerCase());
    if (!lits.length) continue;
    const code = ((await target.getCode({ address: r.address })) ?? '0x').toLowerCase();
    const slots: string[] = [];
    for (let i = 0; i < 12; i++) slots.push(((await target.getStorageAt({ address: r.address, slot: `0x${i.toString(16)}` as Hex })) ?? '0x').toLowerCase());
    for (const l of lits) {
      const nu = l.value.slice(2).toLowerCase(), old = l.original.slice(2).toLowerCase();
      const inNew = code.includes(nu) || slots.some((x) => x.includes(nu));
      checks.push({ kind: 'patched-literal', subject: r.stepId, level: inNew && !code.includes(old) ? 'pass' : 'fail', name: `${r.stepId}: patched address ${l.original} -> ${l.value}`, ok: inNew && !code.includes(old), detail: `${inNew ? 'new address present' : 'new address NOT found in code or storage slots 0-11'}${code.includes(old) ? '; old address still in the code' : ''}` });
    }
  }
  const proxy = deploys.find((r) => ['proxy', 'minimal-proxy'].includes(plan.steps.find((s) => s.id === r.stepId)?.kind ?? ''));
  const impl = deploys.find((r) => r.stepId === 'implementation');
  const beacon = deploys.find((r) => r.stepId === 'beacon');
  if (proxy && impl && !beacon) {
    let found = false;
    let detail = 'no implementation slot holds the new implementation';
    if (proxy.stepId === 'minimal-proxy') {
      const code = (await target.getCode({ address: proxy.address }))?.toLowerCase() ?? '';
      found = code.includes(impl.address.slice(2).toLowerCase());
      detail = found ? `EIP-1167 code delegates to ${impl.address}` : 'minimal proxy code does not reference the new implementation';
    } else {
      for (const s of PROXY_IMPL_SLOTS) {
        const v = await target.getStorageAt({ address: proxy.address, slot: s.slot });
        if (v && v.toLowerCase().endsWith(impl.address.slice(2).toLowerCase())) { found = true; detail = `${s.name} slot -> ${impl.address}`; break; }
      }
    }
    checks.push({ kind: 'proxy-slot', subject: proxy.stepId, level: found ? 'pass' : 'fail', name: 'proxy points at the new implementation', ok: found, detail });
  }
  if (proxy && beacon) {
    const bs = addressFromWord(await target.getStorageAt({ address: proxy.address, slot: BEACON_SLOT }));
    const impl2 = impl ? addressFromWord((await target.call({ to: beacon.address, data: SEL_BEACON_IMPLEMENTATION }).catch(() => ({ data: undefined as Hex | undefined }))).data) : null;
    checks.push({ kind: 'proxy-slot', subject: proxy.stepId, level: bs?.toLowerCase() === beacon.address.toLowerCase() && (!impl || impl2?.toLowerCase() === impl.address.toLowerCase()) ? 'pass' : 'fail', name: 'beacon proxy -> new beacon -> new implementation', ok: bs?.toLowerCase() === beacon.address.toLowerCase() && (!impl || impl2?.toLowerCase() === impl.address.toLowerCase()), detail: `beacon slot ${bs ?? 'empty'}; beacon.implementation() ${impl2 ?? 'unreadable'}` });
  }

  // ---- initialisation ---------------------------------------------------------------------
  const main = proxy;
  const initResults = results.filter((r) => r.kind === 'call' && plan.steps.find((s) => s.id === r.stepId)?.kind === 'initialise');
  const ctorData = deploys.find((r) => r.callData && r.callData !== '0x');
  if (main && (initResults.length || ctorData)) {
    const replay = ctorData ? ctorData.callData! : initResults[0]!.callData!;
    const fn = ctorData ? plan.steps.find((s) => s.id === ctorData.stepId)?.args.find((x) => x.call)?.call?.signature : plan.steps.find((s) => s.id === initResults[0]!.stepId)?.call?.signature;
    let reverted = false;
    let why = '';
    try { await target.call({ account: ctx.deployer, to: main.address, data: replay }); } catch (e) { reverted = true; why = (e as Error).message.split('\n')[0]!.slice(0, 100); }
    checks.push({ kind: 'initialised', subject: main.stepId, level: reverted ? 'pass' : 'fail', name: `initialised: calling ${fn} again reverts`, ok: reverted, detail: reverted ? `reverted (${why})` : 'succeeded: the clone can be initialised again, so it was not initialised (or the initialiser is unprotected)' });
    // token-like state must not be empty/zero any more
    const abi = plan.contracts['implementation']?.abi ?? [];
    for (const nm of ['name', 'symbol', 'decimals', 'owner']) {
      const item = abi.find((i) => i.type === 'function' && i.name === nm && (i.inputs?.length ?? 0) === 0 && (i.outputs?.length ?? 0) === 1);
      if (!item) continue;
      const t = await tryCall(target, main.address, item);
      const s = await tryCall(source, plan.steps.find((x) => x.id === main.stepId)!.sourceAddress, item);
      const empty = (v: unknown) => v === '' || v === '0' || v === ZERO || v === 0;
      const cv = t.ok ? t.value : undefined;
      const same = t.ok && s.ok && JSON.stringify(cv) === JSON.stringify(s.value);
      const okEmpty = t.ok && !(s.ok && !empty(s.value) && empty(cv));
      const display = (x: unknown) => showValue(x);
      checks.push({
        kind: 'initialised', subject: main.stepId, level: okEmpty ? 'pass' : 'fail', cloneValue: cv, originalValue: s.ok ? s.value : undefined,
        relation: t.ok && s.ok ? (same ? 'same' : nm === 'owner' ? 'differs-expected' : 'differs') : undefined,
        reason: t.ok && s.ok && !same ? (nm === 'owner' ? 'you chose your own owner' : 'value set by the initialiser arguments you supplied') : undefined,
        name: `initialised: ${nm}() set`, ok: okEmpty,
        detail: t.ok ? `clone=${display(cv)}${s.ok ? ` original=${display(s.value)}${same ? ' (same)' : nm === 'owner' ? ' (differs: your own owner)' : ' (differs)'}` : ''}` : 'reverted on the clone',
      });
    }
  }
  for (const k of ctx.skipped ?? []) {
    const st = plan.steps.find((x) => x.id === k.stepId);
    const required = !!st?.call && !st.call.optional;
    checks.push({ kind: 'skipped-step', subject: k.stepId, level: required ? 'fail' : 'skipped', name: `skipped ${k.stepId}`, ok: !required, detail: required ? `REQUIRED step not run, the clone is not initialised: ${k.reason}` : k.reason });
  }
  return checks;
}
