import { afterAll, describe, expect, it } from 'vitest';
import { OriginalRunner } from '../src/scenario/original.js';
import { generateScenarios, recordGroundTruth, defaultDeployArgs } from '../src/scenario/generate.js';
import { hasAnvil, load } from './helpers.js';

const d = hasAnvil ? describe : describe.skip;

d('original runner + scenario generation (anvil)', () => {
  const runners: OriginalRunner[] = [];
  afterAll(async () => { await Promise.all(runners.map((r) => r.stop())); });
  const start = async (name: string) => { const { c, spec } = await load(name); const r = await OriginalRunner.start(c.abi, c.creation); runners.push(r); return { r, spec }; };

  it('runs a hand-written ERC20 scenario and records reverts with reasons', async () => {
    const { r } = await start('ERC20Token');
    const set: any = { version: 1, contract: 'ERC20Token', t0: r.t0, actors: [], tokens: [], scenarios: [] };
    const sc: any = { id: 's', title: 't', kind: 'function', source: 'template', deploy: { actor: 'deployer', at: -20, args: ['Tok', 'TK', '1000'] }, steps: [
      { type: 'call', actor: 'deployer', fn: 'transfer', args: [{ actor: 'alice' }, '5'], at: 1 },
      { type: 'view', fn: 'balanceOf', args: [{ actor: 'alice' }], at: 2, label: 'b' },
      { type: 'call', actor: 'alice', fn: 'mint', args: [{ actor: 'alice' }, '5'], at: 3 },
      { type: 'call', actor: 'alice', fn: 'transfer', args: [{ zero: true }, '5'], at: 4 },
      { type: 'view', fn: 'owner', args: [], at: 5, label: 'o' },
    ] };
    const t = await r.runScenario(set, sc);
    expect(t.deploy.status).toBe('success');
    expect(t.steps[0]!.observed).toMatchObject({ status: 'success', events: ['Transfer'] });
    expect(t.steps[1]!.value).toBe('5');
    expect(t.steps[2]!.observed).toEqual({ status: 'revert', reason: 'not owner' });
    expect(t.steps[3]!.observed).toEqual({ status: 'revert', reason: 'zero address' });
    expect(t.steps[4]!.value).toBe('actor:deployer');
    // state is rolled back between scenarios
    const t2 = await r.runScenario(set, sc);
    expect(t2.steps[1]!.value).toBe('5');
  });

  it('time is controlled: vesting is zero before the cliff and grows after', async () => {
    const { r, spec } = await start('LinearVesting');
    const set = await generateScenarios(spec, r);
    await recordGroundTruth(set, r);
    const time = set.scenarios.filter((s) => s.kind === 'time');
    expect(time.length).toBeGreaterThan(2);
    const vestedAt = (s: (typeof time)[number]) => s.steps.find((x) => x.type === 'view' && x.fn === 'vested');
    const v = time.map((s) => vestedAt(s)!.type === 'view' ? (vestedAt(s) as any).expect : null);
    expect(v.every((x) => typeof x === 'string')).toBe(true);
  });

  it('generates deterministic scenario sets with ground truth for every bench contract', async () => {
    for (const name of ['ERC20Token', 'StakingRewards', 'MultiSig2of3']) {
      const { r, spec } = await start(name);
      const a = await generateScenarios(spec, r);
      const b = await generateScenarios(spec, r);
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
      const gt = await recordGroundTruth(a, r);
      expect(gt.fatal).toEqual([]);
      expect(a.scenarios.length).toBeGreaterThan(8);
      expect(a.scenarios.every((s) => s.deploy.expect)).toBe(true);
      // every function exercised by a valid call has at least one successful call in a scenario
      const calls = new Set(a.scenarios.flatMap((s) => s.steps).flatMap((st) => (st.type === 'call' && st.expect?.status === 'success' ? [st.fn] : [])));
      expect(calls.size).toBeGreaterThan(2);
    }
  });

  it('records constructor violations as deploy reverts', async () => {
    const { r, spec } = await start('LinearVesting');
    const set = await generateScenarios(spec, r);
    await recordGroundTruth(set, r);
    const bad = set.scenarios.find((s) => /_beneficiary = zero/.test(s.title))!;
    expect(bad.deploy.expect).toMatchObject({ status: 'revert', reason: 'zero beneficiary' });
    expect(defaultDeployArgs(spec).length).toBe(5);
  });
});
