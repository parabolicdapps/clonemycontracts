import { describe, expect, it } from 'vitest';
import { classifyStandard } from '../src/spec/standard.js';
import { buildDesign } from '../src/targets/cosmwasm/design.js';
import { genContract, genError, genMsg, genState, genHelpers, errorVariants, genHandler, handlerSignature } from '../src/targets/cosmwasm/codegen.js';
import { assembleProject } from '../src/targets/cosmwasm/project.js';
import { buildCw20Plan, buildProgramPlan, cw20InstantiateMsg, serdeSnake, wireValue, type RunnerResult } from '../src/targets/cosmwasm/adapter.js';
import { compareResults, sameValue, addressNamer, normWire } from '../src/targets/cosmwasm/compare.js';
import { cw20Info, buildTemplateDesign, recipeFiles } from '../src/targets/cosmwasm/template.js';
import { failingHandlers, firstErrorBlocks, handlerPrompt, hintsFor, sourceLookup, SYSTEM } from '../src/targets/cosmwasm/prompts.js';
import { typeMap } from '../src/targets/cosmwasm/names.js';
import { generateScenarios } from '../src/scenario/generate.js';
import type { ScenarioSet } from '../src/types.js';
import { load } from './helpers.js';

const T0 = 1_700_000_000;
const mini = (over: Partial<ScenarioSet['scenarios'][number]>): ScenarioSet => ({ version: 1, contract: 'X', t0: T0, actors: ['deployer', 'alice', 'bob'], tokens: [], scenarios: [{ id: 's1', title: 't', kind: 'function', deploy: { actor: 'deployer', args: [], at: -20 }, steps: [], source: 'template', ...over }] });

describe('cosmwasm names and types', () => {
  it('serde snake_case of variants matches the derive', () => { expect(serdeSnake('SetUnlock')).toBe('set_unlock'); expect(serdeSnake('TxCount')).toBe('tx_count'); expect(serdeSnake('Deposit')).toBe('deposit'); });
  it('integer policy: widths kept up to 32, u64/Uint64, Uint128, Uint256; keys narrowed to u64', () => {
    expect(typeMap({ solidity: 'uint8', kind: 'uint', bits: 8 }).handler).toBe('u8');
    expect(typeMap({ solidity: 'uint64', kind: 'uint', bits: 64 })).toMatchObject({ handler: 'u64', msg: 'Uint64' });
    expect(typeMap({ solidity: 'uint128', kind: 'uint', bits: 128 }).handler).toBe('Uint128');
    expect(typeMap({ solidity: 'uint256', kind: 'uint', bits: 256 }).handler).toBe('Uint256');
    expect(typeMap({ solidity: 'uint256', kind: 'uint', bits: 256 }, { keyed: true })).toMatchObject({ handler: 'u64', msg: 'Uint64' });
    expect(typeMap({ solidity: 'address', kind: 'address' })).toMatchObject({ handler: 'Addr', msg: 'String' });
  });
});

