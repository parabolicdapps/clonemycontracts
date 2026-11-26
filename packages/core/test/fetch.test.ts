import { describe, expect, it } from 'vitest';
import { normaliseBlockscout, normaliseEtherscan, normaliseSourcify, parseEtherscanSource, parseLibraryField } from '../src/fetch/index.js';
import { ADDR, fx, loadVc } from './helpers.js';

describe('Sourcify normalisation', () => {
  it('plain contract (DAI)', () => {
    const c = loadVc(ADDR.dai);
    expect(c.name).toBe('Dai');
    expect(c.compilerVersion).toBe('0.5.12+commit.7709ece9');
    expect(c.evmVersion).toBe('petersburg');
    expect(c.optimizer).toEqual({ enabled: false, runs: 200 });
    expect(c.constructorArgs).toMatch(/^0x0{63}1$/);
    expect(c.proxy.isProxy).toBe(false);
    expect(c.provider).toBe('sourcify');
    expect(c.creationTxHash).toMatch(/^0x[0-9a-f]{64}$/);
  });
  it('proxy with implementation (FiatTokenProxy)', () => {
    const c = loadVc(ADDR.usdcProxy);
    expect(c.proxy).toEqual({ isProxy: true, type: 'ZeppelinOSProxy', implementations: [ADDR.usdcImpl] });
    expect(c.constructorArgs).toContain('0882477e7895bdc5cea7cb1552ed914ab157fe56');
  });
  it('library-linked contract', () => {
    const c = loadVc(ADDR.posDescriptor);
    expect(c.libraries['contracts/libraries/NFTDescriptor.sol']?.NFTDescriptor).toBe('0x42b24a95702b9986e82d421cc3568932790a48ec');
    expect(Object.keys(c.immutableReferences).length).toBe(1);
  });
  it('constructor args with addresses and immutables (UniswapV2Router02)', () => {
    const c = loadVc(ADDR.router);
    expect(c.abi.find((i) => i.type === 'constructor')?.inputs?.map((i) => i.name)).toEqual(['_factory', '_WETH']);
    expect(c.constructorArgs!.length).toBe(2 + 128);
    expect(Object.keys(c.immutableReferences).length).toBe(2);
    expect(c.license).toBe('MIT');
    expect(normaliseSourcify({ ...fx('sourcify-univ2router02-1.json'), stdJsonInput: { language: 'Solidity', sources: { 'A.sol': { content: 'contract A {}' } }, settings: {} } }, 1, ADDR.router).license).toBeNull();
  });
});

describe('Etherscan SourceCode shapes', () => {
  it('shape 1: single flattened file', () => {
    const item = fx('etherscan-single-1.json').result[0];
    expect(parseEtherscanSource(item).shape).toBe('single');
    const c = normaliseEtherscan(item, 1, ADDR.dai);
    expect(Object.keys(c.stdJsonInput.sources)).toEqual(['Counter.sol']);
    expect(c.compilerVersion).toBe('0.8.19+commit.7dd6d404');
    expect(c.evmVersion).toBe('paris');
    expect(c.optimizer).toEqual({ enabled: true, runs: 200 });
    expect(c.constructorArgs).toMatch(/^0x0{24}5c69/);
    expect(c.license).toBe('MIT License (MIT)');
    expect(c.proxy.isProxy).toBe(false);
  });
  it('shape 2: {{ standard json }}', () => {
    const item = fx('etherscan-standardjson-1.json').result[0];
    expect(parseEtherscanSource(item).shape).toBe('standard-json');
    const c = normaliseEtherscan(item, 1, ADDR.router);
    expect(c.name).toBe('UniswapV2Router02');
    expect(c.fullyQualifiedName).toBe('contracts/UniswapV2Router02.sol:UniswapV2Router02');
    expect(Object.keys(c.stdJsonInput.sources).length).toBeGreaterThanOrEqual(1);
    expect(c.optimizer.runs).toBe(999999);
    expect(c.constructorArgs!.length).toBe(2 + 128);
  });
  it('shape 3: multi-file JSON map, libraries and proxy fields', () => {
    const raw = fx('etherscan-multifile-1.json').result[0];
    expect(parseEtherscanSource(raw).shape).toBe('multi-file');
    const c = normaliseEtherscan({ ...raw, Proxy: '1', Implementation: ADDR.usdcImpl }, 1, ADDR.usdcProxy);
    expect(Object.keys(c.stdJsonInput.sources).length).toBeGreaterThan(3);
    expect(c.libraries).toEqual({ '': { SignatureChecker: ADDR.sigChecker } });
    expect(c.proxy).toEqual({ isProxy: true, type: 'etherscan-flag', implementations: [ADDR.usdcImpl] });
    expect(c.license).toBe('Apache-2.0');
    expect(c.constructorArgs).toBe('0x');
  });
  it('parses the Library field', () => {
    expect(parseLibraryField('A:0x800c32EAa2a6C93CF4Cb51794450eD77fBFBB172;B:0x42B24A95702b9986e82d421cC3568932790A48Ec')['']).toEqual({
      A: '0x800c32EAa2a6C93CF4Cb51794450eD77fBFBB172', B: '0x42B24A95702b9986e82d421cC3568932790A48Ec',
    });
    expect(parseLibraryField('')).toEqual({});
  });
});

describe('Blockscout normalisation', () => {
  it('UniswapV2Router02 from a recorded eth.blockscout.com response', () => {
    const c = normaliseBlockscout(fx('blockscout-univ2router02-1.json'), 1, ADDR.router);
    expect(c.name).toBe('UniswapV2Router02');
    expect(c.compilerVersion).toBe('0.6.6+commit.6c089d02');
    expect(c.optimizer).toEqual({ enabled: true, runs: 999999 });
    expect(c.evmVersion).toBeNull(); // "default"
    expect(c.constructorArgs).toContain('5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f');
    expect(Object.keys(c.stdJsonInput.sources)).toContain('contracts/UniswapV2Router02.sol');
    expect(c.provider).toBe('blockscout');
  });
});
