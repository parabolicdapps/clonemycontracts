import { describe, expect, it } from 'vitest';
import { capEvmVersion, scanAssembly, scanSourceFeatures, unsupportedOnTarget } from '../src/analyse/evm.js';
import { analyseContract } from '../src/analyse/index.js';
import { CHAINS, getChain } from '../src/chains/index.js';
import { compileContract } from '../src/compile/index.js';
import { compileStep } from '../src/deploy/execute.js';
import { planClone } from '../src/plan/index.js';
import { CmcError, type ClonePlan, type StdJsonInput } from '../src/types.js';
import { ADDR, fetchFixture, loadVc, offlineExplorer, stubReader } from './helpers.js';

const SRC = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
contract T {
  uint256 public x;
  function copy(bytes memory a) public pure returns (bytes memory b) { b = new bytes(a.length); assembly { mcopy(add(b, 32), add(a, 32), mload(a)) } }
  function ts(uint256 v) public { assembly { tstore(0, v) } x = v; }
}`;
const std = (evm: string): StdJsonInput => ({ language: 'Solidity', sources: { 'T.sol': { content: SRC } }, settings: { evmVersion: evm, optimizer: { enabled: false, runs: 200 } } });
const SOLC = '0.8.28+commit.7893614a';

describe('EVM feature detection', () => {
  it('finds MCOPY/TSTORE in solc legacy assembly (cancun) and not for plain code', async () => {
    const c = await compileContract({ compilerVersion: SOLC, stdJsonInput: std('cancun'), contract: 'T', assembly: true });
    expect(c.features).toEqual(expect.arrayContaining(['MCOPY', 'TSTORE']));
    const plain = await compileContract({ compilerVersion: SOLC, stdJsonInput: { ...std('paris'), sources: { 'T.sol': { content: 'pragma solidity ^0.8.24; contract T { uint public x; function s(uint v) public { x = v; } }' } } }, contract: 'T', assembly: true });
    expect(plain.features).toEqual([]);
    const shanghai = await compileContract({ compilerVersion: SOLC, stdJsonInput: { ...std('shanghai'), sources: { 'T.sol': { content: 'pragma solidity ^0.8.24; contract T { uint public x; function s(uint v) public { x = v; } }' } } }, contract: 'T', assembly: true });
    expect(shanghai.features).toEqual(['PUSH0']);
  }, 120_000);

  it('scanAssembly walks sub-assemblies', () => {
    expect([...scanAssembly({ '.code': [{ name: 'PUSH' }], '.data': { 0: { '.code': [{ name: 'TLOAD' }, { name: 'BLOBHASH' }], '.data': {} } } })].sort()).toEqual(['BLOBHASH', 'TLOAD']);
  });

  it('scans source for hints (assembly calls, prevrandao, transient), ignoring comments', () => {
    const hits = scanSourceFeatures({ 'a.sol': { content: 'contract A { uint256 transient t; function f() { uint r = block.prevrandao; assembly { mcopy(0,0,0) } } // tstore(0,0)\n }' } });
    expect(hits.map((h) => h.feature).sort()).toEqual(['MCOPY', 'PREVRANDAO', 'TSTORE']);
  });

  it('target limits: per-opcode probe results beat the hardfork label; unknown targets are not guessed', () => {
    expect(unsupportedOnTarget(['PUSH0', 'MCOPY'], { push0: false })).toEqual([{ feature: 'PUSH0', needs: 'shanghai', certain: true }]);
    expect(unsupportedOnTarget(['MCOPY', 'TSTORE'], { push0: true, latestHardfork: 'shanghai' }).map((b) => b.feature)).toEqual(['MCOPY', 'TSTORE']);
    expect(unsupportedOnTarget(['MCOPY', 'BLOBHASH'], { push0: true, latestHardfork: 'osaka', opcodes: { MCOPY: true, BLOBHASH: false } }).map((b) => b.feature)).toEqual(['BLOBHASH']);
    expect(unsupportedOnTarget(['MCOPY'], { push0: true, latestHardfork: null })).toEqual([]); // cannot verify -> no claim
    expect(capEvmVersion('prague', 'cancun')).toBe('cancun');
    expect(capEvmVersion('paris', 'cancun')).toBe('paris');
    expect(capEvmVersion('prague', null)).toBe('prague');
  });

  it('planner lowers the evmVersion to the chain\'s verified hardfork, with a warning', async () => {
    const vc = loadVc(ADDR.dai); vc.evmVersion = 'prague';
    const a = await analyseContract(vc, { reader: stubReader(), ...offlineExplorer });
    const base = CHAINS.find((c) => c.alias === 'base')!;
    const saved = base.latestHardfork;
    base.latestHardfork = 'cancun';
    try {
      const p = await planClone(a, 'base', {}, { reader: stubReader(), fetchContract: fetchFixture, ...offlineExplorer });
      expect(p.contracts['contract']).toMatchObject({ evmVersion: 'cancun', evmVersionOriginal: 'prague', expectedMatch: false });
      expect(p.warnings.join(' ')).toMatch(/lowered from prague to cancun because Base's latest verified hardfork is cancun/);
    } finally { base.latestHardfork = saved; }
  });

  it('refuses to compile code the target cannot run, instead of producing a broken deployment', async () => {
    const plan = { contracts: { contract: { name: 'T', fullyQualifiedName: 'T.sol:T', compilerVersion: SOLC, evmVersion: 'cancun', stdJsonInput: std('cancun') } }, steps: [] } as unknown as ClonePlan;
    const step = { id: 'contract', contractKey: 'contract' } as ClonePlan['steps'][number];
    const shanghaiOnly = { ...getChain('base'), latestHardfork: 'shanghai', opcodes: undefined };
    const err = await compileStep(plan, step, shanghaiOnly).catch((e) => e);
    expect(err).toBeInstanceOf(CmcError);
    expect(err.message).toMatch(/compiles to code using .*MCOPY.*Base is verified only up to shanghai/);
    // with a target that runs cancun it compiles
    await expect(compileStep(plan, step, { ...getChain('base'), latestHardfork: 'cancun', opcodes: undefined })).resolves.toMatchObject({ features: expect.arrayContaining(['MCOPY']) });
    // blob opcodes missing on a chain (Polygon-style) are caught from the compiled assembly even though the hardfork label is high
    const blob = { contracts: { contract: { ...plan.contracts.contract, evmVersion: 'cancun', stdJsonInput: { ...std('cancun'), sources: { 'T.sol': { content: 'pragma solidity ^0.8.24; contract T { function h() public view returns (bytes32 r) { assembly { r := blobhash(0) } } }' } } } } }, steps: [] } as unknown as ClonePlan;
    const polygonLike = { ...getChain('polygon'), latestHardfork: 'osaka', opcodes: { BLOBHASH: false } };
    await expect(compileStep(blob, step, polygonLike)).rejects.toThrow(/BLOBHASH/);
  }, 180_000);
});
