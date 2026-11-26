import { describe, expect, it } from 'vitest';
import { buildDesign } from '../src/targets/tezos/design.js';
import { buildProgramPlan, buildTokenPlan, pval, tokenOriginateArgs, type RunnerResult } from '../src/targets/tezos/adapter.js';
import { addressNamer, compareResults, normValue, parseSpValue, sameValue, widthDifference } from '../src/targets/tezos/compare.js';
import { erc20Info } from '../src/targets/tezos/template.js';
import { classifyStandard } from '../src/spec/standard.js';
import { typeMap } from '../src/targets/tezos/names.js';
import type { ScenarioSet } from '../src/types.js';
import { load } from './helpers.js';

const T0 = 1_700_000_000;
const ZERO = 'tz1Ke2h7sDdakHJQh8WX4Z372du1KChsksyU';
const mini = (over: Partial<ScenarioSet['scenarios'][number]>, tokens: ScenarioSet['tokens'] = []): ScenarioSet => ({ version: 1, contract: 'X', t0: T0, actors: ['deployer', 'alice', 'bob'], tokens, scenarios: [{ id: 's1', title: 't', kind: 'function', deploy: { actor: 'deployer', args: [], at: -20 }, steps: [], source: 'template', ...over }] });

describe('parsing what SmartPy prints', () => {
  it('scalars, records, tuples, lists, options, addresses', () => {
    expect(parseSpValue('12')).toBe('12');
    expect(parseSpValue('-3')).toBe('-3');
    expect(parseSpValue('True')).toBe(true);
    expect(parseSpValue("'hi there'")).toBe('hi there');
    expect(parseSpValue("sp.address('tz1abc')")).toBe('tz1abc');
    expect(parseSpValue('sp.timestamp(5)')).toBe('5');
    expect(parseSpValue('sp.mutez(7)')).toBe('7');
    expect(parseSpValue("sp.bytes('0xab')")).toBe('0xab');
    expect(parseSpValue('sp.Some(3)')).toBe('3');
    expect(parseSpValue('None')).toBeNull();
    expect(parseSpValue("(1, 'x')")).toEqual(['1', 'x']);
    expect(parseSpValue('[1, 2, 3]')).toEqual(['1', '2', '3']);
    expect(parseSpValue("sp.record(ad = sp.address('tz1gW'), b = True, by = sp.bytes('0xab'), l = [1, 2], n = 1, o = sp.Some(3), s = 'hi', tup = (1, 'x'))")).toEqual({ ad: 'tz1gW', b: true, by: '0xab', l: ['1', '2'], n: '1', o: '3', s: 'hi', tup: ['1', 'x'] });
    expect(parseSpValue("{sp.address('tz1x') : 12}")).toEqual({ tz1x: '12' });
  });
  it('normalises by type; address names; integer comparison by value', () => {
    const name = addressNamer({ 'actor:alice': "sp.address('tz1A')", 'contract:app': "sp.address('KT1app')", 'contract:token_t': "sp.address('KT1tok')" }, ZERO);
    expect(normValue('tz1A', typeMap({ solidity: 'address', kind: 'address' }), name)).toBe('actor:alice');
    expect(normValue('KT1app', typeMap({ solidity: 'address', kind: 'address' }), name)).toBe('contract');
    expect(normValue('KT1tok', typeMap({ solidity: 'address', kind: 'address' }), name)).toBe('token:t');
    expect(normValue(ZERO, typeMap({ solidity: 'address', kind: 'address' }), name)).toBe('zero');
    expect(normValue('0xAB', typeMap({ solidity: 'bytes', kind: 'bytes' }), name)).toBe('0xab');
    expect(sameValue(1, '1')).toBe(true);
    expect(sameValue('0xAB', '0xab')).toBe(true);
    expect(sameValue(['1', '2'], ['1', '3'])).toBe(false);
  });
});

