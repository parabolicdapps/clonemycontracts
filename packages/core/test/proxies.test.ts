import { describe, expect, it } from 'vitest';
import { encodeAbiParameters } from 'viem';
import { analyseContract, analyseMinimalProxy, type ChainReader } from '../src/analyse/index.js';
import { BEACON_SLOT, SEL_BEACON_IMPLEMENTATION, SEL_FACET_ADDRESSES, minimalProxyInitCode, parseMinimalProxy } from '../src/analyse/proxies.js';
import { planClone } from '../src/plan/index.js';
import { normaliseSourcify } from '../src/fetch/sourcify.js';
import type { Address, Hex } from '../src/types.js';
import { fx, offlineExplorer, stubReader } from './helpers.js';

const BEACON_PROXY = '0x377f6953151BE60f7e49B7b84313cf2827B0F9A0' as Address;
const BEACON = '0xc9a4e953d67aBFE6611726d1a70673f10B92A745' as Address;
const BEACON_IMPL = '0x3Aeb42653455B749aa6807Bcc57B9999052010ea' as Address;
const CLONE = '0xc203C3184D2D38A66bb52C1B08d587AAaD555600' as Address;
const DELAY_IMPL = '0xd54895B1121A2eE3f37b502F507631FA1331BED6' as Address;
const files: Record<string, string> = {
  [BEACON_PROXY]: 'sourcify-beaconproxy-1.json', [BEACON]: 'sourcify-beacon-1.json', [BEACON_IMPL]: 'sourcify-beacon-impl-collateral-1.json', [DELAY_IMPL]: 'sourcify-zodiac-delay-impl-1.json',
};
const load = async (chainId: number, a: Address) => normaliseSourcify(fx(files[a]!), chainId, a);
const word = (a: Address) => `0x${'0'.repeat(24)}${a.slice(2).toLowerCase()}` as Hex;
const base = { fetchImplementation: load, fetchContract: load, ...offlineExplorer };

describe('beacon proxies', () => {
  const reader: ChainReader = {
    ...stubReader(['0x0000000000000000000000000000000000000001']),
    getStorageAt: async (a, slot) => (a === BEACON_PROXY && slot === BEACON_SLOT ? word(BEACON) : (`0x${'0'.repeat(64)}` as Hex)),
    call: async (to, data) => (to === BEACON && data === SEL_BEACON_IMPLEMENTATION ? word(BEACON_IMPL) : undefined),
  };

  it('resolves proxy -> beacon -> implementation', async () => {
    const a = await analyseContract(await load(1, BEACON_PROXY), { ...base, reader });
    expect(a.proxy).toMatchObject({ isProxy: true, type: 'EIP-1967 beacon', implementations: [BEACON_IMPL] });
    expect(a.beacon!.contract.name).toBe('Beacon');
    expect(a.implementation!.contract.name).toBe('Collateral');
    expect(a.initialisation!.constructorCall).toMatchObject({ function: 'initialize', signature: 'initialize(string,address)' });
  });

  it('plans implementation -> beacon -> proxy, wiring the beacon and the beacon implementation to the clones', async () => {
    const a = await analyseContract(await load(1, BEACON_PROXY), { ...base, reader });
    const p = await planClone(a, 'base', {}, { ...base, reader });
    expect(p.steps.map((s) => [s.id, s.kind])).toEqual([['implementation', 'implementation'], ['beacon', 'beacon'], ['proxy', 'proxy']]);
    const beacon = p.steps[1]!;
    expect(beacon.args.find((x) => /impl/i.test(x.name))).toMatchObject({ action: 'remap', value: { $ref: 'step:implementation' } });
    expect(beacon.label).toBe('Deploy beacon Beacon');
    const proxy = p.steps[2]!;
    expect(proxy.args.find((x) => /beacon/i.test(x.name))).toMatchObject({ action: 'remap', value: { $ref: 'step:beacon' } });
    expect(proxy.dependsOn).toContain('beacon');
    expect(p.warnings.join(' ')).toMatch(/Beacon proxy/);
    expect(p.unsupported).toEqual([]);
  });
});

describe('EIP-1167 minimal proxies', () => {
  const code = `0x363d3d373d3d3d363d73${DELAY_IMPL.slice(2).toLowerCase()}5af43d82803e903d91602b57fd5bf3` as Hex;
  const reader: ChainReader = { ...stubReader(), getCode: async (a) => (a === CLONE ? code : ('0x6080' as Hex)) };

  it('parses canonical and vanity variants and rebuilds the init code', () => {
    expect(parseMinimalProxy(code)).toBe(DELAY_IMPL);
    expect(parseMinimalProxy(`0x3d3d3d3d363d3d37363d73${DELAY_IMPL.slice(2).toLowerCase()}5af43d3d93803e602a57fd5bf3`)).toBe(DELAY_IMPL);
    expect(parseMinimalProxy('0x6080')).toBeNull();
    expect(minimalProxyInitCode(DELAY_IMPL)).toBe(`0x3d602d80600a3d3981f3363d3d373d3d3d363d73${DELAY_IMPL.slice(2).toLowerCase()}5af43d82803e903d91602b57fd5bf3`);
  });

  it('clones the implementation, then deploys a new minimal proxy; the initialiser is detected from the ABI', async () => {
    const a = (await analyseMinimalProxy(CLONE, 'eth', { ...base, reader }))!;
    expect(a.minimalProxy).toEqual({ standard: 'EIP-1167' });
    expect(a.implementation!.contract.name).toBe('Delay');
    const p = await planClone(a, 'base', {}, { ...base, reader });
    expect(p.steps.map((s) => [s.id, s.kind])).toEqual([['implementation', 'implementation'], ['minimal-proxy', 'minimal-proxy'], ['init:setUp', 'initialise']]);
    expect(p.steps[1]).toMatchObject({ label: 'Deploy EIP-1167 minimal proxy MinimalProxy', dependsOn: ['implementation'], args: [] });
    expect(p.steps[2]!.call).toMatchObject({ target: 'minimal-proxy', optional: false, discovered: false });
    expect(Object.keys(p.contracts)).toEqual(['implementation']);
    expect(p.warnings.join(' ')).toMatch(/Front-running/);
  });
});

describe('diamonds', () => {
  it('are flagged unsupported when the loupe answers', async () => {
    const vc = await load(1, BEACON);
    const reader: ChainReader = {
      ...stubReader(),
      call: async (_to, data) => (data === SEL_FACET_ADDRESSES ? encodeAbiParameters([{ type: 'address[]' }], [[BEACON, BEACON_IMPL]]) : undefined),
    };
    const a = await analyseContract(vc, { ...base, reader });
    expect(a.unsupported.join(' ')).toMatch(/EIP-2535 diamond/);
    const p = await planClone(a, 'base', {}, { ...base, reader });
    expect(p.unsupported.join(' ')).toMatch(/diamond/);
  });
});
