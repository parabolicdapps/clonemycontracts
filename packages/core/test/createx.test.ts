import { describe, expect, it } from 'vitest';
import { analyseContract } from '../src/analyse/index.js';
import { CREATEX, computeCreate2, computeCreate3, guardSalt, makeSalt, normaliseSalt } from '../src/deploy/index.js';
import { planClone } from '../src/plan/index.js';
import type { Address } from '../src/types.js';
import { ADDR, loadVc, offlineExplorer, stubReader } from './helpers.js';

const DEPLOYER = '0x1234567890123456789012345678901234567890' as Address;
const opts = { reader: stubReader(), ...offlineExplorer, targetReader: { getCode: async () => '0x6080' as `0x${string}` } };

describe('CreateX salts (address prediction itself is verified on a fork: create2.live.test.ts)', () => {
  it('lays out 20 bytes sender-or-zero | 1 byte flag | 11 bytes entropy', () => {
    expect(makeSalt('abc', DEPLOYER)).toBe(`0x${DEPLOYER.slice(2).toLowerCase()}00${'abc'.padStart(22, '0')}`);
    expect(makeSalt('abc', null)).toBe(`0x${'0'.repeat(40)}00${'abc'.padStart(22, '0')}`);
    expect(normaliseSalt(`0x${'ab'.repeat(32)}`, DEPLOYER)).toEqual({ salt: `0x${'ab'.repeat(32)}`, wrapped: false });
    expect(normaliseSalt('0x01', null).wrapped).toBe(true);
    expect(() => normaliseSalt('zz', null)).toThrow(/not hex/);
    expect(() => makeSalt('0'.repeat(24), null)).toThrow(/at most 11 bytes/);
  });
  it('mirrors CreateX _guard and rejects the salts CreateX rejects', () => {
    expect(() => guardSalt(`0x${DEPLOYER.slice(2)}05${'0'.repeat(22)}`, DEPLOYER, 1)).toThrow(/rejects/);
    expect(() => guardSalt(`0x${'0'.repeat(40)}05${'0'.repeat(22)}`, DEPLOYER, 1)).toThrow(/rejects/);
    // chain-id mixing changes the guarded salt per chain; flag 00 does not
    const s01 = `0x${'0'.repeat(40)}01${'0'.repeat(22)}` as const, s00 = `0x${'0'.repeat(40)}00${'0'.repeat(22)}` as const;
    expect(guardSalt(s01, null, 1)).not.toBe(guardSalt(s01, null, 8453));
    expect(guardSalt(s00, null, 1)).toBe(guardSalt(s00, null, 8453));
    expect(computeCreate3(CREATEX, guardSalt(s00, null, 1))).toBe(computeCreate3(CREATEX, guardSalt(s00, null, 8453)));
    expect(computeCreate2(CREATEX, guardSalt(s00, null, 1), '0x00')).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });
});

describe('plan with CREATE2 / CREATE3', () => {
  it('predicts an address per step, checks CreateX on the target and explains the caveats', async () => {
    const a = await analyseContract(loadVc(ADDR.dai), opts);
    const p = await planClone(a, 'base', {}, { ...opts, create2: { deployer: DEPLOYER } });
    expect(p.create2).toMatchObject({ mode: 'create2', factory: CREATEX, factoryVerified: true, saltDerived: true, deployer: DEPLOYER });
    expect(p.create2!.salt.startsWith(`0x${DEPLOYER.slice(2).toLowerCase()}00`)).toBe(true);
    expect(p.steps[0]!.create2!.predictedAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(p.steps[0]!.create2!.initCodeHash).toMatch(/^0x[0-9a-f]{64}$/);
    const w = p.warnings.join('\n');
    expect(w).toMatch(/byte-identical/);
    expect(w).toMatch(/--create3/);
    expect(w).toMatch(/CreateX as msg\.sender/);
    // deterministic: same inputs, same address; different chain id argument -> different CREATE2 address, same CREATE3 address
    const again = await planClone(a, 'base', {}, { ...opts, create2: { deployer: DEPLOYER } });
    expect(again.steps[0]!.create2!.predictedAddress).toBe(p.steps[0]!.create2!.predictedAddress);
    const arb = await planClone(a, 'arbitrum', {}, { ...opts, create2: { deployer: DEPLOYER } });
    expect(arb.steps[0]!.create2!.predictedAddress).not.toBe(p.steps[0]!.create2!.predictedAddress);
    const c3 = await planClone(a, 'base', {}, { ...opts, create2: { mode: 'create3', deployer: DEPLOYER } });
    const c3arb = await planClone(a, 'arbitrum', {}, { ...opts, create2: { mode: 'create3', deployer: DEPLOYER } });
    expect(c3.steps[0]!.create2!.predictedAddress).toBe(c3arb.steps[0]!.create2!.predictedAddress);
    expect(c3.steps[0]!.create2!.predictedAddress).not.toBe(p.steps[0]!.create2!.predictedAddress);
  }, 60_000);

  it('unsupported when CreateX has no code on the target; warns when no key binds the salt', async () => {
    const a = await analyseContract(loadVc(ADDR.dai), opts);
    const p = await planClone(a, 'base', {}, { ...opts, targetReader: { getCode: async () => '0x' as `0x${string}` }, create2: {} });
    expect(p.create2!.factoryVerified).toBe(false);
    expect(p.unsupported.join(' ')).toMatch(/CreateX .* has no code on Base/);
    expect(p.warnings.join(' ')).toMatch(/not bound to your deployer/);
  }, 60_000);

  it('CREATE3 cannot place several contracts with one salt', async () => {
    const a = await analyseContract(loadVc(ADDR.usdcProxy), { ...opts, fetchImplementation: async (c, x) => (await import('./helpers.js')).fetchFixture(c, x) });
    const p = await planClone(a, 'base', {}, { ...opts, fetchContract: (await import('./helpers.js')).fetchFixture, create2: { mode: 'create3', deployer: DEPLOYER } });
    expect(p.unsupported.join(' ')).toMatch(/CREATE3 gives one address per salt/);
  }, 60_000);
});