describe('plan building (CosmwasmLocker)', () => {
  it('deploys with initialize, mock token fixtures with funding and approval, calls with sender/now/amount, views by kind', async () => {
    const { spec } = await load('CosmwasmLocker');
    const d = buildDesign(spec);
    const set = mini({
      deploy: { actor: 'deployer', args: [{ token: 'token' }, { time: 1000 }], at: -20 },
      steps: [
        { type: 'call', actor: 'alice', fn: 'deposit', args: ['5000'], at: 0, expect: { status: 'success' } },
        { type: 'call', actor: 'alice', fn: 'tip', args: [], valueWei: '1000', at: 1, expect: { status: 'success' } },
        { type: 'view', fn: 'deposits', args: [{ actor: 'alice' }], at: 2, label: 'deposits(alice)' },
        { type: 'view', fn: 'unlocked', args: [], at: 3, label: 'unlocked' },
        { type: 'view', fn: 'tokenBalance', args: [{ token: 'token' }, 'contract'], at: 4, label: 'token.balanceOf(contract)' },
      ],
    }, [{ name: 'token', decimals: 18, fundings: [{ actor: 'alice', amount: '10000' }], approveContract: true }]);
    const b = buildProgramPlan({ spec, design: d, set });
    const steps = b.plan.scenarios[0]!.steps as any[];
    expect(steps[0]).toMatchObject({ op: 'originate', id: 'token_token', module: 'cmc_mock_token', modname: 'mock_token' });
    expect(steps[1]).toMatchObject({ op: 'call', entry: 'mint', args: { to_: { addr: 'actor:alice' }, value: { int: '10000' } }, sender: 'deployer' });
    expect(steps[2]).toMatchObject({ op: 'originate', id: 'app', module: 'contract_def', class: 'CosmwasmLocker', args: { deployer: { addr: 'actor:deployer' } } });
    expect(steps[3]).toMatchObject({ op: 'call', entry: 'initialize', args: { token: { addr: 'contract:token_token' }, unlock_at: { int: String(T0 + 1000) } }, sender: 'deployer', now: T0 - 20 });
    expect(steps[4]).toMatchObject({ op: 'call', entry: 'approve', args: { spender: { addr: 'contract:app' } }, sender: 'alice' });
    const calls = steps.filter((s) => s.op === 'call' && s.contract === 'app');
    expect(calls[1]).toMatchObject({ entry: 'deposit', args: [{ int: '5000' }], sender: 'alice', now: T0, amount: '0' });
    expect(calls[2]).toMatchObject({ entry: 'tip', amount: '1000', now: T0 + 1 });
    const views = steps.filter((s) => s.op === 'view');
    expect(views[0]).toMatchObject({ contract: 'app', name: 'deposits', arg: { addr: 'actor:alice' } });
    expect(views[1]).toMatchObject({ name: 'unlocked', arg: null });
    expect(views[2]).toMatchObject({ contract: 'token_token', name: 'get_balance', arg: { addr: 'contract:app' } });
    expect(b.meta.get('s1')!.filter((m) => m.kind === 'deploy')).toHaveLength(1);
  });
  it('not runnable cases: mutez overflow, negative nat, unmapped function', async () => {
    const { spec } = await load('CosmwasmLocker');
    const d = buildDesign(spec);
    const set = mini({ deploy: { actor: 'deployer', args: [{ actor: 'alice' }, '5'], at: 0 }, steps: [{ type: 'call', actor: 'alice', fn: 'tip', args: [], valueWei: (10n ** 27n).toString(), at: 0 }, { type: 'call', actor: 'alice', fn: 'nope', args: [], at: 1 }] });
    const b = buildProgramPlan({ spec, design: d, set });
    const m = b.meta.get('s1')!;
    expect(m.find((x) => x.fn === 'tip')!.notRunnable).toMatch(/does not fit a mutez/);
    expect(m.find((x) => x.fn === 'nope')!.notRunnable).toMatch(/no entrypoint/);
    expect(() => pval('-1', typeMap({ solidity: 'uint256', kind: 'uint', bits: 256 }), set)).toThrow(/negative/);
    expect(pval({ time: 5 }, typeMap({ solidity: 'uint256', kind: 'uint', bits: 256 }), set)).toEqual({ int: String(T0 + 5) });
    expect(pval({ zero: true }, typeMap({ solidity: 'address', kind: 'address' }), set)).toEqual({ addr: 'zero' });
  });
  it('compares: pass, revert mismatch, view mismatch, runner error and the deploy decision', async () => {
    const { spec } = await load('CosmwasmLocker');
    const d = buildDesign(spec);
    const set = mini({
      deploy: { actor: 'deployer', args: [{ actor: 'alice' }, '5'], at: 0, expect: { status: 'success' } },
      steps: [
        { type: 'call', actor: 'alice', fn: 'setUnlock', args: ['7'], at: 0, expect: { status: 'revert', reason: 'not admin' } },
        { type: 'call', actor: 'deployer', fn: 'setUnlock', args: ['7'], at: 1, expect: { status: 'success' } },
        { type: 'view', fn: 'unlockAt', args: [], at: 2, label: 'unlockAt', expect: '7' },
        { type: 'view', fn: 'unlocked', args: [], at: 2, label: 'unlocked', expect: false },
      ],
    });
    const built = buildProgramPlan({ spec, design: d, set });
    const n = built.meta.get('s1')!.length;
    const mk = (over: Record<number, Partial<{ ok: boolean; value: string; error: string; runner_error: string }>>): RunnerResult => ({ runner: 't', scenarios: [{ id: 's1', fatal: null, addresses: { 'actor:alice': "sp.address('tz1A')" }, steps: Array.from({ length: n }, (_, i) => ({ i, op: 'x', ok: true, ...(over[i] ?? {}) })) }] });
    const metas = built.meta.get('s1')!;
    const idx = (pred: (m: (typeof metas)[number]) => boolean) => metas.findIndex(pred);
    const iAlice = idx((m) => m.kind === 'call' && m.scenarioStep === 0), iView1 = idx((m) => m.kind === 'view' && m.scenarioStep === 2 && m.fn === 'unlockAt'), iView2 = idx((m) => m.kind === 'view' && m.fn === 'unlocked');
    const good = compareResults(set, built, mk({ [iAlice]: { ok: false, error: 'not admin' }, [iView1]: { value: '7' }, [iView2]: { value: 'False' } }));
    expect(good[0]!.status).toBe('passed');
    expect(good[0]!.checked).toBe(5);
    const noRevert = compareResults(set, built, mk({ [iAlice]: { ok: true }, [iView1]: { value: '7' }, [iView2]: { value: 'False' } }));
    expect(noRevert[0]!.status).toBe('failed');
    expect(noRevert[0]!.mismatches[0]).toMatchObject({ expected: 'revert (not admin)', actual: 'success' });
    const badView = compareResults(set, built, mk({ [iAlice]: { ok: false, error: 'x' }, [iView1]: { value: '8' }, [iView2]: { value: 'False' } }));
    expect(badView[0]!.status).toBe('failed');
    expect(badView[0]!.mismatches[0]).toMatchObject({ what: 'unlockAt', expected: '7', actual: '8' });
    const err = compareResults(set, built, mk({ [iAlice]: { ok: false, runner_error: 'TypeError_: bad arg' } }));
    expect(err[0]!.status).toBe('not-runnable');
    const deployFail = compareResults(set, built, mk({ [metas.findIndex((m) => m.kind === 'deploy')]: { ok: false, error: 'zero' } }));
    expect(deployFail[0]!.status).toBe('failed');
    expect(deployFail[0]!.mismatches[0]!.what).toBe('deployment');
  });
});

