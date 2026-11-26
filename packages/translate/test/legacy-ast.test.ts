import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { compileVerified, compileWithAst, stdInputForSource } from '../src/spec/compile.js';
import { extractSpec } from '../src/spec/extract.js';
import { checkSpecAgainstAbi } from '../src/spec/gate.js';
import { normalizeAst, isLegacyShape } from '../src/spec/legacy.js';

const vc = (n: string) => JSON.parse(readFileSync(new URL(`./fixtures/${n}.vc.json`, import.meta.url), 'utf8'));

describe('Solidity 0.4.x AST (real verified contracts)', () => {
  it('WETH9 (0.4.19): names, kinds, fallback, requires and events survive; the ABI gate passes', async () => {
    const v = vc('weth');
    const c = await compileVerified(v);
    const spec = extractSpec(c, {});
    expect(spec.functions.filter((f) => f.kind === 'function').map((f) => f.name).sort()).toEqual(['approve', 'deposit', 'totalSupply', 'transfer', 'transferFrom', 'withdraw']);
    expect(spec.functions.some((f) => f.kind === 'fallback')).toBe(true);
    expect(spec.hasFallback).toBe(true);
    expect(spec.constructor).toBeNull();
    expect(spec.functions.every((f) => f.name && f.kind)).toBe(true);
    const wd = spec.functions.find((f) => f.name === 'withdraw')!;
    expect(wd.mutability).toBe('nonpayable');
    expect(wd.requires.length).toBeGreaterThan(0);
    expect(wd.events).toContain('Withdrawal');
    expect(spec.functions.find((f) => f.name === 'deposit')!.payable).toBe(true);
    expect(spec.functions.find((f) => f.name === 'totalSupply')!.mutability).toBe('view');
    expect(spec.functions.find((f) => f.name === 'transfer')!.returns).toHaveLength(1);
    expect(spec.stateVars.map((s) => s.name)).toEqual(expect.arrayContaining(['name', 'symbol', 'decimals', 'balanceOf', 'allowance']));
    expect(spec.stateVars.find((s) => s.name === 'decimals')!.initial).toMatchObject({ kind: 'uint', value: '18' });
    expect(checkSpecAgainstAbi(spec, c.abi, v.abi)).toEqual({ ok: true, problems: [] });
  }, 60000);

  it('USDT TetherToken (0.4.18): constructor by contract name, onlyOwner / whenNotPaused modifiers, throw-free requires', async () => {
    const v = vc('usdt');
    const c = await compileVerified(v);
    const spec = extractSpec(c, {});
    expect(spec.constructor?.params.map((p) => p.type.solidity)).toEqual(['uint256', 'string', 'string', 'uint256']);
    const names = spec.functions.map((f) => f.name);
    expect(names).toEqual(expect.arrayContaining(['transfer', 'transferFrom', 'approve', 'pause', 'unpause', 'addBlackList', 'issue', 'redeem', 'setParams']));
    expect(spec.functions.find((f) => f.name === 'pause')!.modifiers).toEqual(expect.arrayContaining(['onlyOwner']));
    expect(spec.accessControl.guarded.map((g) => g.fn)).toEqual(expect.arrayContaining(['pause', 'issue']));
    expect(spec.events.map((e) => e.name)).toEqual(expect.arrayContaining(['Issue', 'Redeem', 'Deprecate', 'Params']));
    expect(checkSpecAgainstAbi(spec, c.abi, v.abi).problems).toEqual([]);
  }, 60000);
});

const SRC = (pragma: string, kw: { ctor: string; fallback: string; emit: (e: string) => string; now: string; view: string; noMsg?: boolean }) => `pragma solidity ${pragma};
contract Vault {
    address public owner;
    uint256 public total;
    uint256 public lockTime = 7 days;
    uint256 public constant CAP = 10 ** 6;
    mapping(address => uint256) public balanceOf;
    event Deposit(address indexed who, uint256 amount);
    modifier onlyOwner() { ${kw.noMsg ? "require(msg.sender == owner);" : 'require(msg.sender == owner, "not owner");'} _; }
    ${kw.ctor}
    ${kw.fallback}
    function deposit() public payable { ${kw.noMsg ? "require(msg.value > 0);" : 'require(msg.value > 0, "zero");'} balanceOf[msg.sender] += msg.value; total += msg.value; ${kw.emit('Deposit(msg.sender, msg.value)')} }
    function setOwner(address o) public onlyOwner { owner = o; }
    function unlocked() public ${kw.view} returns (bool) { return ${kw.now} > lockTime; }
}`;

