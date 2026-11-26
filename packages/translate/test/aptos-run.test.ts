import { describe, expect, it } from 'vitest';
import { buildTestPlan, parseTestOutput } from '../src/targets/aptos/adapter.js';
import { compareResults, normalizePrinted } from '../src/targets/aptos/compare.js';
import { buildAptosDesign } from '../src/targets/aptos/design.js';
import type { ScenarioSet } from '../src/types.js';
import { load } from './helpers.js';

const set = (scenarios: ScenarioSet['scenarios']): ScenarioSet => ({ version: 1, contract: 'LinearVesting', t0: 1_700_000_000, actors: ['deployer', 'alice', 'bob', 'carol', 'mallory'], tokens: [{ name: 'token', decimals: 18, fundings: [{ actor: 'deployer', amount: '1000000000000000000000000' }, { actor: 'alice', amount: '1000000000000000000000000' }], approveContract: true }], scenarios });
const deploy = { actor: 'deployer', args: [{ token: 'token' }, { actor: 'alice' }, { time: 100 }, '200', '1000'], at: -20, expect: { status: 'success' as const } };

describe('aptos test-module generation', () => {
  it('one test per scenario plus one per expected revert; amounts scaled; steps carry line marks', async () => {
    const { spec } = await load('LinearVesting');
    const d = buildAptosDesign(spec);
    const sc = set([{ id: 'fn-fund-01', title: 'fund', kind: 'function', fn: 'fund', deploy, source: 'template', steps: [
      { type: 'call', actor: 'deployer', fn: 'fund', args: ['100000000000000000000'], at: 1, expect: { status: 'success' } },
      { type: 'call', actor: 'mallory', fn: 'fund', args: ['100000000000000000000'], at: 2, expect: { status: 'revert', reason: 'not funder' } },
      { type: 'view', fn: 'totalAllocation', args: [], at: 3, label: 'totalAllocation', expect: '100000000000000000000' },
    ] }, { id: 'init-02', title: 'zero beneficiary', kind: 'init', deploy: { ...deploy, args: [{ token: 'token' }, { zero: true }, { time: 100 }, '200', '1000'], expect: { status: 'revert' } }, steps: [], source: 'template' }]);
    const plan = buildTestPlan({ design: d, set: sc });
    expect(plan.tests.map((t) => `${t.name}:${t.kind}`)).toEqual(['s_fn_fund_01:main', 's_fn_fund_01_r1:revert-step', 's_init_02_d:revert-deploy']);
    expect(plan.source).toContain('linear_vesting::fund(&deployer, 10000000000)');
    expect(plan.source).toContain('fx_token(b"token", vector[@app, @0xa11ce], vector[100000000000000, 100000000000000])');
    expect(plan.source).toContain('linear_vesting::initialize(&deployer, tok_token, @0xa11ce, 1700000100, 200, 1000)');
    // the reverting step is not in the main test, but is the last step of its own test
    const main = plan.source.split('fun s_fn_fund_01_r1')[0]!;
    expect(main).not.toContain('fund(&mallory');
    const r1 = plan.source.split('fun s_fn_fund_01_r1')[1]!.split('fun s_init_02_d')[0]!;
    expect(r1.indexOf('fund(&mallory')).toBeGreaterThan(r1.indexOf('fund(&deployer'));
    expect(r1).not.toContain('totalAllocation');
    const markLines = [...plan.marks.entries()].filter(([, m]) => m.test === 's_fn_fund_01_r1' && m.kind === 'call');
    expect(markLines.length).toBe(2);
    expect(plan.source.split('\n')[markLines[1]![0] - 1]).toContain('&mallory');
  });
  it('amounts that do not convert exactly are not runnable, never silently rounded', async () => {
    const { spec } = await load('LinearVesting');
    const d = buildAptosDesign(spec);
    const sc = set([{ id: 'x', title: 'x', kind: 'function', fn: 'fund', deploy, source: 'template', steps: [{ type: 'call', actor: 'deployer', fn: 'fund', args: ['123'], at: 1, expect: { status: 'success' } }] }]);
    expect(buildTestPlan({ design: d, set: sc }).notRunnable.get('x')).toMatch(/not a multiple/);
  });
});