describe('documented differences classified by code', () => {
  it('integer width and uint256 overflow are documented only in the situations where they are the explanation', () => {
    expect(widthDifference('bad arguments: Number "300" is not in the safe range', false)).toMatch(/does not fit the declared integer width/);
    expect(widthDifference('panic 17', true)).toMatch(/arithmetic overflow/);
    expect(widthDifference('panic 17', false)).toBeUndefined(); // an underflow the rewrite failed to reproduce is a real bug
    expect(widthDifference('not owner', true)).toBeUndefined();
    expect(widthDifference(undefined, true)).toBeUndefined();
  });
  it('the plan marks calls with huge arguments and compare uses it', async () => {
    const { spec } = await load('CosmwasmLocker');
    const d = buildDesign(spec);
    const huge = (2n ** 256n - 1n).toString();
    const set = mini({ deploy: { actor: 'deployer', args: [{ actor: 'alice' }, '5'], at: 0, expect: { status: 'success' } }, steps: [{ type: 'call', actor: 'alice', fn: 'tip', args: [], valueWei: '1', at: 0, expect: { status: 'success' } }, { type: 'call', actor: 'deployer', fn: 'setUnlock', args: [huge], at: 1, expect: { status: 'revert', reason: 'panic 17' } }] });
    const built = buildProgramPlan({ spec, design: d, set });
    const metas = built.meta.get('s1')!;
    expect(metas.find((m) => m.fn === 'setUnlock')!.hugeArg).toBe(true);
    expect(metas.find((m) => m.fn === 'tip')!.hugeArg).toBeUndefined();
    const res: RunnerResult = { runner: 't', scenarios: [{ id: 's1', fatal: null, steps: metas.map((_, i) => ({ i, op: 'x', ok: true })) }] };
    const out = compareResults(set, built, res);
    expect(out[0]!.status).toBe('documented-difference');
    expect(out[0]!.mismatches[0]!.documented).toMatch(/arithmetic overflow/);
  });
});

