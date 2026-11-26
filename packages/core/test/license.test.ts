import { describe, expect, it } from 'vitest';
import { analyseContract, classifyLicense, detectSourceLicenses, licenseReport, licenseWarnings, normaliseProviderLicense, summariseLicenseIds } from '../src/analyse/index.js';
import { normaliseEtherscan } from '../src/fetch/etherscan.js';
import { planClone } from '../src/plan/index.js';
import type { Address, VerifiedContract } from '../src/types.js';
import { ADDR, fx, loadVc, offlineExplorer, stubReader } from './helpers.js';

interface Rec { name: string; language: string; compilerVersion: string; fullyQualifiedName: string | null; implementations: string[]; sources: Record<string, { content: string }> }
const rec = fx('license-headers-1.json') as Record<string, Rec>;

/** A verified contract that carries the recorded (header-only) sources of a real contract. */
const recorded = (key: string, address: string): VerifiedContract => {
  const r = rec[key]!;
  return {
    address: address as Address, chainId: 1, name: r.name, fullyQualifiedName: r.fullyQualifiedName, compilerVersion: r.compilerVersion, language: 'Solidity',
    stdJsonInput: { language: 'Solidity', sources: r.sources, settings: {} }, evmVersion: null, optimizer: { enabled: true, runs: 200 }, abi: [], constructorArgs: '0x', libraries: {},
    creationTxHash: null, license: null, proxy: { isProxy: false, type: null, implementations: [] }, immutableReferences: {}, matchType: null, provider: 'sourcify', attempts: [],
  };
};
const ids = (key: string) => detectSourceLicenses(rec[key]!.sources, rec[key]!.fullyQualifiedName?.split(':')[0]).ids;

describe('licence expressions', () => {
  it.each([
    ['MIT OR GPL-3.0', 'permissive'], ['GPL-2.0-or-later', 'copyleft'], ['MIT AND BUSL-1.1', 'restricted'], ['(MIT OR Apache-2.0)', 'permissive'],
    ['GPL-2.0 WITH Classpath-exception-2.0', 'copyleft'], ['CC0-1.0', 'permissive'], ['BUSL-1.1', 'restricted'], ['UNLICENSED', 'none-or-unknown'], ['Permit', 'none-or-unknown'],
  ])('%s -> %s', (id, cls) => expect(classifyLicense(id).class).toBe(cls));
});

describe('provider licence fields', () => {
  it.each([
    ['MIT License (MIT)', 'MIT'], ['Business Source License 1.1 (BUSL-1.1)', 'BUSL-1.1'], ['GNU GPLv3 (GPL-3.0)', 'GPL-3.0'], ['No License (None)', null], ['Unknown', null], ['none', null], ['Apache-2.0', 'Apache-2.0'],
  ])('%s -> %s', (raw, id) => expect(normaliseProviderLicense(raw)).toBe(id));
  it('an Etherscan LicenseType counts next to the files, and wins when it is the stricter one', async () => {
    const item = fx('etherscan-single-1.json').result[0];
    const vc = normaliseEtherscan({ ...item, LicenseType: 'Business Source License 1.1 (BUSL-1.1)' }, 1, ADDR.dai);
    const a = await analyseContract(vc, { reader: stubReader(), ...offlineExplorer });
    expect(a.license).toMatchObject({ id: 'BUSL-1.1', class: 'restricted' });
    expect(a.license.ids).toEqual(expect.arrayContaining(['BUSL-1.1']));
  });
});

describe('detection in sources (recorded headers of real contracts)', () => {
  it('SPDX tags anywhere in a file, not only on the first line', () => {
    const d = detectSourceLicenses({ 'a.sol': { content: `/*\n * Copyright\n */\n\n// some notes\n// SPDX-License-Identifier: BUSL-1.1\npragma solidity 0.8.0;` }, 'b.sol': { content: 'contract B {}' } });
    expect(d.ids).toEqual(['BUSL-1.1']);
    expect(d.byFile).toEqual({ 'a.sol': 'BUSL-1.1' });
  });
  it('well-known header texts when there is no tag: detects AGPL-3.0 and GPL-3.0', () => {
    expect(detectSourceLicenses({
      'a.sol': { content: '// GNU Affero General Public License ... version 3' },
      'b.sol': { content: '// GNU General Public License ... version 3' },
    }).ids).toEqual(['AGPL-3.0', 'GPL-3.0']);
  });
  it('header text with a version: GPL v2 is not read as v3', () => {
    expect(detectSourceLicenses({ 'x.sol': { content: '// This program is free software; GNU General Public License as published by the Free Software Foundation; either version 2 of the License' } }).ids).toEqual(['GPL-2.0']);
  });
  it('multi-file sources list every distinct licence; the most restrictive one wins', () => {
    expect(ids('eigenPodManagerImpl')).toEqual(expect.arrayContaining(['BUSL-1.1', 'MIT', 'CC0-1.0']));
    expect(summariseLicenseIds(ids('eigenPodManagerImpl'))).toMatchObject({ id: 'BUSL-1.1', class: 'restricted' });
    expect(summariseLicenseIds(ids('lidoImpl'))).toMatchObject({ id: 'GPL-3.0', class: 'copyleft', ids: expect.arrayContaining(['GPL-3.0', 'MIT']) });
    expect(summariseLicenseIds(['MIT', 'Apache-2.0'])).toMatchObject({ class: 'permissive' });
  });
  it('files with no licence information do not decide the verdict', () => {
    expect(ids('lidoProxy' in rec ? 'lidoProxy' : 'lido')).toEqual([]);
  });
  it('the USDC implementation lists MIT and Apache-2.0', async () => {
    const a = await analyseContract(loadVc(ADDR.usdcImpl), { reader: stubReader(), ...offlineExplorer });
    expect(a.license.ids).toEqual(expect.arrayContaining(['Apache-2.0', 'MIT']));
    expect(a.license.class).toBe('permissive');
  });
});