const LOG = `[aptos] [ PASS    ] 0xcafe::cmc_tests::s_a
[aptos] [debug] "CMC|s_a|3|0|100"
[aptos] [debug] "CMC|s_a|tok:token|0|@0xfc269eb72e37fad6269622f92d79bdde6afc919ae9eb83333daa06f0fe2e1c93"
[aptos] [debug] "CMC|s_a|4|0|@0xa11ce"
[aptos] [ FAIL    ] 0xcafe::cmc_tests::s_a_r1
[aptos] 
[aptos] Test failures:
[aptos] ┌── s_a_r1 ──────
[aptos] │ error[E11001]: test failure
[aptos] │    ┌─ /tmp/tmp.x/sources/linear_vesting.move:39:9
[aptos] │ 39 │         assert!(x, E_NOT_FUNDER);
[aptos] │    │         ^^^^^^ Test was not expected to error, but it aborted with code 6 originating in the module 000000000000000000000000000000000000000000000000000000000000cafe::linear_vesting rooted here
[aptos] │ stack trace
[aptos] │ 	linear_vesting::fund(/tmp/tmp.x/sources/linear_vesting.move:41)
[aptos] │ 	cmc_tests::s_a_r1(/tmp/tmp.x/tests/cmc_tests.move:77)
[aptos] └──────────────────
[aptos] Test result: FAILED. Total tests: 2; passed: 1; failed: 1`;

describe('aptos test output parsing and comparison', () => {
  it('parses pass/fail, abort codes, the failing test line and the printed values', () => {
    const p = parseTestOutput(LOG);
    expect(p.results.get('s_a')!.passed).toBe(true);
    expect(p.results.get('s_a')!.prints.get('3|0')).toBe('100');
    const f = p.results.get('s_a_r1')!;
    expect(f.passed).toBe(false);
    expect(f.failure).toMatchObject({ line: 77, abortCode: 6, kind: 'abort' });
    expect(p.summary).toContain('passed: 1; failed: 1');
  });
  it('normalises printed values to the neutral form', () => {
    const names = new Map([['a11ce', 'actor:alice']]);
    expect(normalizePrinted('@0xa11ce', names)).toBe('actor:alice');
    expect(normalizePrinted('@0x0', names)).toBe('zero');
    expect(normalizePrinted('true', names)).toBe(true);
    expect(normalizePrinted('"yo"', names)).toBe('yo');
    expect(normalizePrinted('0x6869', names)).toBe('0x6869');
  });
  it('a revert that does not happen, and a value that differs, fail the scenario; a matching one passes', async () => {
    const { spec } = await load('LinearVesting');
    const d = buildAptosDesign(spec);
    const sc = set([{ id: 'fn-fund-01', title: 'fund', kind: 'function', fn: 'fund', deploy, source: 'template', steps: [
      { type: 'call', actor: 'deployer', fn: 'fund', args: ['100000000000000000000'], at: 1, expect: { status: 'success' } },
      { type: 'call', actor: 'mallory', fn: 'fund', args: ['100000000000000000000'], at: 2, expect: { status: 'revert', reason: 'not funder' } },
      { type: 'view', fn: 'totalAllocation', args: [], at: 3, label: 'totalAllocation', expect: '100000000000000000000' },
    ] }]);
    const plan = buildTestPlan({ design: d, set: sc });
    const res = (mainValue: string, revertHappens: boolean) => parseTestOutput(`[ PASS    ] 0xcafe::cmc_tests::s_fn_fund_01\n[debug] "CMC|s_fn_fund_01|2|0|${mainValue}"\n${!revertHappens ? '[ PASS    ] 0xcafe::cmc_tests::s_fn_fund_01_r1' : '[ FAIL    ] 0xcafe::cmc_tests::s_fn_fund_01_r1\n┌── s_fn_fund_01_r1 ──────\n│ stack trace\n│ \tcmc_tests::s_fn_fund_01_r1(/x/tests/cmc_tests.move:' + [...plan.marks.entries()].filter(([, m]) => m.test === 's_fn_fund_01_r1' && m.step === 1)[0]![0] + ')\n│ aborted with code 6\n└──────'}`).results;
    expect(compareResults(sc, plan, res('10000000000', false), d)[0]).toMatchObject({ status: 'failed', mismatches: [{ expected: 'revert (not funder)', actual: 'success' }] });
    expect(compareResults(sc, plan, res('5', true), d)[0]!).toMatchObject({ status: 'failed', mismatches: [{ what: 'totalAllocation' }] });
    expect(compareResults(sc, plan, res('10000000000', true), d)[0]).toMatchObject({ status: 'passed', checked: 4 });
  });
});
