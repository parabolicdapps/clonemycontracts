import { describe, expect, it } from 'vitest';
import { analyseContract, analyseMinimalProxy } from '../src/analyse/index.js';
import { getChain } from '../src/chains/index.js';
import { buildStepTransaction, executePlanDetailed } from '../src/deploy/execute.js';
import { planClone } from '../src/plan/index.js';
import { normaliseBlockscout } from '../src/fetch/blockscout.js';
import { normaliseSourcify } from '../src/fetch/sourcify.js';
import { normaliseTxList } from '../src/fetch/history.js';
import { CmcError, type Address, type ClonePlan, type Hex, type StdJsonInput } from '../src/types.js';
import { ADDR, fetchFixture, fx, loadVc, offlineExplorer, stubReader } from './helpers.js';
import { BEACON_SLOT, SEL_BEACON_IMPLEMENTATION } from '../src/analyse/proxies.js';

const DEPLOYER = '0x00000000000000000000000000000000000000d4' as Address;

/** A wallet/client pair that records what would be sent and answers like a chain that accepts everything. */
function fakeChain() {
  const sent: { to?: Address | null; data: Hex }[] = [];
  let n = 0x1000;
  const wallet = { account: { address: DEPLOYER }, chain: undefined, sendTransaction: async (tx: { to?: Address; data: Hex }) => { sent.push({ to: tx.to ?? null, data: tx.data }); return `0x${sent.length.toString(16).padStart(64, '0')}` as Hex; } };
  const pub = {
    waitForTransactionReceipt: async () => ({ status: 'success', contractAddress: `0x${(n++).toString(16).padStart(40, '0')}` as Address, gasUsed: 1n, logs: [] }),
    getCode: async () => '0x',
  };
  return { sent, wallet: wallet as any, pub: pub as any };
}

/** Executes the plan on the fake chain, then rebuilds every step with buildStepTransaction and requires identical transactions. */
async function equalsExecutor(plan: ClonePlan) {
  const fc = fakeChain();
  const chain = getChain(plan.to.chainId);
  const out = await executePlanDetailed(plan, { chain, pub: fc.pub, wallet: fc.wallet, allowUnresolved: true });
  expect(out.results.length).toBeGreaterThan(0);
  const deployed = new Map<string, Address>();
  const done: string[] = [];
  const skipped = out.skipped.map((k) => k.stepId);
  let i = 0;
  for (const step of plan.steps) {
    const ran = out.results.find((r) => r.stepId === step.id);
    const tx = await buildStepTransaction(plan, step.id, { deployed, deployer: DEPLOYER, completed: done, skipped, chain, allowUnresolved: true });
    if (!ran) { expect(['skipped', 'waiting']).toContain(tx.status); continue; }
    expect(tx.status, `${step.id}: ${tx.reason}`).toBe('ready');
    expect({ to: tx.to, data: tx.data }, step.id).toEqual({ to: fc.sent[i]!.to, data: fc.sent[i]!.data });
    i++;
    if (ran.kind === 'call') done.push(step.id); else deployed.set(step.id, ran.address);
  }
  expect(i).toBe(fc.sent.length);
  return { out, sent: fc.sent };
}

const base = { reader: stubReader(), fetchImplementation: fetchFixture, fetchContract: fetchFixture, ...offlineExplorer };