const ERAS: [string, string, string, Parameters<typeof SRC>[1]][] = [
  ['0.4.17', '0.4.17+commit.bdeb9e52', '^0.4.17', { ctor: 'function Vault() public { owner = msg.sender; }', fallback: 'function() public payable { deposit(); }', emit: (e) => `${e};`, now: 'now', view: 'constant', noMsg: true }],
  ['0.4.24', '0.4.24+commit.e67f0147', '^0.4.24', { ctor: 'constructor() public { owner = msg.sender; }', fallback: 'function() public payable { deposit(); }', emit: (e) => `emit ${e};`, now: 'now', view: 'view' }],
  ['0.5.17', '0.5.17+commit.d19bba13', '^0.5.0', { ctor: 'constructor() public { owner = msg.sender; }', fallback: 'function() external payable { }', emit: (e) => `emit ${e};`, now: 'now', view: 'view' }],
  ['0.6.12', '0.6.12+commit.27d51765', '^0.6.0', { ctor: 'constructor() public { owner = msg.sender; }', fallback: 'receive() external payable { }', emit: (e) => `emit ${e};`, now: 'block.timestamp', view: 'view' }],
  ['0.7.6', '0.7.6+commit.7338295f', '^0.7.0', { ctor: 'constructor() { owner = msg.sender; }', fallback: 'receive() external payable { }', emit: (e) => `emit ${e};`, now: 'block.timestamp', view: 'view' }],
  ['0.8.28', '0.8.28+commit.7893614a', '^0.8.0', { ctor: 'constructor() { owner = msg.sender; }', fallback: 'receive() external payable { }', emit: (e) => `emit ${e};`, now: 'block.timestamp', view: 'view' }],
];
describe.each(ERAS)('the same contract through solc %s normalises to the same spec', (_v, full, pragma, kw) => {
  it('names, kinds, constructor, receive/fallback, modifiers, requires, initial values, gate', async () => {
    const c = await compileWithAst({ compilerVersion: full, stdJsonInput: stdInputForSource('Vault.sol', SRC(pragma, kw)), contract: 'Vault' });
    const spec = extractSpec(c, {});
    expect(spec.functions.filter((f) => f.kind === 'function').map((f) => f.name).sort()).toEqual(['deposit', 'setOwner', 'unlocked']);
    expect(spec.constructor).not.toBeNull();
    expect(spec.constructor!.writes).toContain('owner');
    expect(spec.hasReceive || spec.hasFallback).toBe(true);
    const dep = spec.functions.find((f) => f.name === 'deposit')!;
    expect(dep.visibility).toBe('public');
    expect(dep.payable).toBe(true);
    expect(dep.events).toEqual(['Deposit']);
    expect(dep.requires.map((r) => r.message)).toEqual(kw.noMsg ? [undefined] : ['zero']);
    expect(spec.functions.find((f) => f.name === 'setOwner')!.modifiers).toEqual(['onlyOwner']);
    expect(spec.functions.find((f) => f.name === 'unlocked')!.mutability).toBe('view');
    expect(spec.functions.find((f) => f.name === 'unlocked')!.usesTimestamp).toBe(true);
    expect(spec.accessControl.guarded.map((g) => g.fn)).toEqual(['setOwner']);
    expect(spec.stateVars.find((s) => s.name === 'lockTime')!.initial).toEqual({ kind: 'uint', value: '604800', via: 'ast' });
    expect(spec.stateVars.find((s) => s.name === 'CAP')!.initial).toMatchObject({ value: '1000000' });
    expect(checkSpecAgainstAbi(spec, c.abi).problems).toEqual([]);
  }, 60000);
});

describe('spec sanity gate', () => {
  const abi = [
    { type: 'function', name: 'a', inputs: [], outputs: [], stateMutability: 'nonpayable' },
    { type: 'function', name: 'b', inputs: [{ name: 'x', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
    { type: 'event', name: 'E', inputs: [] },
  ];
  const spec: any = { name: 'X', functions: [], stateVars: [], events: [], constructor: null, hasReceive: false, hasFallback: false };
  it('an empty spec for a contract whose ABI has functions is refused', () => {
    const r = checkSpecAgainstAbi(spec, abi);
    expect(r.ok).toBe(false);
    expect(r.problems.join(' ')).toMatch(/has 2 functions but the spec has none/);
  });
  it('a function or event missing on either side is refused', () => {
    const s2: any = { ...spec, functions: [{ name: 'a', kind: 'function', visibility: 'public', params: [] }, { name: 'zzz', kind: 'function', visibility: 'public', params: [] }], events: [{ name: 'F' }] };
    const r = checkSpecAgainstAbi(s2, abi);
    expect(r.problems.join(' | ')).toMatch(/function b\(uint256\) is missing in the spec/);
    expect(r.problems.join(' | ')).toMatch(/spec function zzz is not in the compiler ABI/);
    expect(r.problems.join(' | ')).toMatch(/event E is missing in the spec/);
    expect(r.problems.join(' | ')).toMatch(/spec event F is not in the compiler ABI/);
  });
  it('a constructor / receive mismatch is refused', () => {
    const r = checkSpecAgainstAbi({ ...spec, functions: [] }, [{ type: 'constructor', inputs: [{ name: 'x', type: 'uint256' }] }, { type: 'receive' }]);
    expect(r.problems.join(' | ')).toMatch(/constructor with 1 parameter/);
    expect(r.problems.join(' | ')).toMatch(/receive\(\)/);
  });
  it('the pre-0.4.12 legacy AST is rejected loudly instead of producing an empty spec', () => {
    expect(isLegacyShape({ name: 'SourceUnit', children: [], attributes: {} })).toBe(true);
    expect(() => normalizeAst({ name: 'SourceUnit', children: [], attributes: {} }, '0.4.11')).toThrow(/legacy AST/);
  });
});

describe('the original failure (WETH9 reported PASSED as an empty shell) can no longer happen', () => {
  it('a spec extracted from the un-normalised 0.4 AST has nameless functions and is refused by the gate', async () => {
    const v = vc('weth');
    const c = await compileVerified(v);
    // undo the normalisation: remove `kind` (and constructor/fallback naming) the way a 0.4.19 AST really looks
    const strip = (n: any) => { if (!n || typeof n !== 'object') return; if (Array.isArray(n)) { n.forEach(strip); return; } if (n.nodeType === 'FunctionDefinition') { delete n.kind; n.name = ''; } Object.values(n).forEach(strip); };
    const raw = structuredClone(c);
    strip(raw.asts);
    const spec = extractSpec(raw, {});
    const gate = checkSpecAgainstAbi(spec, c.abi, v.abi);
    expect(gate.ok).toBe(false);
    expect(gate.problems.join(' | ')).toMatch(/is missing in the spec|have no name/);
  }, 60000);
});
