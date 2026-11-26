import { encodeAbiParameters } from 'viem';
import { describe, expect, it } from 'vitest';
import { analyseContract } from '../src/analyse/index.js';
import { planClone } from '../src/plan/index.js';
import type { Address, VerifiedContract } from '../src/types.js';
import { ADDR, loadVc, offlineExplorer, stubReader } from './helpers.js';

// constructor shaped like SwapRouter02 / WeETH / StrategyBaseTVLLimits: protocol contracts next to real role holders
const POSITION_MANAGER = '0xC36442b4a4522E871399CD717aBDD847Ab11FE88' as Address; // a contract on Ethereum
const ROLE_REGISTRY = '0x1111111111111111111111111111111111111111' as Address; // a contract
const ADMIN_CONTRACT = '0x2222222222222222222222222222222222222222' as Address; // a contract used as "admin_" (e.g. a ProxyAdmin)
const OWNER_EOA = '0x3333333333333333333333333333333333333333' as Address; // a plain account
const SWAP_ROUTER02 = '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45' as Address; // in the well-known table

const inputs = [
  { name: '_positionManager', type: 'address' }, { name: '_roleRegistry', type: 'address' }, { name: '_strategyManager', type: 'address' },
  { name: 'admin_', type: 'address' }, { name: 'owner_', type: 'address' }, { name: '_router', type: 'address' },
] as const;
const vals = [POSITION_MANAGER, ROLE_REGISTRY, POSITION_MANAGER, ADMIN_CONTRACT, OWNER_EOA, SWAP_ROUTER02];

function vc(): VerifiedContract {
  const base = loadVc(ADDR.dai);
  return { ...base, abi: [{ type: 'constructor', inputs: inputs.map((i) => ({ ...i })) } as never], constructorArgs: encodeAbiParameters(inputs as never, vals), stdJsonInput: { ...base.stdJsonInput, sources: { 'A.sol': { content: '// SPDX-License-Identifier: MIT\ncontract A {}' } } } };
}
const plan = async (to = 'base', contractName?: (id: number, a: Address) => Promise<string | null>) => {
  const o = { reader: stubReader([OWNER_EOA]), ...offlineExplorer };
  const p = await planClone(await analyseContract(vc(), o), to, {}, { ...o, contractName });
  return Object.fromEntries(p.steps[0]!.args.map((a) => [a.name, a]));
};

describe('contract dependencies are never given the deploying account', () => {
  it('a contract-valued argument is needs-input with the dependency note and no deployer suggestion, whatever its name', async () => {
    const a = await plan();
    for (const n of ['_positionManager', '_roleRegistry', '_strategyManager', 'admin_']) {
      expect(a[n]!.action).toBe('needs-input');
      expect(a[n]!.suggestion).toBeUndefined();
      expect(a[n]!.note).toMatch(/^protocol contract on the source chain: unverified \(0x.{40}\) — supply its address on the target chain or clone it first$/);
    }
  });
  it('a role holder that is a plain account still gets the deployer suggestion', async () => {
    const a = await plan();
    expect(a['owner_']).toMatchObject({ action: 'needs-input', suggestion: { $ref: 'deployer' } });
  });
  it('the verified name goes into the note', async () => {
    const a = await plan('base', async (_id, addr) => (addr === POSITION_MANAGER ? 'NonfungiblePositionManager' : null));
    expect(a['_positionManager']!.note).toContain('protocol contract on the source chain: NonfungiblePositionManager (');
    expect(a['_roleRegistry']!.note).toContain('source chain: unverified (');
  });
  it('a contract whose verified name is in the well-known table gets the target chain address as a suggestion (never an account)', async () => {
    const a = await plan('base', async (_id, addr) => (addr === ROLE_REGISTRY ? 'SwapRouter02' : null));
    expect(a['_roleRegistry']!.suggestion).toBe('0x2626664c2603336E57B271c5C0b26F421741e481');
    expect(a['_roleRegistry']!.note).toMatch(/the well-known uniswap-v3-swaprouter02 on Base is 0x2626664c2603336E57B271c5C0b26F421741e481/);
  });
  it('an address that the table already knows is remapped, not asked for', async () => {
    const a = await plan();
    expect(a['_router']).toMatchObject({ action: 'remap', value: '0x2626664c2603336E57B271c5C0b26F421741e481' });
  });
  it('the dependencies stay listed as needing input', async () => {
    const o = { reader: stubReader([OWNER_EOA]), ...offlineExplorer };
    const p = await planClone(await analyseContract(vc(), o), 'base', {}, o);
    expect(p.needsInput).toEqual(expect.arrayContaining(['contract._positionManager', 'contract._roleRegistry', 'contract._strategyManager', 'contract.admin_', 'contract.owner_']));
  });
});