describe('plan building (ERC-20 FA1.2 recipe)', () => {
  it('maps ERC-20 calls and views onto FA1.2 entrypoints and views', async () => {
    const { spec } = await load('ERC20Token');
    const info = erc20Info(spec, classifyStandard(spec).match!);
    const set = mini({
      deploy: { actor: 'deployer', args: ['My Token', 'MTK', '1000'], at: 0 },
      steps: [
        { type: 'call', actor: 'alice', fn: 'transfer', args: [{ actor: 'bob' }, '5'], at: 0 },
        { type: 'call', actor: 'bob', fn: 'transferFrom', args: [{ actor: 'alice' }, { actor: 'bob' }, '5'], at: 1 },
        { type: 'call', actor: 'alice', fn: 'approve', args: [{ actor: 'bob' }, '9'], at: 1 },
        { type: 'call', actor: 'deployer', fn: 'burn', args: ['3'], at: 1 },
        { type: 'view', fn: 'allowance', args: [{ actor: 'alice' }, { actor: 'bob' }], at: 2, label: 'allowance(alice,bob)' },
        { type: 'view', fn: 'balanceOf', args: [{ actor: 'alice' }], at: 2, label: 'balanceOf(alice)' },
      ],
    });
    const b = buildTokenPlan({ spec, design: {} as never, set }, info);
    const steps = b.plan.scenarios[0]!.steps as any[];
    expect(steps[0]).toMatchObject({ op: 'originate', module: 'contract_def', class: 'Token', args: { owner: { addr: 'actor:deployer' }, supply: { int: '1000' }, name: { str: 'My Token' }, symbol: { str: 'MTK' }, decimals: { int: '18' } } });
    const calls = steps.filter((s) => s.op === 'call');
    expect(calls[0]).toMatchObject({ entry: 'transfer', args: { from_: { addr: 'actor:alice' }, to_: { addr: 'actor:bob' }, value: { int: '5' } } });
    expect(calls[1]).toMatchObject({ entry: 'transfer', sender: 'bob', args: { from_: { addr: 'actor:alice' }, to_: { addr: 'actor:bob' } } });
    expect(calls[2]).toMatchObject({ entry: 'approve', args: { spender: { addr: 'actor:bob' }, value: { int: '9' } } });
    expect(calls[3]).toMatchObject({ entry: 'burn', args: [{ int: '3' }] });
    const views = steps.filter((s) => s.op === 'view');
    expect(views[0]).toMatchObject({ name: 'get_allowance', arg: { rec: { owner: { addr: 'actor:alice' }, spender: { addr: 'actor:bob' } } } });
    expect(views[1]).toMatchObject({ name: 'get_balance' });
    expect(tokenOriginateArgs(info, [], 'alice', 'N', 'S', '6').decimals).toEqual({ int: '6' });
  });
});
