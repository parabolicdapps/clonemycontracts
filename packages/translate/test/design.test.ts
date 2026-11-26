import { describe, expect, it } from 'vitest';
import { classifyStandard } from '../src/spec/standard.js';
import { buildDesign, snake } from '../src/targets/solana/design.js';
import { genAccounts, genErrors, genLib, genState, errorVariants } from '../src/targets/solana/codegen.js';
import { buildProgramPlan, buildSplPlan } from '../src/targets/solana/adapter.js';
import { compareResults, parseReturn, sameValue } from '../src/targets/solana/compare.js';
import { checkConformance } from '../src/targets/solana/conformance.js';
import { firstErrorBlocks, hintsFor } from '../src/targets/solana/prompts.js';
import { buildFunctionReports, renderReport, exitCodeFor } from '../src/pipeline/report.js';
import { load } from './helpers.js';

describe('classifier (standard first, conservative)', () => {
  it('plain ERC-20 with owner mint/burn is a template', async () => {
    const { spec } = await load('ERC20Token');
    const v = classifyStandard(spec);
    expect(v.match).toMatchObject({ standard: 'ERC-20', features: { mintable: true, burnable: true, ownable: true }, initialSupplyParam: 2 });
  });
  it('anything beyond the recognised set goes to the model path', async () => {
    for (const n of ['StakingRewards', 'LinearVesting', 'MultiSig2of3', 'ERC721Mint']) {
      const { spec } = await load(n);
      expect(classifyStandard(spec).match, n).toBeNull();
    }
    const { spec } = await load('ERC721Mint');
    expect(classifyStandard(spec).reasons.join(' ')).toMatch(/payable|outside the standard/);
  });
});

describe('design mapping', () => {
  it('snake_case and reserved words', () => { expect(snake('rewardPerTokenStored')).toBe('reward_per_token_stored'); expect(snake('_type')).toBe('type_'); });
  it('StakingRewards: config + one grouped user account, ATA vaults decided once, mints from constructor params', async () => {
    const { spec } = await load('StakingRewards');
    const d = buildDesign(spec);
    expect(d.accounts.map((a) => a.name)).toEqual(['Config', 'User']);
    expect(d.accounts[1]!.fields.map((f) => f.name)).toEqual(['staked', 'user_reward_per_token_paid', 'rewards', 'bump']);
    expect(d.tokens.map((t) => t.vault)).toEqual(['staking_vault', 'reward_vault']);
    const init = d.instructions.find((i) => i.kind === 'initialize')!;
    expect(init.args).toEqual([]);
    expect(init.accounts.filter((a) => a.kind === 'vault').every((a) => a.init === 'init')).toBe(true);
    const stake = d.instructions.find((i) => i.name === 'stake')!;
    expect(stake.accounts.map((a) => a.name)).toEqual(['caller', 'config', 'user_caller', 'caller_staking_ata', 'staking_mint', 'staking_vault', 'system_program', 'token_program']);
    expect(d.observables.earned).toMatchObject({ kind: 'view-instruction' });
  });
  it('MultiSig: owner mapping becomes membership in config.owners; array items are PDAs seeded by the length', async () => {
    const { spec } = await load('MultiSig2of3');
    const d = buildDesign(spec);
    expect(d.derivedMappings).toEqual([{ mapping: 'isOwner', arrayField: 'owners' }]);
    expect(d.accounts.find((a) => a.role === 'item')!.keys).toEqual([{ name: 'index', rust: 'u64', solidity: 'uint256' }]);
    const submit = d.instructions.find((i) => i.name === 'submit')!;
    expect(submit.accounts.find((a) => a.name === 'txs_item')!.init).toBe('init');
    expect(submit.accounts.find((a) => a.kind === 'recipient')!.from).toEqual({ arg: 'to' });
    expect(d.notTranslated.some((n) => /arbitrary calldata/i.test(n.reason))).toBe(true);
  });
  it('generated Rust is deterministic and structured', async () => {
    const { spec } = await load('LinearVesting');
    const d = buildDesign(spec);
    expect(genState(d)).toContain('pub struct Config {');
    expect(genAccounts(d)).toContain('associated_token::authority = config');
    expect(genLib(d, 'X')).toContain('crate::logic::fund::handler(ctx, amount)');
    const e = errorVariants(spec);
    expect(e.variants.map((v) => v.name)).toEqual(expect.arrayContaining(['ZeroBeneficiary', 'NotFunder', 'NothingToRelease']));
    expect(genErrors(spec)).toContain('#[msg("zero beneficiary")]');
  });
});

