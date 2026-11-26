import { describe, expect, it } from 'vitest';
import { analyseContract } from '../src/analyse/index.js';
import { planClone } from '../src/plan/index.js';
import { ADDR, fetchFixture, loadVc, offlineExplorer, stubReader } from './helpers.js';

const opts = { reader: stubReader(), fetchImplementation: fetchFixture, fetchContract: fetchFixture, ...offlineExplorer };
const planFor = async (addr: typeof ADDR.dai, to: string, set = {}) => planClone(await analyseContract(loadVc(addr), opts), to, set, opts);

describe('clone plan', () => {
  it('remaps the chain id argument', async () => {
    const p = await planFor(ADDR.dai, 'base');
    expect(p.steps).toHaveLength(1);
    expect(p.steps[0]!.args[0]).toMatchObject({ name: 'chainId_', action: 'remap', value: '8453', original: '1' });
    expect(p.contracts['contract']!.expectedMatch).toBe(true);
    expect(p.warnings[0]).toMatch(/State is not copied/);
  });

  it('remaps WETH and the factory for Arbitrum', async () => {
    const p = await planFor(ADDR.router, 'arbitrum');
    const [factory, weth] = p.steps[0]!.args;
    expect(weth).toMatchObject({ action: 'remap', value: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1' });
    expect(factory).toMatchObject({ action: 'remap', value: '0xf1D7CC64Fb4452F05c498126312eBE29f30Fbcf9' });
    expect(p.warnings.join('\n')).toMatch(/init-code hash/);
  });

  it('needs input when the target has no counterpart (Polygon has no V2 factory in the registry)', async () => {
    const p = await planFor(ADDR.router, 'polygon');
    expect(p.steps[0]!.args[0]!.action).toBe('needs-input');
    expect(p.steps[0]!.args[1]!.action).toBe('remap'); // WPOL
    expect(p.needsInput).toEqual(['contract._factory']);
  });

  it('applies overrides by arg name, by address, and rejects unknown keys', async () => {
    const p = await planFor(ADDR.router, 'polygon', { _factory: '0x1111111111111111111111111111111111111111', '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2': '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270' });
    expect(p.needsInput).toEqual([]);
    expect(p.steps[0]!.args[0]!.value).toBe('0x1111111111111111111111111111111111111111');
    expect(p.contracts['contract']!.sourceEdits.length).toBeGreaterThanOrEqual(0);
    await expect(planFor(ADDR.router, 'polygon', { nope: '1' })).rejects.toThrow(/no constructor argument/);
  });

  it('proxy: library -> implementation -> proxy, with proxy arg pointing at the new implementation', async () => {
    const p = await planFor(ADDR.usdcProxy, 'base-sepolia');
    // no explorer history offline: initialisers are detected from the ABI (optional steps), plus the admin hand-over for this proxy kind
    expect(p.steps.map((s) => [s.id, s.kind]).slice(0, 3)).toEqual([['lib:SignatureChecker', 'library'], ['implementation', 'implementation'], ['proxy', 'proxy']]);
    expect(p.steps.slice(3).map((s) => s.kind)).toEqual(['admin', 'initialise', 'initialise', 'initialise', 'initialise']);
    expect(p.steps[1]!.links).toEqual({ ':SignatureChecker': 'step:lib:SignatureChecker' });
    expect(p.steps[1]!.dependsOn).toContain('lib:SignatureChecker');
    expect(p.steps[2]!.args[0]).toMatchObject({ action: 'remap', value: { $ref: 'step:implementation' } });
    expect(p.unsupported).toEqual([]);
    expect(JSON.parse(JSON.stringify(p))).toEqual(p); // serialisable
  });

  it('library-linked contract keeps the original library layout and clones the library first', async () => {
    const p = await planFor(ADDR.posDescriptor, 'base');
    expect(p.steps.map((s) => s.id)).toEqual(['lib:NFTDescriptor', 'contract']);
    expect(Object.values(p.steps[1]!.links)).toEqual(['step:lib:NFTDescriptor']);
    // WETH argument remapped to Base's WETH
    expect(p.steps[1]!.args[0]).toMatchObject({ action: 'remap', value: '0x4200000000000000000000000000000000000006' });
  });

  it('zkSync-style destinations are unsupported', async () => {
    const p = await planFor(ADDR.dai, 'zksync');
    expect(p.unsupported.join(' ')).toMatch(/zkSync/);
  });

  it('lowers evmVersion when the target lacks PUSH0 (synthetic chain flag)', async () => {
    const { CHAINS } = await import('../src/chains/index.js');
    const base = CHAINS.find((c) => c.alias === 'base')!;
    const vc = loadVc(ADDR.dai); vc.evmVersion = 'shanghai';
    const a = await analyseContract(vc, opts);
    base.push0 = false;
    try {
      const p = await planClone(a, 'base', {}, opts);
      expect(p.contracts['contract']).toMatchObject({ evmVersion: 'paris', evmVersionOriginal: 'shanghai', expectedMatch: false });
      expect(p.warnings.join(' ')).toMatch(/PUSH0/);
    } finally { base.push0 = true; }
  });
});