describe('buildStepTransaction equals what executePlanDetailed sends', () => {
  it('DAI (one contract, constructor arg remapped)', async () => {
    const plan = await planClone(await analyseContract(loadVc(ADDR.dai), base), 'base', {}, base);
    const { sent } = await equalsExecutor(plan);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBeNull();
    expect(sent[0]!.data.endsWith((8453).toString(16).padStart(64, '0'))).toBe(true);
  }, 120_000);

  it('USDC: library link, implementation, proxy, admin hand-over and every initialise call step', async () => {
    const txs = normaliseTxList(fx('blockscout-txlist-usdc-asc-1.json'));
    const o = { ...base, fetchEarlyTransactions: async () => ({ txs, source: 'blockscout' as const }) };
    const plan = await planClone(await analyseContract(loadVc(ADDR.usdcProxy), o), 'base-sepolia', {
      newMasterMinter: 'deployer', newPauser: 'deployer', newBlacklister: 'deployer', newOwner: 'deployer', newAdmin: '0x000000000000000000000000000000000000dEaD',
      newName: 'USD Coin', lostAndFound: 'deployer', accountsToBlacklist: '[]', newSymbol: 'USDC',
    }, o);
    const { out, sent } = await equalsExecutor(plan);
    expect(out.skipped).toEqual([]);
    expect(out.results.map((r) => r.stepId)).toEqual(plan.steps.map((s) => s.id));
    expect(sent.filter((t) => t.to).map((t) => t.data.slice(0, 10)).slice(0, 3)).toEqual(['0x8f283970', '0x3357162b', '0xd608ea64']);
    expect(sent[1]!.data).toContain(out.addresses['lib:SignatureChecker']!.slice(2).toLowerCase());
    expect(sent[2]!.data.endsWith(out.addresses['implementation']!.slice(2).toLowerCase())).toBe(true);
  }, 180_000);

  it('Transparent proxy with constructor _data (re-encoded with the deployer ref)', async () => {
    const PROXY = '0x131c370234975811BE7F62Fb65888F6Cc524DEA2' as Address;
    const f = async (c: number, a: Address) => normaliseBlockscout(fx(a === PROXY ? 'blockscout-tup-cryptoart-1.json' : 'blockscout-cryptoart-impl-1.json'), c, a);
    const o = { reader: stubReader(), fetchImplementation: f, fetchContract: f, ...offlineExplorer };
    const plan = await planClone(await analyseContract(await f(1, PROXY), o), 'arbitrum', { initialOwner: 'deployer', _owner: 'deployer', _authoritySigner: '0x00000000000000000000000000000000000000A1', _cryptoartNFT: '0x00000000000000000000000000000000000000A2', _cryptoartVault: '0x00000000000000000000000000000000000000A3' }, o);
    const { sent } = await equalsExecutor(plan);
    expect(sent[1]!.data.toLowerCase()).toContain(DEPLOYER.slice(2));
    expect(sent[1]!.data).toContain('f8c8765e');
  }, 180_000);

  it('beacon proxy and EIP-1167 minimal proxy', async () => {
    const files: Record<string, string> = {
      '0x377f6953151BE60f7e49B7b84313cf2827B0F9A0': 'sourcify-beaconproxy-1.json', '0xc9a4e953d67aBFE6611726d1a70673f10B92A745': 'sourcify-beacon-1.json',
      '0x3Aeb42653455B749aa6807Bcc57B9999052010ea': 'sourcify-beacon-impl-collateral-1.json', '0xd54895B1121A2eE3f37b502F507631FA1331BED6': 'sourcify-zodiac-delay-impl-1.json',
    };
    const load = async (c: number, a: Address) => normaliseSourcify(fx(files[a]!), c, a);
    const word = (a: string) => `0x${'0'.repeat(24)}${a.slice(2).toLowerCase()}` as Hex;
    const reader = { ...stubReader(), getStorageAt: async (_a: Address, slot: Hex) => (slot === BEACON_SLOT ? word('0xc9a4e953d67aBFE6611726d1a70673f10B92A745') : (`0x${'0'.repeat(64)}` as Hex)), call: async (_t: Address, d: Hex) => (d === SEL_BEACON_IMPLEMENTATION ? word('0x3Aeb42653455B749aa6807Bcc57B9999052010ea') : undefined) };
    const o = { reader, fetchImplementation: load, fetchContract: load, ...offlineExplorer };
    const bplan = await planClone(await analyseContract(await load(1, '0x377f6953151BE60f7e49B7b84313cf2827B0F9A0'), o), 'base', { _owner: 'deployer', _admin: 'deployer' }, o);
    const b = await equalsExecutor(bplan);
    expect(b.out.results.map((r) => r.stepId)).toEqual(['implementation', 'beacon', 'proxy']);

    const clone = '0xc203C3184D2D38A66bb52C1B08d587AAaD555600' as Address;
    const code = `0x363d3d373d3d3d363d73${'d54895B1121A2eE3f37b502F507631FA1331BED6'.toLowerCase()}5af43d82803e903d91602b57fd5bf3` as Hex;
    const mo = { ...o, reader: { ...stubReader(), getCode: async (a: Address) => (a === clone ? code : ('0x6080' as Hex)) } };
    const mplan = await planClone((await analyseMinimalProxy(clone, 'eth', mo))!, 'base', { initParams: '0x' }, mo);
    const m = await equalsExecutor(mplan);
    expect(m.sent[1]!.to).toBeNull();
    expect(m.sent[1]!.data.startsWith('0x3d602d80600a3d3981f3363d3d373d3d3d363d73')).toBe(true);
  }, 240_000);
});

