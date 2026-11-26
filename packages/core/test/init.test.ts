import { describe, expect, it } from 'vitest';
import { analyseContract } from '../src/analyse/index.js';
import { normaliseTxList } from '../src/fetch/history.js';
import { planClone } from '../src/plan/index.js';
import { resolveArgs, unresolvedCall } from '../src/deploy/execute.js';
import type { Address } from '../src/types.js';
import { ADDR, fetchFixture, fx, loadVc, offlineExplorer, stubReader } from './helpers.js';
import { normaliseBlockscout } from '../src/fetch/blockscout.js';

const usdcTxs = normaliseTxList(fx('blockscout-txlist-usdc-asc-1.json'));
const withHistory = { fetchEarlyTransactions: async () => ({ txs: usdcTxs, source: 'blockscout' as const }), fetchCreationTxHash: async () => null };
const opts = { reader: stubReader(), fetchImplementation: fetchFixture, fetchContract: fetchFixture, ...withHistory };

describe('proxy initialisation: USDC (initialised by separate transactions)', () => {
  it('discovers changeAdmin and initialize from the proxy early transactions', async () => {
    const a = await analyseContract(loadVc(ADDR.usdcProxy), opts);
    expect(a.initialisation!.discovery).toMatchObject({ source: 'blockscout' });
    expect(a.initialisation!.discovered.map((d) => d.function)).toEqual(['initialize']);
    expect(a.initialisation!.discoveredAdminCalls.map((d) => d.function)).toEqual(['changeAdmin']);
    expect(a.initialisation!.ifAdminProxy).toBe(true);
    const init = a.initialisation!.discovered[0]!;
    expect(init.args.map((x) => x.name)).toEqual(['tokenName', 'tokenSymbol', 'tokenCurrency', 'tokenDecimals', 'newMasterMinter', 'newPauser', 'newBlacklister', 'newOwner']);
    expect(init.args[1]!.value).toBe('USDC');
    expect(a.initialisation!.abiInitialisers.map((i) => i.function)).toEqual(['initialize', 'initializeV2', 'initializeV2_1', 'initializeV2_2']);
    expect(a.initialisation!.implementationProtected).toBe(false);
  });

  it('suggests the deploying account only for role holders that are plain accounts on the source chain', async () => {
    const eoas = ['0x1500A138523709cE66C8B9aBe678aBc1b6C5A7b7', '0xe8e13e1B6d363C270eF3A5AB466eBAd8326311bb', '0xa61E278899a8553d93D14eb19bA2791e05069e87'];
    const o = { ...opts, reader: stubReader(eoas) };
    const p = await planClone(await analyseContract(loadVc(ADDR.usdcProxy), o), 'base-sepolia', {}, o);
    const init = p.steps.find((s) => s.id === 'init:initialize')!;
    for (const n of ['newMasterMinter', 'newPauser', 'newOwner']) expect(init.args.find((x) => x.name === n)).toMatchObject({ action: 'needs-input', suggestion: { $ref: 'deployer' } });
    // the blacklister has code on the source chain: a dependency, not an account
    expect(init.args.find((x) => x.name === 'newBlacklister')!.suggestion).toBeUndefined();
  });

  it('plans admin hand-over, then the discovered initialiser (owner/admin/role needs-input), then optional later versions', async () => {
    const p = await planClone(await analyseContract(loadVc(ADDR.usdcProxy), opts), 'base-sepolia', {}, opts);
    expect(p.planVersion).toBe(2);
    expect(p.steps.map((s) => s.id)).toEqual(['lib:SignatureChecker', 'implementation', 'proxy', 'admin:changeAdmin', 'init:initialize', 'init:initializeV2', 'init:initializeV2_1', 'init:initializeV2_2']);
    expect(p.steps.every((s) => typeof s.label === 'string' && s.label.length > 0)).toBe(true);
    const init = p.steps.find((s) => s.id === 'init:initialize')!;
    expect(init).toMatchObject({ kind: 'initialise', call: { target: 'proxy', function: 'initialize', discovered: true, optional: false } });
    // never silently copy the original owner / roles
    // (the stub chain says every address has code, so these are contract dependencies: never an account of the deployer)
    for (const n of ['newMasterMinter', 'newPauser', 'newBlacklister', 'newOwner']) {
      const arg = init.args.find((x) => x.name === n)!;
      expect(arg).toMatchObject({ action: 'needs-input', value: null });
      expect(arg.suggestion).toBeUndefined();
      expect(arg.note).toMatch(/^protocol contract on the source chain: unverified .* supply its address on the target chain or clone it first/);
      expect(arg.original).toMatch(/^0x/);
    }
    expect(init.args.find((x) => x.name === 'tokenSymbol')).toMatchObject({ action: 'keep', value: 'USDC' });
    expect(p.steps.find((s) => s.id === 'admin:changeAdmin')!.args[0]).toMatchObject({ action: 'needs-input', value: null });
    expect(p.steps.find((s) => s.id === 'init:initializeV2')!.call).toMatchObject({ discovered: false, optional: true });
    expect(p.needsInput).toEqual(expect.arrayContaining(['init:initialize.newOwner', 'admin:changeAdmin.newAdmin']));
    expect(p.needsInput.some((n) => n.startsWith('init:initializeV2'))).toBe(false); // optional steps do not block
    expect(p.initialisation).toMatchObject({ mode: 'separate-transactions', frontRunnable: true });
    expect(p.warnings.join('\n')).toMatch(/Front-running risk/);
    expect(p.warnings.join('\n')).toMatch(/implementation .*can be initialised directly/);
    expect(JSON.parse(JSON.stringify(p))).toEqual(p);
  });

  it('--set fills the arguments (deployer keyword, by name or stepId.name) and the call step becomes runnable', async () => {
    const a = await analyseContract(loadVc(ADDR.usdcProxy), opts);
    const p = await planClone(a, 'base-sepolia', {
      newMasterMinter: 'deployer', newPauser: 'deployer', newBlacklister: 'deployer', 'init:initialize.newOwner': '0x00000000000000000000000000000000000000A1',
      newAdmin: '0x00000000000000000000000000000000000000B2', newName: 'USD Coin',
    }, opts);
    expect(p.needsInput).toEqual([]);
    const init = p.steps.find((s) => s.id === 'init:initialize')!;
    expect(unresolvedCall(init)).toBeNull();
    const deployed = new Map<string, Address>([['proxy', '0x00000000000000000000000000000000000000C3']]);
    const deployer = '0x00000000000000000000000000000000000000D4' as Address;
    const vals = resolveArgs(init, deployed, false, deployer);
    expect(vals[4]).toBe(deployer);
    expect(vals[7]).toBe('0x00000000000000000000000000000000000000A1');
    expect(unresolvedCall(p.steps.find((s) => s.id === 'init:initializeV2')!)).toBeNull();
    expect(unresolvedCall(p.steps.find((s) => s.id === 'init:initializeV2_1')!)).toMatch(/lostAndFound/);
    await expect(planClone(a, 'base-sepolia', { newOwnerX: '1' }, opts)).rejects.toThrow(/no constructor argument or initialiser argument/);
  });

  it('without explorer history: ABI-detected, base initialiser required (nothing invented), later versions optional and chained', async () => {
    const a = await analyseContract(loadVc(ADDR.usdcProxy), { ...opts, ...offlineExplorer });
    const p = await planClone(a, 'base-sepolia', {}, { ...opts, ...offlineExplorer });
    const calls = p.steps.filter((s) => s.kind === 'initialise');
    expect(calls.map((s) => s.name)).toEqual(['initialize', 'initializeV2', 'initializeV2_1', 'initializeV2_2']);
    expect(calls.map((s) => s.call!.optional)).toEqual([false, true, true, true]);
    expect(calls.every((s) => !s.call!.discovered && s.args.every((x) => x.value === null && x.action === 'needs-input'))).toBe(true);
    // ABI parameter names are the --set names in both modes
    expect(calls[0]!.args.map((x) => x.name)).toEqual(['tokenName', 'tokenSymbol', 'tokenCurrency', 'tokenDecimals', 'newMasterMinter', 'newPauser', 'newBlacklister', 'newOwner']);
    // a later initialiser depends on the one before it and on the admin hand-over
    expect(calls[1]!.dependsOn).toEqual(expect.arrayContaining(['init:initialize']));
    expect(calls[0]!.dependsOn).toEqual(expect.arrayContaining(['admin:changeAdmin']));
    expect(p.needsInput).toEqual(expect.arrayContaining(['admin:changeAdmin.newAdmin', 'init:initialize.tokenName', 'init:initialize.newOwner']));
    expect(p.initialisation!.notes.join(' ')).toMatch(/initialiser history: none/);
  });

  it('keeps the admin hand-over whatever history says; unknown --set keys are an error listing the valid names', async () => {
    const a = await analyseContract(loadVc(ADDR.usdcProxy), { ...opts, ...offlineExplorer });
    expect(a.initialisation!.ifAdminProxy).toBe(true);
    await expect(planClone(a, 'base-sepolia', { newMasterMiner: 'deployer' }, { ...opts, ...offlineExplorer })).rejects.toThrow(/names: .*init:initialize\.newMasterMinter/);
  });
});