describe('cosmwasm design (MultiSig2of3)', () => {
  it('handlers, native denom, fixed array and keyed params', async () => {
    const { spec } = await load('MultiSig2of3');
    const d = buildDesign(spec);
    expect(d.instructions.map((h) => h.unit)).toEqual(expect.arrayContaining(['instantiate', 'exec_deposit', 'exec_submit', 'exec_confirm', 'exec_revoke', 'exec_execute', 'query_tx_count', 'query_get_tx']));
    expect(d.native.used).toBe(true);
    const init = d.instructions.find((h) => h.unit === 'instantiate')!;
    expect(init.args.map((a) => a.name)).toEqual(['owners', 'native_denom']);
    expect(init.args[0]!.t).toMatchObject({ kind: 'array', fixed: 3, handler: 'Vec<Addr>' });
    expect(d.instructions.find((h) => h.unit === 'exec_confirm')!.args[0]).toMatchObject({ name: 'tx_id', t: { handler: 'u64', msg: 'Uint64' } });
    const gt = d.instructions.find((h) => h.unit === 'query_get_tx')!;
    expect(gt.returns).toMatchObject({ single: false, struct: 'GetTxResponse' });
    expect(gt.returns!.fields.map((f) => f.name)).toEqual(['to', 'value', 'data', 'executed', 'confirmations']);
    // getters and the array length are written by code, the model is never asked
    expect(d.instructions.find((h) => h.unit === 'query_tx_count')!.generated).toBeTruthy();
    expect(d.instructions.find((h) => h.unit === 'query_is_owner')!.generated).toBeTruthy();
    expect(d.state.find((s) => s.solidity === 'txs')).toMatchObject({ kind: 'array', struct: 'Tx' });
    expect(d.notes.join(' ')).toMatch(/calldata is dropped/);
  });
  it('generated scaffolding: dispatch rejects funds on non-payable messages, checks fixed array length, defaults for missing keys', async () => {
    const { spec } = await load('MultiSig2of3');
    const d = buildDesign(spec);
    const c = genContract(d);
    expect(c).toMatch(/ExecuteMsg::Submit[\s\S]*?cw_utils::nonpayable/);
    expect(c).toMatch(/ExecuteMsg::Deposit \{\} => \{\s*handlers::exec_deposit/);
    expect(c).toContain('owners.len() != 3');
    expect(c).toContain('NATIVE_DENOM.save');
    const st = genState(d);
    expect(st).toContain('may_load(storage, k0)?.unwrap_or_else(|| false)');
    expect(st).toContain('pub fn push_txs');
    expect(st).toContain('impl Default for Tx');
    expect(genMsg(d)).toContain('pub struct GetTxResponse');
    expect(genHelpers(d)).toContain('pub fn bank_send');
    expect(genError(spec)).toContain('#[error("not owner")]');
  });
  it('assembleProject: one file per handler, getters generated, stubs for the rest', async () => {
    const { spec } = await load('MultiSig2of3');
    const d = buildDesign(spec);
    const f = assembleProject(spec, d, { exec_confirm: '    Ok(Response::new())' });
    expect(f['src/handlers/exec_confirm.rs']).toContain('Ok(Response::new())');
    expect(f['src/handlers/exec_submit.rs']).toContain('NotImplemented');
    expect(f['src/handlers/query_tx_count.rs']).toContain('len_txs');
    expect(f['src/lib.rs']).toContain('pub mod handlers;');
    expect(handlerSignature(d.instructions.find((h) => h.unit === 'exec_confirm')!)).toBe('pub fn exec_confirm(deps: DepsMut, env: Env, info: MessageInfo, tx_id: u64) -> Result<Response, ContractError>');
  });
});

describe('cosmwasm design (StakingRewards, tokens)', () => {
  it('token dependencies become Addr state; prompt lists accessors, helpers, events and the difference note', async () => {
    const { c, spec } = await load('StakingRewards');
    const d = buildDesign(spec);
    expect(d.native.used).toBe(false);
    expect(d.tokens.map((t) => t.solidity)).toEqual(['stakingToken', 'rewardToken']);
    expect(d.state.find((s) => s.solidity === 'staked')).toMatchObject({ kind: 'map', value: { handler: 'Uint256' } });
    expect(d.notes.join(' ')).toMatch(/TransferFrom/);
    const stake = d.instructions.find((h) => h.unit === 'exec_stake')!;
    const p = handlerPrompt(spec, d, stake, sourceLookup(c.sources));
    expect(p).toContain('get_staked(storage: &dyn Storage, k0: &Addr)');
    expect(p).toContain('cw20_transfer_from');
    expect(p).toContain('events::staked');
    expect(p).toContain('pub fn exec_stake(deps: DepsMut, env: Env, info: MessageInfo, amount: Uint256)');
    expect(SYSTEM).toContain('Worked example');
  });
});

describe('cosmwasm errors and repair helpers', () => {
  it('error variants from revert messages; hints and blame', async () => {
    const { spec } = await load('MultiSig2of3');
    const { variants } = errorVariants(spec);
    expect(variants.map((v) => v.name)).toEqual(expect.arrayContaining(['NotOwner', 'BadOwner', 'AlreadyExecuted', 'Unauthorized']));
    const d = buildDesign(spec);
    const log = 'error[E0382]: borrow of moved value\n --> src/handlers/exec_submit.rs:9:5\n  |\nerror[E0308]: x\n --> src/state.rs:3:1\n';
    const f = failingHandlers(log, d);
    expect([...f.handlers]).toEqual(['exec_submit']);
    expect(f.other).toBe(true);
    expect(hintsFor(log).join(' ')).toMatch(/E0382 use after move/);
    expect(firstErrorBlocks(log, 1)).toContain('E0382');
  });
});

describe('cosmwasm plan building', () => {
  it('program plan: fixtures, deploy with native denom, allowances, execute msg shape, zero address and time', async () => {
    const { spec } = await load('CosmwasmLocker');
    const d = buildDesign(spec);
    const set = mini({
      deploy: { actor: 'deployer', args: [{ token: 'token' }, { time: 100 }], at: -20 },
      steps: [
        { type: 'call', actor: 'alice', fn: 'deposit', args: ['1000000000000000000'], at: 5 },
        { type: 'call', actor: 'deployer', fn: 'sweep', args: [{ zero: true }], at: 6 },
        { type: 'call', actor: 'alice', fn: 'tip', args: [], at: 7, valueWei: '1000' },
        { type: 'view', fn: 'deposits', args: [{ actor: 'alice' }], at: 8, label: 'deposits(alice)' },
        { type: 'view', fn: 'tokenBalance', args: [{ token: 'token' }, 'contract'], at: 8, label: 'bal' },
      ],
    });
    set.tokens = [{ name: 'token', decimals: 18, fundings: [{ actor: 'alice', amount: '5' }], approveContract: true }];
    const b = buildProgramPlan({ spec, design: d, set });
    const steps = b.plan.scenarios[0]!.steps as any[];
    expect(steps[0]).toMatchObject({ op: 'instantiate', code: 'cw20-base', name: 'token' });
    const dep = steps.find((s) => s.id === 'deploy');
    expect(dep.msg).toEqual({ token: 'name:token', unlock_at: String(T0 + 100), native_denom: 'untrn' });
    expect(steps.some((s) => s.id === 'allow_token_alice' && s.msg.increase_allowance.spender === 'app')).toBe(true);
    expect(steps.find((s) => s.id === 'step0')).toMatchObject({ op: 'execute', contract: 'app', sender: 'actor:alice', msg: { deposit: { amount: '1000000000000000000' } } });
    expect(steps.find((s) => s.id === 'step1').msg).toEqual({ sweep: { to: '' } });
    expect(steps.find((s) => s.id === 'step2')).toMatchObject({ funds: [{ denom: 'untrn', amount: '1000' }], msg: { tip: {} } });
    expect(steps.find((s) => s.id === 'view3').msg).toEqual({ deposits: { key: 'actor:alice' } });
    expect(steps.find((s) => s.id === 'view4')).toMatchObject({ contract: 'name:token', msg: { balance: { address: 'app' } } });
    expect(steps.filter((s) => s.op === 'warp').map((s) => s.unix_timestamp)).toContain(T0 + 5);
  });
  it('values that do not fit the wire type are not runnable, never silently narrowed', () => {
    const set = mini({});
    expect(() => wireValue('18446744073709551616', typeMap({ solidity: 'uint64', kind: 'uint', bits: 64 }), set)).toThrow(/does not fit/);
    expect(wireValue('7', typeMap({ solidity: 'uint8', kind: 'uint', bits: 8 }), set)).toBe(7);
    expect(wireValue({ hex: '0x0102' }, typeMap({ solidity: 'bytes', kind: 'bytes' }), set)).toBe('AQI=');
  });
});

describe('cosmwasm comparison', () => {
  it('maps addresses back to neutral names, compares success/revert and values, documents the zero address', async () => {
    const { spec } = await load('CosmwasmLocker');
    const d = buildDesign(spec);
    const set = mini({
      deploy: { actor: 'deployer', args: [{ token: 'token' }, { time: 100 }], at: -20, expect: { status: 'success' } },
      steps: [
        { type: 'call', actor: 'deployer', fn: 'setUnlock', args: ['5'], at: 1, expect: { status: 'success' } },
        { type: 'view', fn: 'admin', args: [], at: 3, label: 'admin', expect: 'actor:deployer' },
        { type: 'view', fn: 'total', args: [], at: 3, label: 'total', expect: '7' },
        { type: 'call', actor: 'deployer', fn: 'sweep', args: [{ zero: true }], at: 4, expect: { status: 'success' } },
      ],
    });
    set.tokens = [{ name: 'token', decimals: 18, fundings: [], approveContract: false }];
    const built = buildProgramPlan({ spec, design: d, set });
    const idx = (id: string) => built.plan.scenarios[0]!.steps.findIndex((s: any) => s.id === id);
    const res: RunnerResult = { runner: 't', scenarios: [{ id: 's1', fatal: null, addresses: { 'actor:deployer': 'cosmwasm1dep', app: 'cosmwasm1app' }, steps: built.plan.scenarios[0]!.steps.map((s: any, i) => ({ index: i, op: s.op, id: s.id, ok: true })) }] };
    res.scenarios[0]!.steps[idx('step3')]!.ok = false; res.scenarios[0]!.steps[idx('step3')]!.error = 'Invalid input';
    res.scenarios[0]!.steps[idx('view1')]!.data = 'cosmwasm1dep';
    res.scenarios[0]!.steps[idx('view2')]!.data = '8';
    const out = compareResults(set, built, res, d)[0]!;
    expect(out.status).toBe('failed'); // total 7 vs 8 is a real mismatch
    expect(out.mismatches.map((m) => [m.what, !!m.documented])).toEqual([['total', false], ['sweep({"zero":true}) by deployer', true]]);
    expect(out.checked).toBe(3);
    res.scenarios[0]!.steps[idx('view2')]!.data = '7';
    expect(compareResults(set, built, res, d)[0]!.status).toBe('documented-difference');
  });
  it('value comparison and normalisation', () => {
    expect(sameValue('10', '10')).toBe(true); expect(sameValue(['1', true], ['1', true])).toBe(true); expect(sameValue('1', '2')).toBe(false); expect(sameValue(1, '1')).toBe(true); expect(sameValue(['x', 2], ['x', '2'])).toBe(true);
    const name = addressNamer({ 'actor:alice': 'cosmwasm1a', app: 'cosmwasm1app', 'name:tok': 'cosmwasm1t' });
    expect(name('cosmwasm1a')).toBe('actor:alice'); expect(name('')).toBe('zero'); expect(name('cosmwasm1app')).toBe('contract'); expect(name('cosmwasm1t')).toBe('token:tok');
    expect(normWire(7, typeMap({ solidity: 'uint8', kind: 'uint', bits: 8 }), name)).toBe('7');
    expect(normWire('AQI=', typeMap({ solidity: 'bytes', kind: 'bytes' }), name)).toBe('0x0102');
  });
});

describe('cosmwasm template path (cw20-base)', () => {
  it('plain ERC-20 maps to a cw20-base instantiate message and a plan with allowance deltas', async () => {
    const { spec } = await load('ERC20Token');
    const v = classifyStandard(spec).match!;
    const info = cw20Info(spec, v);
    expect(info).toMatchObject({ nameParam: 0, symbolParam: 1, supplyParam: 2, decimals: 18, mintable: true, ownable: true });
    const msg = cw20InstantiateMsg(info, ['Test Token', 'TST', '1000'], 'deployer');
    expect(msg).toEqual({ name: 'Test Token', symbol: 'TST', decimals: 18, initial_balances: [{ address: 'actor:deployer', amount: '1000' }], mint: { minter: 'actor:deployer', cap: null } });
    expect(() => cw20InstantiateMsg(info, ['Test Token', 'T1', '1000'], 'deployer')).toThrow(/symbol/);
    const d = buildTemplateDesign(spec, v, info);
    expect(d.mode).toBe('template');
    const files = recipeFiles(spec, v, d, info);
    expect(JSON.parse(files['cw20/instantiate.json']!).mint.minter).toBe('<DEPLOYER_ADDRESS>');
    expect(files['deploy-testnet.sh']).toContain('tx wasm store');
    const set = mini({
      deploy: { actor: 'deployer', args: ['Test Token', 'TST', '1000'], at: -20 },
      steps: [
        { type: 'call', actor: 'alice', fn: 'approve', args: [{ actor: 'bob' }, '50'], at: 1 },
        { type: 'call', actor: 'alice', fn: 'approve', args: [{ actor: 'bob' }, '20'], at: 2 },
        { type: 'call', actor: 'bob', fn: 'transferFrom', args: [{ actor: 'alice' }, { actor: 'bob' }, '5'], at: 3 },
        { type: 'view', fn: 'balanceOf', args: [{ actor: 'alice' }], at: 4, label: 'b' },
      ],
    });
    const b = buildCw20Plan({ spec, design: d, set }, info);
    const steps = b.plan.scenarios[0]!.steps as any[];
    expect(steps.find((s) => s.id === 'step0').msg).toEqual({ increase_allowance: { spender: 'actor:bob', amount: '50' } });
    expect(steps.find((s) => s.id === 'step1').msg).toEqual({ decrease_allowance: { spender: 'actor:bob', amount: '30' } });
    expect(steps.find((s) => s.id === 'step2').msg.transfer_from).toMatchObject({ owner: 'actor:alice', recipient: 'actor:bob', amount: '5' });
  });
  it('classifier verdicts unchanged: only the plain token takes the template path', async () => {
    for (const n of ['StakingRewards', 'LinearVesting', 'MultiSig2of3', 'ERC721Mint', 'CosmwasmLocker']) expect(classifyStandard((await load(n)).spec).match, n).toBeNull();
  });
});

describe('cosmwasm scenarios generation still works on the Locker fixture (needs anvil)', () => {
  it.skip('placeholder to keep generateScenarios imported', () => { void generateScenarios; void genHandler; });
});
