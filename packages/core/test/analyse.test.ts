import { describe, expect, it } from 'vitest';
import { analyseContract, classifyLicense, defaultEvmVersion, detectTokenStandards, requiresPush0, scanSourceLiterals } from '../src/analyse/index.js';
import { ADDR, fetchFixture, loadVc, offlineExplorer, stubReader } from './helpers.js';

describe('licence classification', () => {
  it.each([
    ['MIT', 'permissive'], ['Apache-2.0', 'permissive'], ['BSD-3-Clause', 'permissive'], ['MIT License (MIT)', 'permissive'], ['Unlicense', 'permissive'],
    ['GPL-3.0-or-later', 'copyleft'], ['AGPL-3.0', 'copyleft'], ['GNU LGPLv3', 'copyleft'], ['MPL-2.0', 'copyleft'],
    ['BUSL-1.1', 'restricted'], ['Business Source License 1.1', 'restricted'], ['SEE LICENSE IN LICENSE.md', 'restricted'],
    ['UNLICENSED', 'none-or-unknown'], ['No License (None)', 'none-or-unknown'], [null, 'none-or-unknown'],
  ])('%s -> %s', (id, cls) => {
    expect(classifyLicense(id as string | null).class).toBe(cls);
  });
});

describe('EVM version logic', () => {
  it('solc defaults', () => {
    expect(defaultEvmVersion('0.8.20+commit.a1b79de6')).toBe('shanghai');
    expect(defaultEvmVersion('0.8.19')).toBe('paris');
    expect(defaultEvmVersion('0.8.25')).toBe('cancun');
    expect(defaultEvmVersion('0.6.12')).toBe('istanbul');
    expect(defaultEvmVersion('0.4.24')).toBe('byzantium');
  });
  it('PUSH0', () => {
    expect(requiresPush0('shanghai')).toBe(true);
    expect(requiresPush0('cancun')).toBe(true);
    expect(requiresPush0('paris')).toBe(false);
  });
});

describe('analysis', () => {
  it('plain ERC-20 with chain-id constructor arg', async () => {
    const a = await analyseContract(loadVc(ADDR.dai), { reader: stubReader() });
    expect(a.tokenStandards).toEqual(['ERC-20']);
    expect(a.constructorArgs).toEqual([expect.objectContaining({ name: 'chainId_', value: '1' })]);
    expect(a.proxy.isProxy).toBe(false);
    expect(a.unsupported).toEqual([]);
    expect(a.evm).toEqual({ effectiveEvmVersion: 'petersburg', needsPush0: false });
    expect(a.license).toMatchObject({ id: 'MIT', class: 'permissive' });
    const copyleft = await analyseContract({ ...loadVc(ADDR.dai), stdJsonInput: { language: 'Solidity', sources: { 'a.sol': { content: '// SPDX-License-Identifier: GPL-3.0\ncontract A {}' } }, settings: {} } }, { reader: stubReader() });
    expect(copyleft.warnings.join(' ')).toMatch(/licence/);
  });

  it('constructor addresses are classified (known WETH, known factory)', async () => {
    const a = await analyseContract(loadVc(ADDR.router), { reader: stubReader() });
    const ctor = a.addresses.filter((x) => x.where.startsWith('constructor'));
    expect(ctor.map((x) => [x.classification, x.kind])).toEqual([['wellknown', 'uniswap-v2-factory'], ['wellknown', 'wrapped-native']]);
    expect(ctor[1]!.counterparts?.['42161']).toBe('0x82aF49447D8a07e3bd95BD0d56f35241523fBab1');
    expect(a.immutableCount).toBe(2);
  });

  it('proxy: fetches implementation as a second contract, with its library', async () => {
    const a = await analyseContract(loadVc(ADDR.usdcProxy), { reader: stubReader(), fetchImplementation: fetchFixture, ...offlineExplorer });
    expect(a.proxy.isProxy).toBe(true);
    expect(a.implementation?.contract.name).toBe('FiatTokenV2_2');
    expect(a.implementation?.libraries).toEqual([{ file: '', name: 'SignatureChecker', address: '0x800c32eaa2a6c93cf4cb51794450ed77fbfbb172' }]);
    expect(a.tokenStandards).toContain('ERC-20'); // from the implementation ABI
    expect(a.warnings.join(' ')).toMatch(/Proxy storage is not copied/);
  });

  it('flags an unverified implementation as unsupported', async () => {
    const a = await analyseContract(loadVc(ADDR.usdcProxy), { reader: stubReader(), fetchImplementation: async () => { throw new Error('not verified'); }, ...offlineExplorer });
    expect(a.unsupported.join(' ')).toMatch(/implementation .* could not be fetched/);
  });

  it('Vyper is unsupported', async () => {
    const vc = { ...loadVc(ADDR.dai), language: 'Vyper' };
    const a = await analyseContract(vc, { reader: stubReader() });
    expect(a.unsupported[0]).toMatch(/Vyper/);
  });

  it('classifies literals in source (EOA vs contract)', async () => {
    const vc = loadVc(ADDR.dai);
    const lit = '0x1111111111111111111111111111111111111111';
    vc.stdJsonInput.sources['x.sol'] = { content: `address constant A = ${lit}; address constant Z = 0x0000000000000000000000000000000000000000;` };
    expect(scanSourceLiterals(vc.stdJsonInput.sources).map((x) => x.address)).toContain(lit);
    const a = await analyseContract(vc, { reader: stubReader([lit]) });
    expect(a.addresses.find((x) => x.address === lit)?.classification).toBe('eoa');
    expect(a.addresses.find((x) => /^0x0+$/.test(x.address))?.classification).toBe('zero');
  });
});

describe('token standards', () => {
  const fn = (name: string) => ({ type: 'function', name });
  it('detects 721, 1155, 4626', () => {
    expect(detectTokenStandards(['ownerOf', 'balanceOf', 'setApprovalForAll', 'isApprovedForAll', 'getApproved', 'approve', 'transferFrom'].map(fn))).toEqual(['ERC-721']);
    expect(detectTokenStandards(['balanceOfBatch', 'safeBatchTransferFrom', 'setApprovalForAll'].map(fn))).toEqual(['ERC-1155']);
    expect(detectTokenStandards(['totalSupply', 'balanceOf', 'transfer', 'transferFrom', 'approve', 'allowance', 'asset', 'convertToShares', 'convertToAssets', 'totalAssets', 'deposit', 'redeem'].map(fn))).toEqual(['ERC-20', 'ERC-4626']);
  });
});
