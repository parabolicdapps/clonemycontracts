import { describe, expect, it } from 'vitest';
import { parseType } from '../src/spec/extract.js';
import { load } from './helpers.js';

describe('parseType', () => {
  it('parses nested mappings and arrays', () => {
    const t = parseType('mapping(address => mapping(address => uint256))');
    expect(t.kind).toBe('mapping');
    expect(t.value?.kind).toBe('mapping');
    expect(t.value?.value?.bits).toBe(256);
    expect(parseType('address[3] memory')).toMatchObject({ kind: 'array', length: 3, element: { kind: 'address' } });
    expect(parseType('contract IERC20Min')).toMatchObject({ kind: 'contract', name: 'IERC20Min' });
    expect(parseType('struct MultiSig2of3.Tx storage ref')).toMatchObject({ kind: 'struct', name: 'Tx' });
  });
});

describe('spec extraction (bench contracts)', () => {
  it('StakingRewards: state, mappings, modifiers, external calls, time', async () => {
    const { spec } = await load('StakingRewards');
    expect(spec.stateVars.map((s) => s.name)).toContain('staked');
    expect(spec.tokenDependencies.map((t) => t.name).sort()).toEqual(['rewardToken', 'stakingToken']);
    const stake = spec.functions.find((f) => f.name === 'stake')!;
    expect(stake.modifiers).toEqual(['updateReward']);
    expect(stake.writes).toEqual(expect.arrayContaining(['staked', 'totalStaked', 'rewards', 'rewardPerTokenStored']));
    expect(stake.events).toEqual(['Staked']);
    expect(stake.externalCalls[0]).toMatchObject({ target: 'stakingToken', method: 'transferFrom' });
    expect(stake.externalCalls[0]!.args.map((a) => a.kind)).toEqual(['msg.sender', 'this', 'param']);
    // modifier parameter is bound to msg.sender
    expect(stake.mappingAccesses.some((m) => m.variable === 'rewards' && m.keys[0]!.kind === 'msg.sender' && m.write)).toBe(true);
    expect(stake.requires.map((r) => r.message)).toEqual(expect.arrayContaining(['zero amount', 'transfer failed']));
    expect(stake.usesTimestamp).toBe(true);
    expect(spec.accessControl.pattern).toBe('custom-owner');
    expect(spec.accessControl.guarded.map((g) => g.fn)).toEqual(['startRewards']);
    expect(spec.nonPortable.map((n) => n.id)).toEqual(expect.arrayContaining(['block.timestamp', 'uint256']));
  });
  it('MultiSig2of3: roles, struct array, low-level call, native value', async () => {
    const { spec } = await load('MultiSig2of3');
    expect(spec.accessControl.pattern).toBe('custom-roles');
    expect(spec.hasReceive).toBe(true);
    const ids = spec.nonPortable.map((n) => n.id);
    expect(ids).toEqual(expect.arrayContaining(['low-level-call', 'native-value', 'fallback']));
    const exec = spec.functions.find((f) => f.name === 'execute')!;
    expect(exec.externalCalls.some((e) => e.low && e.method === 'call' && e.sendsValue)).toBe(true);
    expect(exec.writes).toContain('txs');
    expect(spec.structs.find((s) => s.name === 'Tx')!.fields.map((f) => f.name)).toEqual(['to', 'value', 'data', 'executed', 'confirmations']);
  });
  it('ERC20Token: standard detection and no non-portable features beyond uint256', async () => {
    const { spec } = await load('ERC20Token');
    expect(spec.tokenStandards).toEqual(['ERC-20']);
    expect(spec.nonPortable.map((n) => n.id)).toEqual(['max-uint', 'uint256']);
    expect(spec.accessControl.guarded.map((g) => g.fn).sort()).toEqual(['mint', 'transferOwnership']);
  });
  it('LinearVesting: immutables and constructor', async () => {
    const { spec } = await load('LinearVesting');
    expect(spec.stateVars.filter((s) => s.immutable).map((s) => s.name)).toEqual(expect.arrayContaining(['token', 'beneficiary', 'funder', 'start']));
    expect(spec.constructor!.params.map((p) => p.name)).toEqual(['_token', '_beneficiary', '_start', 'cliffSeconds', '_duration']);
    expect(spec.constructor!.requires.length).toBe(2);
    expect(spec.tokenDependencies.map((t) => t.name)).toEqual(['token']);
  });
});
