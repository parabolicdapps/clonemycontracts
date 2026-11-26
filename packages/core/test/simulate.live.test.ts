// Network + anvil + solc downloads: CMC_LIVE=1 npm test. Full fork simulations of the verified examples.
import { describe, expect, it } from 'vitest';
import { analyse } from '../src/analyse/index.js';
import { planClone } from '../src/plan/index.js';
import { simulate } from '../src/deploy/index.js';

const T = 300_000;
const run = async (addr: string, from: string, to: string, set: Record<string, string> = {}) => {
  const a = await analyse(addr, from);
  const plan = await planClone(a, to, set);
  expect(plan.unsupported).toEqual([]);
  expect(plan.needsInput).toEqual([]);
  const sim = await simulate(plan, { allowUnresolved: true });
  return { plan, sim, check: (name: RegExp) => sim.checks.find((c) => name.test(c.name)) };
};
const ok = (sim: { ok: boolean; checks: { ok: boolean; name: string; detail: string }[] }) => expect(sim.checks.filter((c) => !c.ok), JSON.stringify(sim.checks.filter((c) => !c.ok))).toEqual([]);

describe.skipIf(!process.env.CMC_LIVE)('fork simulations', () => {
  it('Phase 1: DAI eth -> base', async () => {
    const r = await run('0x6B175474E89094C44Da98b954EedeAC495271d0F', 'eth', 'base'); expect(r.sim.ok).toBe(true); ok(r.sim);
    expect(r.sim.checks.every((c) => c.level && c.kind && c.subject)).toBe(true);
    expect(r.sim.checks.find((c) => c.kind === 'code-present')).toMatchObject({ level: 'pass', subject: 'contract' });
    expect(r.sim.checks.find((c) => c.name === 'contract: name()')).toMatchObject({ level: 'pass', relation: 'same', cloneValue: 'Dai Stablecoin', originalValue: 'Dai Stablecoin' });
    expect(r.sim.checks.find((c) => c.name === 'contract: totalSupply()')).toMatchObject({ level: 'pass', relation: 'differs-expected' });
  }, T);
  it('Phase 1: Uniswap V2 Router02 eth -> arbitrum', async () => { const r = await run('0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D', 'eth', 'arbitrum'); expect(r.sim.ok).toBe(true); }, T);

  it('USDC proxy eth -> base-sepolia ends INITIALISED: name "USD Coin", symbol USDC, decimals 6', async () => {
    const r = await run('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', 'eth', 'base-sepolia', {
      newMasterMinter: 'deployer', newPauser: 'deployer', newBlacklister: 'deployer', newOwner: 'deployer', newAdmin: '0x000000000000000000000000000000000000dEaD', newName: 'USD Coin',
    });
    expect(r.sim.ok).toBe(true);
    expect(r.check(/proxy: name\(\)/)!.detail).toContain('clone="USD Coin"');
    expect(r.check(/proxy: symbol\(\)/)!.detail).toContain('clone="USDC"');
    expect(r.check(/proxy: decimals\(\)/)!.detail).toContain('clone=6');
    expect(r.check(/calling initialize\(.*\) again reverts/)!.ok).toBe(true);
  }, T);

  const usdcSet = { newMasterMinter: 'deployer', newPauser: 'deployer', newBlacklister: 'deployer', newOwner: 'deployer', newAdmin: '0x000000000000000000000000000000000000dEaD', newName: 'USD Coin' };
  const usdcChecks = (r: Awaited<ReturnType<typeof run>>) => {
    expect(r.sim.ok).toBe(true);
    expect(r.check(/proxy: name\(\)/)!.detail).toContain('clone="USD Coin"');
    expect(r.check(/proxy: symbol\(\)/)!.detail).toContain('clone="USDC"');
    expect(r.check(/proxy: decimals\(\)/)!.detail).toContain('clone=6');
    expect(r.check(/calling initialize\(.*\) again reverts/)!.ok).toBe(true);
  };

  it('USDC, NO history (CMC_NO_HISTORY): ABI-detected initialisers with the same --set names also end initialised', async () => {
    process.env.CMC_NO_HISTORY = '1';
    try {
      const r = await run('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', 'eth', 'base-sepolia', { ...usdcSet, tokenName: 'USD//C', tokenSymbol: 'USDC', tokenCurrency: 'USD', tokenDecimals: '6' });
      expect(r.plan.initialisation!.notes.join(' ')).toMatch(/initialiser history: none/);
      usdcChecks(r);
    } finally { delete process.env.CMC_NO_HISTORY; }
  }, T);

  it('USDC, NO history and the base initialiser not supplied: dependents are skipped, nothing reverts', async () => {
    process.env.CMC_NO_HISTORY = '1';
    try {
      const a = await analyse('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', 'eth');
      const plan = await planClone(a, 'base-sepolia', usdcSet);
      expect(plan.needsInput).toContain('init:initialize.tokenName');
      const sim = await simulate(plan, { allowUnresolved: true });
      const skipped = Object.fromEntries((sim.skipped ?? []).map((k) => [k.stepId, k.reason]));
      expect(skipped['init:initialize']).toMatch(/needs input: tokenName/);
      expect(skipped['init:initializeV2']).toMatch(/depends on init:initialize, which was skipped/);
      // structured checks: an uninitialised proxy clone must not read as a pass
      expect(sim.ok).toBe(false);
      const nameCheck = sim.checks.find((c) => c.kind === 'view-call' && c.subject === 'proxy' && /name\(\)/.test(c.name))!;
      expect(nameCheck).toMatchObject({ ok: true, level: 'warn', relation: 'differs', cloneValue: '', originalValue: 'USD Coin' });
      expect(nameCheck.reason).toMatch(/not initialised/);
      expect(sim.checks.find((c) => c.kind === 'skipped-step' && c.subject === 'init:initialize')).toMatchObject({ level: 'fail', ok: false });
    } finally { delete process.env.CMC_NO_HISTORY; }
  }, T);

  it('Transparent proxy with constructor _data (eth -> arbitrum)', async () => {
    const r = await run('0x131c370234975811BE7F62Fb65888F6Cc524DEA2', 'eth', 'arbitrum', {
      initialOwner: 'deployer', _owner: 'deployer', _authoritySigner: '0x00000000000000000000000000000000000000A1', _cryptoartNFT: '0x00000000000000000000000000000000000000A2', _cryptoartVault: '0x00000000000000000000000000000000000000A3',
    });
    expect(r.sim.ok).toBe(true);
    expect(r.check(/calling initialize/)!.ok).toBe(true);
  }, T);

  it('Beacon proxy (eth -> base)', async () => {
    const r = await run('0x377f6953151BE60f7e49B7b84313cf2827B0F9A0', 'eth', 'base', { _owner: 'deployer', _admin: 'deployer' });
    expect(r.sim.ok).toBe(true);
    expect(r.check(/beacon proxy/)!.ok).toBe(true);
  }, T);

  it('EIP-1167 minimal proxy (eth -> base)', async () => {
    const r = await run('0xc203C3184D2D38A66bb52C1B08d587AAaD555600', 'eth', 'base');
    expect(r.sim.ok).toBe(true);
    expect(r.check(/proxy points at the new implementation/)!.detail).toMatch(/EIP-1167/);
  }, T);

  it('hard-coded Chainlink feed literal remapped to the Arbitrum feed and patched into the source', async () => {
    const r = await run('0x7c9fa97DDD3997Bf953044E49B19ca9D33199c58', 'eth', 'arbitrum');
    expect(r.plan.sourceLiterals![0]).toMatchObject({ value: '0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612', action: 'remap' });
    expect(r.sim.results[0]!.modifiedSource).toBe(true);
    expect(r.check(/patched address/)!.ok).toBe(true);
  }, T);

  it('Chainlink consumer with feed constructor args (Morpho oracle eth -> arbitrum) gets feed remap suggestions', async () => {
    const a = await analyse('0xDddd770BADd886dF3864029e4B377B5F6a2B6b83', 'eth');
    const plan = await planClone(a, 'arbitrum');
    const byName = Object.fromEntries(plan.steps[0]!.args.map((x) => [x.name, x]));
    expect(byName.baseFeed2).toMatchObject({ action: 'remap', value: '0x6ce185860a4963106506C203335A2910413708e9' }); // BTC / USD
    expect(byName.quoteFeed1).toMatchObject({ action: 'remap', value: '0x50834F3163758fcC1Df9973b6e91f0F0F0434aD3' }); // USDC / USD
    expect(byName.baseFeed1!.action).toBe('needs-input'); // WBTC / BTC: matched by description() but no Arbitrum feed in the registry
  }, T);
});