describe('proxy initialisation: constructor _data (Transparent proxy, Blockscout fixtures)', () => {
  const PROXY = '0x131c370234975811BE7F62Fb65888F6Cc524DEA2' as Address;
  const IMPL = '0x9C19BF5a5d43A2E4582e1Abf77bC7E86849C8Ff1' as Address;
  const fetchImpl = async (chainId: number, a: Address) => normaliseBlockscout(fx(a === PROXY ? 'blockscout-tup-cryptoart-1.json' : 'blockscout-cryptoart-impl-1.json'), chainId, a);
  const o = { reader: stubReader(), fetchImplementation: fetchImpl, fetchContract: fetchImpl, ...offlineExplorer };

  it('decodes _data against the implementation ABI as a call with remappable arguments', async () => {
    const a = await analyseContract(await fetchImpl(1, PROXY), o);
    expect(a.proxy.implementations[0]).toBe(IMPL);
    expect(a.initialisation!.constructorCall).toMatchObject({ function: 'initialize', argName: '_data', target: 'implementation' });
    const p = await planClone(a, 'arbitrum', {}, o);
    expect(p.initialisation).toMatchObject({ mode: 'constructor-data', frontRunnable: false });
    expect(p.steps.filter((s) => s.kind === 'initialise')).toHaveLength(0);
    const proxy = p.steps.find((s) => s.id === 'proxy')!;
    const data = proxy.args.find((x) => x.name === '_data')!;
    expect(data.call!.signature).toBe('initialize(address,address,address,address)');
    expect(data.call!.args).toHaveLength(4);
    expect(data.call!.args.every((x) => x.type === 'address' && x.addresses.length === 1)).toBe(true);
    expect(data.action).toBe('needs-input');
    expect(p.needsInput.some((n) => n.startsWith('proxy.') || n.startsWith('implementation.'))).toBe(true);
  });

  it('inner arguments are set with proxy._data.<name> / _data.<name> / <name>', async () => {
    const a = await analyseContract(await fetchImpl(1, PROXY), o);
    const names = (await planClone(a, 'arbitrum', {}, o)).steps.find((s) => s.id === 'proxy')!.args.find((x) => x.name === '_data')!.call!.args.map((x) => x.name);
    const overrides: Record<string, string> = { initialOwner: '0x00000000000000000000000000000000000000E5' };
    names.forEach((n, i) => { overrides[i === 0 ? `_data.${n}` : i === 1 ? `proxy._data.${n}` : n] = i === 2 ? 'deployer' : `0x${String(i + 1).padStart(40, '0')}`; });
    const p = await planClone(a, 'arbitrum', overrides, o);
    const data = p.steps.find((s) => s.id === 'proxy')!.args.find((x) => x.name === '_data')!;
    expect(data.call!.args.map((x) => x.action)).toEqual(['keep', 'keep', 'keep', 'keep']);
    expect(data.value).toBeNull(); // contains the deployer ref: encoded at deploy time
    const deployer = '0x00000000000000000000000000000000000000D4' as Address;
    const vals = resolveArgs(p.steps.find((s) => s.id === 'proxy')!, new Map<string, Address>([['implementation', IMPL]]), false, deployer);
    const enc = vals[2] as string;
    expect(enc.startsWith(data.call!.selector)).toBe(true);
    expect(enc.toLowerCase()).toContain(deployer.slice(2).toLowerCase());
  });
});

describe('implementation protection heuristics', () => {
  it('flags an unprotected initializer and accepts _disableInitializers()', async () => {
    const { implementationLooksProtected } = await import('../src/analyse/init.js');
    const vc = loadVc(ADDR.usdcImpl);
    expect(implementationLooksProtected(vc)).toBe(false);
    const edited = structuredClone(vc);
    const [k] = Object.keys(edited.stdJsonInput.sources);
    edited.stdJsonInput.sources[k!]!.content += '\ncontract X { constructor() { _disableInitializers(); } }';
    expect(implementationLooksProtected(edited)).toBe(true);
  });
});