describe('buildStepTransaction statuses', () => {
  it('reports waiting / skipped / ready for dependent steps without a signer', async () => {
    const txs = normaliseTxList(fx('blockscout-txlist-usdc-asc-1.json'));
    const o = { ...base, fetchEarlyTransactions: async () => ({ txs, source: 'blockscout' as const }) };
    const plan = await planClone(await analyseContract(loadVc(ADDR.usdcProxy), o), 'base-sepolia', { newMasterMinter: 'deployer', newPauser: 'deployer', newBlacklister: 'deployer', newOwner: 'deployer', newAdmin: '0x000000000000000000000000000000000000dEaD' }, o);
    const lib = '0x00000000000000000000000000000000000000a1' as Address;
    expect(await buildStepTransaction(plan, 'implementation', { deployed: {}, deployer: DEPLOYER })).toMatchObject({ status: 'waiting', waitingFor: ['lib:SignatureChecker'] });
    expect(await buildStepTransaction(plan, 'implementation', { deployed: { 'lib:SignatureChecker': lib }, deployer: DEPLOYER })).toMatchObject({ status: 'ready', to: null });
    expect(await buildStepTransaction(plan, 'init:initialize', { deployed: { proxy: lib }, deployer: DEPLOYER })).toMatchObject({ status: 'waiting', waitingFor: ['admin:changeAdmin'] });
    const ready = await buildStepTransaction(plan, 'init:initialize', { deployed: { proxy: lib }, completed: ['admin:changeAdmin'], deployer: DEPLOYER });
    expect(ready).toMatchObject({ status: 'ready', to: lib });
    expect(ready.data!.slice(0, 10)).toBe('0x3357162b');
    expect(await buildStepTransaction(plan, 'init:initializeV2', { deployed: { proxy: lib }, completed: ['admin:changeAdmin', 'init:initialize'], deployer: DEPLOYER })).toMatchObject({ status: 'skipped', reason: expect.stringMatching(/optional, needs input: newName/) });
    expect(await buildStepTransaction(plan, 'init:initializeV2_1', { deployed: { proxy: lib }, completed: [], skipped: ['init:initializeV2'], deployer: DEPLOYER })).toMatchObject({ status: 'skipped', reason: expect.stringMatching(/depends on init:initializeV2/) });
    expect(await buildStepTransaction(plan, 'init:initialize', { deployed: { proxy: lib }, completed: ['admin:changeAdmin'] })).toMatchObject({ status: 'waiting', waitingFor: ['deployer'] });
    expect(await buildStepTransaction(plan, 'nope', { deployed: {} })).toMatchObject({ status: 'unsupported' });
  }, 120_000);

  it('refuses code the target chain cannot run (same refusal as the executor)', async () => {
    const src = 'pragma solidity ^0.8.24; contract T { function h() public view returns (bytes32 r) { assembly { r := blobhash(0) } } }';
    const std: StdJsonInput = { language: 'Solidity', sources: { 'T.sol': { content: src } }, settings: { evmVersion: 'cancun', optimizer: { enabled: false, runs: 200 } } };
    const plan = {
      from: { chainId: 1, address: ADDR.dai }, to: { chainId: 137 },
      steps: [{ id: 'contract', kind: 'contract', label: 'Deploy T', name: 'T', sourceAddress: ADDR.dai, contractKey: 'contract', args: [], links: {}, dependsOn: [] }],
      contracts: { contract: { name: 'T', fullyQualifiedName: 'T.sol:T', sourceAddress: ADDR.dai, compilerVersion: '0.8.28+commit.7893614a', evmVersion: 'cancun', evmVersionOriginal: 'cancun', stdJsonInput: std, sourceEdits: [], expectedMatch: true, abi: [], originalConstructorArgs: null } },
      warnings: [], unsupported: [], needsInput: [], overridesApplied: [], license: { id: null, class: 'none-or-unknown' },
    } as unknown as ClonePlan;
    const polygon = { ...getChain('polygon'), latestHardfork: 'osaka', opcodes: { BLOBHASH: false } };
    const tx = await buildStepTransaction(plan, 'contract', { deployed: {}, chain: polygon });
    expect(tx).toMatchObject({ status: 'unsupported', errorCode: 'COMPILE', reason: expect.stringMatching(/BLOBHASH/) });
    const fc = fakeChain();
    await expect(executePlanDetailed(plan, { chain: polygon, pub: fc.pub, wallet: fc.wallet })).rejects.toThrow(CmcError);
    expect(fc.sent).toEqual([]);
  }, 120_000);
});
