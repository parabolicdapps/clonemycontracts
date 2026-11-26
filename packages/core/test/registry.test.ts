import { describe, expect, it } from 'vitest';
import { getAddress } from 'viem';
import { CHAINS, counterpartOf, findWellKnown } from '../src/chains/index.js';
import { EVM_VERSIONS } from '../src/analyse/evm.js';

describe('chain registry', () => {
  it('hardfork and opcode facts are consistent', () => {
    for (const c of CHAINS.filter((x) => x.kind === 'evm')) {
      expect(c.latestHardfork === null || EVM_VERSIONS.includes(c.latestHardfork as never), c.alias).toBe(true);
      if (c.latestHardfork) expect(c.opcodes, c.alias).toBeDefined();
      if (c.opcodes) expect(c.opcodes.PUSH0, `${c.alias} push0 flag agrees with the opcode probe`).toBe(c.push0);
    }
    expect(CHAINS.find((c) => c.alias === 'polygon')!.opcodes).toMatchObject({ MCOPY: true, BLOBHASH: false });
  });

  it('Chainlink feeds are checksummed, have decimals, and known addresses match Chainlink docs', () => {
    const withFeeds = CHAINS.filter((c) => c.chainlinkFeeds);
    expect(withFeeds.length).toBeGreaterThanOrEqual(10);
    for (const c of withFeeds) {
      for (const [pair, f] of Object.entries(c.chainlinkFeeds!)) {
        expect(f.address, `${c.alias} ${pair}`).toBe(getAddress(f.address));
        expect(f.decimals).toBeGreaterThan(0);
        expect(pair).toMatch(/^[A-Za-z0-9.]+ \/ [A-Za-z0-9.]+$/);
      }
    }
    const feed = (alias: string, pair: string) => CHAINS.find((c) => c.alias === alias)!.chainlinkFeeds![pair]!.address;
    expect(feed('eth', 'ETH / USD')).toBe('0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419');
    expect(feed('eth', 'BTC / USD')).toBe('0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c');
    expect(feed('arbitrum', 'ETH / USD')).toBe('0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612');
    expect(feed('arbitrum', 'USDC / USD')).toBe('0x50834F3163758fcC1Df9973b6e91f0F0F0434aD3');
  });

  it('feeds are well-known addresses with cross-chain counterparts', () => {
    expect(findWellKnown('0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419', 1)).toEqual({ kind: 'chainlink:ETH / USD', label: 'Chainlink ETH / USD' });
    expect(counterpartOf('chainlink:ETH / USD', 42161)).toBe('0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612');
    expect(counterpartOf('chainlink:NOPE / USD', 42161)).toBeNull();
  });
});