describe('plan building and comparison', () => {
  const mini = (): any => ({ version: 1, contract: 'ERC20Token', t0: 1_700_000_000, actors: ['deployer', 'alice', 'bob', 'carol', 'mallory'], tokens: [], scenarios: [
    { id: 's1', title: 't', kind: 'function', fn: 'transfer', source: 'template', deploy: { actor: 'deployer', at: -20, args: ['T', 'T', '1000000000000'], expect: { status: 'success' } }, steps: [
      { type: 'call', actor: 'deployer', fn: 'transfer', args: [{ actor: 'alice' }, '5000000000'], at: 1, expect: { status: 'success' } },
      { type: 'call', actor: 'alice', fn: 'transfer', args: [{ zero: true }, '1000000000'], at: 2, expect: { status: 'revert', reason: 'zero address' } },
      { type: 'view', fn: 'balanceOf', args: [{ actor: 'alice' }], at: 3, label: 'balanceOf(alice)', expect: '5000000000' },
      { type: 'call', actor: 'alice', fn: 'transfer', args: [{ actor: 'bob' }, '1'], at: 4, expect: { status: 'success' } },
    ] }] });
  it('SPL plan: amounts are scaled, zero-address transfer is a documented difference', async () => {
    const { spec } = await load('ERC20Token');
    const { buildTemplateDesign } = await import('../src/targets/solana/template.js');
    const m = classifyStandard(spec).match!;
    const design = buildTemplateDesign(spec, m, 18, 9);
    const set = mini();
    const built = buildSplPlan({ spec, design, set }, { initialSupplyParam: 2, decimalsFn: true, mintable: true, burnable: true, ownable: true });
    const steps = built.plan.scenarios[0]!.steps as any[];
    expect(steps.find((s) => s.op === 'spl_mint_to')!.amount).toBe('1000');
    expect(steps.filter((s) => s.op === 'spl_transfer')[0].amount).toBe('5');
    const metas = built.meta.get('s1')!;
    expect(metas.find((x) => x.fn === 'transfer' && x.documented)).toBeTruthy();
    // a non-multiple of the unit conversion is not runnable (never silently rounded)
    expect(metas.filter((x) => x.notRunnable).length).toBe(1);
    // fake runner results
    const results = { runner: 'x', scenarios: [{ id: 's1', fatal: null, steps: steps.map((s, i) => {
      if (s.op === 'spl_transfer' && s.amount === '1') return { index: i, op: s.op, ok: true };
      if (s.op === 'read_account') return { index: i, op: s.op, exists: true, value: { amount: '5' } };
      return { index: i, op: s.op, ok: true };
    }) }] };
    const out = compareResults(set, built, results as any, design);
    expect(out[0]!.status === 'documented-difference' || out[0]!.status === 'not-runnable').toBe(true);
    expect(out[0]!.mismatches.some((x) => x.documented)).toBe(true);
  });
  it('program plan resolves roles to refs and refuses lossy amount conversions', async () => {
    const { spec } = await load('LinearVesting');
    const design = buildDesign(spec);
    const set: any = { version: 1, contract: 'LinearVesting', t0: 1_700_000_000, actors: ['deployer', 'alice'], tokens: [{ name: 'token', decimals: 18, fundings: [{ actor: 'alice', amount: '1000000000000000000000' }], approveContract: true }], scenarios: [
      { id: 'a', title: 'a', kind: 'function', fn: 'fund', source: 'template', deploy: { actor: 'deployer', at: -20, args: [{ token: 'token' }, { actor: 'alice' }, { time: 100 }, '200', '1000'], expect: { status: 'success' } }, steps: [
        { type: 'call', actor: 'deployer', fn: 'fund', args: ['100000000000000000000'], at: 1, expect: { status: 'success' } },
        { type: 'call', actor: 'deployer', fn: 'fund', args: ['1500000000'], at: 2, expect: { status: 'success' } },
      ] }] };
    const built = buildProgramPlan({ spec, design, set });
    const steps = built.plan.scenarios[0]!.steps as any[];
    const deploy = steps.find((s) => s.id === 'deploy');
    expect(deploy.name).toBe('initialize');
    expect(deploy.args).toMatchObject({ beneficiary: 'actor:alice', start: String(1_700_000_100), cliff_seconds: '200', duration: '1000' });
    expect(deploy.accounts.token_mint).toBe('name:token_mint');
    const fund = steps.find((s) => s.id === 'step0');
    expect(fund.args.amount).toBe('100000000000');
    expect(fund.accounts.caller_token_ata).toEqual({ ata: { owner: 'actor:deployer', mint: 'name:token_mint' } });
    expect(built.meta.get('a')!.some((m) => m.notRunnable && /multiple/.test(m.notRunnable))).toBe(true); // 1.5e9 is not a multiple of 1e9: refused, never rounded
  });
  it('value comparison: scaling, rounding, either-scale for ratios', () => {
    expect(sameValue('5000000000', '5', 'token', 10n ** 9n).ok).toBe(true);
    expect(sameValue('5000000001', '5', 'token', 10n ** 9n).note).toMatch(/rounding/);
    expect(sameValue('7', '5', 'plain', 10n ** 9n).ok).toBe(false);
    expect(sameValue('1000000000000000000', '1000000000', 'ratio', 10n ** 9n).ok).toBe(true);
    expect(sameValue('zero', 'zero', 'plain', 1n).ok).toBe(true);
    expect(sameValue(true, false, 'plain', 1n).ok).toBe(false);
  });
  it('return data decoding', () => {
    expect(parseReturn('u128', Buffer.from([5, ...new Array(15).fill(0)]).toString('base64'))).toBe('5');
    expect(parseReturn('bool', Buffer.from([1]).toString('base64'))).toBe(true);
  });
});