describe('a licence per contract and the most restrictive overall (proxy masking)', () => {
  const eigenProxy = { ...recorded('eigenPodManager', '0x91E677b07F7AF907ec9a428aafA9fc14a0d3A338'), proxy: { isProxy: true, type: 'EIP-1967', implementations: ['0xd22dd829779ADBf3869fb224F703452f7F95E9dB' as Address] } };
  const eigenImpl = recorded('eigenPodManagerImpl', '0xd22dd829779ADBf3869fb224F703452f7F95E9dB');
  const opts = { reader: stubReader(), fetchImplementation: async () => eigenImpl, ...offlineExplorer };

  it('EigenPodManager: the MIT proxy no longer hides the BUSL implementation', async () => {
    const a = await analyseContract(eigenProxy, opts);
    expect(a.license).toMatchObject({ id: 'MIT', class: 'permissive' }); // the proxy on its own
    const r = licenseReport(a);
    expect(r.overall).toMatchObject({ id: 'BUSL-1.1', class: 'restricted' });
    expect(r.contracts.map((c) => [c.role, c.id, c.class])).toEqual([['proxy', 'MIT', 'permissive'], ['implementation', 'BUSL-1.1', 'restricted']]);
    const w = licenseWarnings(r);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/^EigenPodManager \(implementation\): Source is BUSL-1.1/);
  });
  it('the plan carries the same: overall licence, one per contract, and the BUSL warning', async () => {
    const a = await analyseContract(eigenProxy, opts);
    const p = await planClone(a, 'base', {}, { ...opts, fetchContract: async () => eigenImpl });
    expect(p.license).toMatchObject({ id: 'BUSL-1.1', class: 'restricted' });
    expect(p.licenses!.map((l) => l.role)).toEqual(['implementation', 'proxy']);
    expect(p.warnings.filter((w) => /BUSL-1\.1/.test(w))).toHaveLength(1);
  });
  it('USDC: the flattened proxy shell declares nothing; the implementation is Apache/MIT, so nothing is "none"', async () => {
    const a = await analyseContract(loadVc(ADDR.usdcProxy), { reader: stubReader(), fetchImplementation: async () => loadVc(ADDR.usdcImpl), ...offlineExplorer });
    const r = licenseReport(a);
    expect(r.overall.class).toBe('permissive');
    expect(r.overall.ids).toEqual(expect.arrayContaining(['Apache-2.0', 'MIT']));
    expect(licenseWarnings(r)).toEqual([]);
  });
  it('Lido: the unlicensed proxy shell is ignored; the implementation is GPL-3.0 (copyleft)', async () => {
    const proxy = { ...recorded('lido', '0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84'), proxy: { isProxy: true, type: 'AragonOS', implementations: ['0x028271E30a695c0527A0C50cA30603feD004cDb0' as Address] } };
    const a = await analyseContract(proxy, { reader: stubReader(), fetchImplementation: async () => recorded('lidoImpl', '0x028271E30a695c0527A0C50cA30603feD004cDb0'), ...offlineExplorer });
    expect(licenseReport(a).overall).toMatchObject({ id: 'GPL-3.0', class: 'copyleft' });
  });
  it('libraries get their own entry when their source can be read', async () => {
    const lib = { ...recorded('eigenPodManagerImpl', ADDR.sigChecker), name: 'SigLib' };
    const base = loadVc(ADDR.usdcImpl);
    const a = await analyseContract({ ...base, libraries: { 'x.sol': { SigLib: ADDR.sigChecker } } }, { reader: stubReader(), fetchLibrary: async () => lib, ...offlineExplorer });
    const r = licenseReport(a);
    expect(r.contracts.find((c) => c.role === 'library')).toMatchObject({ name: 'SigLib', id: 'BUSL-1.1', class: 'restricted' });
    expect(r.overall.class).toBe('restricted');
  });
  it('nothing declared anywhere: unknown, with one warning', async () => {
    const a = await analyseContract({ ...recorded('lido', ADDR.dai) }, { reader: stubReader(), ...offlineExplorer });
    const r = licenseReport(a);
    expect(r.overall).toMatchObject({ id: null, class: 'none-or-unknown' });
    expect(licenseWarnings(r)).toHaveLength(1);
  });
});