describe('conformance, repair helpers, report', () => {
  it('detects missing instructions/accounts and wrong seeds', async () => {
    const { spec } = await load('LinearVesting');
    const d = buildDesign(spec);
    const idl = { instructions: [{ name: 'fund', args: [{ name: 'amount', type: 'u128' }], accounts: [{ name: 'caller' }, { name: 'config', pda: { seeds: [{ kind: 'const', value: Array.from(Buffer.from('cfg')) }] } }] }], accounts: [{ name: 'Config' }] };
    const p = checkConformance(idl, d);
    expect(p.some((x) => /`initialize` is missing/.test(x))).toBe(true);
    expect(p.some((x) => /first seed is b"config"/.test(x))).toBe(true);
    expect(p.some((x) => /account `token_vault` is missing/.test(x))).toBe(true);
  });
  it('error blocks and hints', () => {
    const log = 'warning: x\nerror[E0382]: borrow of moved value\n --> programs/app/src/logic/fund.rs:9:5\n  |\nerror: could not compile `app`\n';
    expect(firstErrorBlocks(log)).toContain('E0382');
    expect(hintsFor(log)[0]).toMatch(/clone/);
  });
  it('report states FAILED prominently and carries the unaudited notice; exit codes differ', async () => {
    const { spec } = await load('ERC20Token');
    const outcomes: any[] = [{ id: 's', title: 'x', kind: 'function', fn: 'transfer', status: 'failed', mismatches: [{ at: '1', what: 'transfer', expected: 'revert', actual: 'success' }], notRunnable: [], checked: 1, notes: [] }];
    const functions = buildFunctionReports(spec, outcomes, { unitOf: (f) => f, fidelity: {}, notTranslatedFns: new Map(), differences: new Map(), template: false });
    const md = renderReport({ version: 1, contract: 'ERC20Token', source: {} as any, target: 'solana', path: 'model', status: 'FAILED-BEHAVIOUR', statusReasons: ['1 scenario(s) failed'], coverage: { functionsTotal: 1, functionsVerified: 0, functionsUnverified: ['transfer'], uncheckedFunctions: [], trivialOnlyFunctions: [], notTranslatedFunctions: [], uncomparedReturns: [], notRunnableScenarios: [], getters: { planned: 0, checked: 0, mismatched: 0, notCompared: [] }, functionsAbsent: [], functionsPresent: 1, failedFunctions: ['transfer'], otherUnverifiedFunctions: [], summary: '0 of 1 state-changing functions verified with non-trivial values' }, compile: { ok: true, round: 1, rounds: [] }, behaviour: { ran: true, passed: 0, failed: 1, notRunnable: 0, documented: 0, total: 1, rounds: [], conformance: [] }, functions, nonPortable: [], notTranslated: [], designNotes: [], deploy: [], usage: { requests: 0, tokensIn: 0, tokensOut: 0, modelSecs: 0 }, wallSecs: 1, outcomes, scenarioCount: 1 });
    expect(md).toContain('**Result: FAILED-BEHAVIOUR**');
    expect(md).toContain('UNAUDITED');
    expect(md).toContain('## Failing scenarios');
    expect(exitCodeFor('FAILED-COMPILE')).toBe(6); expect(exitCodeFor('FAILED-BEHAVIOUR')).toBe(8); expect(exitCodeFor('PASSED')).toBe(0);
    expect(functions.find((f) => f.name === 'transfer')!.failing.length).toBe(1);
  });
});
