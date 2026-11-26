import { describe, expect, it } from 'vitest';
import { compileWithAst, stdInputForSource } from '../src/spec/compile.js';
import { extractSpec } from '../src/spec/extract.js';
import { failClosedReason, FAIL_CLOSED_PROMPT, expectedGuards, signatureGuarded } from '../src/spec/guards.js';
import { untranslatable } from '../src/spec/standard.js';
import { documentSelfSpend, lintSecurity, negativeFailures } from '../src/pipeline/security.js';
import { renderReport } from '../src/pipeline/report.js';
import { genHandler, aliasGroups } from '../src/targets/solana/codegen.js';
import { SolanaPack } from '../src/targets/solana/pack.js';
import { AptosPack } from '../src/targets/aptos/pack.js';
import { TezosPack } from '../src/targets/tezos/pack.js';
import { CosmWasmPack } from '../src/targets/cosmwasm/pack.js';
import { normaliseBody } from '../src/targets/tezos/lint.js';
import { buildDesign } from '../src/targets/tezos/design.js';
import { load } from './helpers.js';
import { alignGetterExpectations, discoverReinitState, dropDeadBranches } from '../src/spec/reinit.js';
import { generateScenarios } from '../src/scenario/generate.js';
import type { ScenarioSet } from '../src/types.js';

const compile = async (body: string) => { const c = await compileWithAst({ compilerVersion: '0.8.28+commit.7893614a', stdJsonInput: stdInputForSource('X.sol', `pragma solidity ^0.8.0;\n${body}`), contract: 'X' }); return { c, spec: extractSpec(c, {}) }; };

const SRC = `
interface IRegistry { function onlyOperator(address a) external view; function isOk(address a) external view returns (bool); function price() external view returns (uint); }
interface IERC20 { function transferFrom(address a, address b, uint v) external returns (bool); function transfer(address b, uint v) external returns (bool); }
contract X {
  IRegistry public registry; IERC20 public token; address public owner; mapping(address=>uint) public balances; mapping(address=>uint) public nonces; uint public total;
  constructor(address r, address t) { registry = IRegistry(r); token = IERC20(t); owner = msg.sender; }
  modifier onlyRegistryOperator() { registry.onlyOperator(msg.sender); _; }
  function recover(address payable to, uint amount) external onlyRegistryOperator { to.transfer(amount); }
  function withAuth(address from, address to, uint v, bytes memory sig, bytes32 h) external { address s = ecrecover(h, uint8(sig[0]), bytes32(0), bytes32(0)); require(s == from, "bad"); balances[from] -= v; balances[to] += v; }
  function gated(uint v) external { require(registry.isOk(msg.sender), "no"); total += v; }
  function setOwner(address n) external { require(msg.sender == owner, "owner"); owner = n; }
  function wrap(uint v) external { token.transferFrom(msg.sender, address(this), v); balances[msg.sender] += v; }
  function plain(uint v) external { balances[msg.sender] += v; }
}`;

describe('round 5: fail-closed classification', () => {
  it('signature checks, modifier-origin external calls and external results in a require make a function not translatable; plain guards and token pulls do not', async () => {
    const { spec } = await compile(SRC);
    const f = (n: string) => spec.functions.find((x) => x.name === n)!;
    expect(signatureGuarded(f('withAuth'))).toBe(true);
    expect(untranslatable(f('withAuth'))).toMatchObject({ feature: expect.stringMatching(/signature/) });
    expect(untranslatable(f('recover'))!.feature).toMatch(/external contract/);
    expect(untranslatable(f('gated'))!.feature).toMatch(/external contract/);
    expect(failClosedReason(f('setOwner'))).toBeNull();
    expect(failClosedReason(f('wrap'))).toBeNull();
    expect(failClosedReason(f('plain'))).toBeNull();
    expect(expectedGuards(f('setOwner')).caller).toMatch(/msg\.sender == owner/);
    expect(expectedGuards(f('wrap')).pulls.length).toBe(1);
  });

  it('all four designs leave the fail-closed functions out, and the prompts carry the hard rule', async () => {
    const { spec } = await compile(SRC);
    for (const pack of [new SolanaPack(), new CosmWasmPack(), new AptosPack(), new TezosPack()] as any[]) {
      const d = pack.design(spec, {});
      for (const fn of ['recover', 'withAuth', 'gated']) expect(pack.unitOf(d, fn), `${pack.id} ${fn}`).toBeNull();
      for (const fn of ['setOwner', 'wrap', 'plain']) expect(pack.unitOf(d, fn), `${pack.id} ${fn}`).not.toBeNull();
      const u = pack.units(d).find((x: string) => pack.unitOf(d, 'setOwner') === x)!;
      expect(pack.generatePrompt({ spec, design: d, sources: {} }, u).system).toContain('fail closed');
    }
    expect(FAIL_CLOSED_PROMPT).toMatch(/not supported on this target/);
  });
});

describe('round 5: static security lint', () => {
  it('flags a missing caller guard, a guard after the first write, a missing token pull and "check skipped" comments; accepts the faithful bodies', async () => {
    const { spec } = await compile(SRC);
    const unitOf = (fn: string) => (['setOwner', 'wrap', 'plain'].includes(fn) ? fn : null);
    const cases: { target: string; bad: Record<string, string>; good: Record<string, string> }[] = [
      { target: 'cosmwasm',
        bad: { setOwner: '    OWNER.save(deps.storage, &new_owner)?;\n    Ok(Response::new())', wrap: '    // the transferFrom is skipped\n    BAL.save(deps.storage, &info.sender, &v)?;\n    Ok(Response::new())' },
        good: { setOwner: '    if info.sender != OWNER.load(deps.storage)? { return Err(ContractError::Unauthorized {}); }\n    OWNER.save(deps.storage, &new_owner)?;\n    Ok(Response::new())', wrap: '    let msg = Cw20ExecuteMsg::TransferFrom { owner: info.sender.to_string(), recipient: env.contract.address.to_string(), amount: v };\n    BAL.save(deps.storage, &info.sender, &v)?;\n    Ok(Response::new().add_message(msg))' } },
      { target: 'tezos',
        bad: { setOwner: '        self.data.owner = n', wrap: '        # DEVIATION: the access-control check is omitted\n        self.data.balances[sp.sender] = v' },
        good: { setOwner: '        assert sp.sender == self.data.owner, "owner"\n        self.data.owner = n', wrap: '        sp.transfer(sp.record(from_=sp.sender, to_=sp.self_address, value=v), sp.mutez(0), token)\n        self.data.balances[sp.sender] = v' } },
      { target: 'aptos',
        bad: { setOwner: '    set_owner(n);', wrap: '    set_bal(signer::address_of(caller), v);' },
        good: { setOwner: '    assert!(signer::address_of(caller) == get_owner(), E_OWNER);\n    set_owner(n);', wrap: '    coin::transfer_from(caller, v);\n    set_bal(signer::address_of(caller), v);' } },
      { target: 'solana',
        bad: { setOwner: '    ctx.accounts.config.owner = n;\n    Ok(())', wrap: '    ctx.accounts.user.balances += v;\n    Ok(())' },
        good: { setOwner: '    require_keys_eq!(ctx.accounts.caller.key(), ctx.accounts.config.owner, AppError::Owner);\n    ctx.accounts.config.owner = n;\n    Ok(())', wrap: '    token_interface::transfer_checked(cpi, v, 6)?;\n    ctx.accounts.user.balances += v;\n    Ok(())' } },
    ];
    for (const c of cases) {
      const bad = lintSecurity(c.target, spec, unitOf, c.bad);
      expect(bad.filter((x) => x.status === 'FAIL').map((x) => x.fn).sort(), c.target).toEqual(['setOwner', 'wrap']);
      const good = lintSecurity(c.target, spec, unitOf, c.good);
      expect(good.filter((x) => x.status === 'FAIL'), c.target).toEqual([]);
      expect(good.map((x) => x.fn)).toEqual(expect.arrayContaining(['setOwner', 'wrap']));
    }
    // a guard AFTER the first write is not a guard
    const late = lintSecurity('tezos', spec, unitOf, { setOwner: '        self.data.owner = n\n        assert sp.sender == self.data.owner, "owner"' });
    expect(late.find((x) => x.fn === 'setOwner')!.problems.join()).toMatch(/after the first state write/);
    // a fail-closed function with an entry point is a lint failure
    const exposed = lintSecurity('tezos', spec, (fn) => fn, { withAuth: '        pass' });
    expect(exposed.find((x) => x.fn === 'withAuth')!.status).toBe('FAIL');
  });

  it('a negative scenario that succeeds on the rewrite while the original reverted is reported', () => {
    const set = { scenarios: [{ id: 'neg-1', kind: 'access', fn: 'recover', steps: [] }, { id: 'fn-1', kind: 'function', fn: 'wrap', steps: [] }] } as unknown as ScenarioSet;
    const out = negativeFailures(set, [
      { id: 'neg-1', title: 'recover: called by an unprivileged funded account', kind: 'access', fn: 'recover', status: 'failed', mismatches: [{ at: '0', what: 'x', expected: 'revert (Unauthorized)', actual: 'success' }], notRunnable: [], checked: 0, notes: [] },
      { id: 'fn-1', title: 'wrap', kind: 'function', fn: 'wrap', status: 'failed', mismatches: [{ at: '0', what: 'x', expected: 'revert', actual: 'success' }], notRunnable: [], checked: 0, notes: [] },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/recover/);
  });

  it('the report shows the unsafe banner and the lint results', () => {
    const md = renderReport({ version: 1, contract: 'X', source: {}, target: 'tezos', path: 'model', status: 'FAILED-BEHAVIOUR', statusReasons: ['SECURITY: x'], coverage: { functionsTotal: 0, functionsVerified: 0, functionsUnverified: [], uncheckedFunctions: [], trivialOnlyFunctions: [], notTranslatedFunctions: [], functionsAbsent: [], functionsPresent: 0, failedFunctions: [], otherUnverifiedFunctions: [], uncomparedReturns: [], notRunnableScenarios: [], getters: { planned: 0, checked: 0, mismatched: 0, notCompared: [] }, summary: 's' },
      compile: { ok: true, round: 0, rounds: [] }, behaviour: { ran: true, passed: 0, failed: 0, notRunnable: 0, documented: 0, total: 0, rounds: [], conformance: [] }, functions: [], nonPortable: [], notTranslated: [], designNotes: [], extraCapabilities: [], deploy: [], usage: { requests: 0, tokensIn: 0, tokensOut: 0, modelSecs: 0 }, wallSecs: 0, outcomes: [], scenarioCount: 0,
      security: { checked: 0, probes: [], problems: ['p'], unsafe: true, lint: [{ fn: 'setOwner', unit: 'setOwner', expected: ['caller guard'], status: 'FAIL', problems: ['no caller comparison'] }], negativeFailures: [], negativeScenarios: 2 },
      reinit: { applied: [{ fn: 'initializeV2', variable: 'x', value: '5' }], notApplied: [{ fn: 'initializeV3', reason: 'unknown' }] } } as never);
    expect(md).toMatch(/UNSAFE: DO NOT DEPLOY/);
    expect(md).toMatch(/Security lint/);
    expect(md).toMatch(/setOwner.*FAIL/);
    expect(md).toMatch(/State set by later initialisers/);
    expect(md).toMatch(/could not be applied/);
  });
});

describe('round 5: Solana aliasing (N24)', () => {
  it('aliased mutable entries are reconciled after the body: the changed copy wins, two different changes revert', async () => {
    const { spec } = await compile(`contract X { address public owner; uint public basisPointsRate = 10; mapping(address=>uint) public balances; constructor(){ owner = msg.sender; }
      function transfer(address to, uint v) public returns (bool) { uint fee = v * basisPointsRate / 10000; balances[msg.sender] -= v; balances[to] += v - fee; balances[owner] += fee; return true; } }`);
    const d = new SolanaPack().design(spec, {});
    const ins = d.instructions.find((i) => i.solidity === 'transfer')!;
    const groups = aliasGroups(ins);
    expect(groups.length).toBe(1);
    expect(groups[0]!.length).toBeGreaterThanOrEqual(3);
    const code = genHandler(ins, '    Ok(true)', d);
    for (const n of groups[0]!) expect(code).toContain(`let before_${n} = (*ctx.accounts.${n}).clone();`);
    expect(code).toMatch(/ConstraintDuplicateMutableAccount/);
    expect(code).toMatch(/\.key\(\) == ctx\.accounts\./);
    expect(code.indexOf('let result')).toBeLessThan(code.indexOf('Ok(result)'));
    // the state structs compare by value
    const { genState } = await import('../src/targets/solana/codegen.js');
    expect(genState(d)).toMatch(/derive\(InitSpace, PartialEq\)/);
    // no aliasing, no wrapper
    const plain = d.instructions.find((i) => i.solidity === 'balances' || aliasGroups(i).length === 0);
    if (plain) expect(genHandler(plain, '    Ok(())', d)).not.toContain('let result');
  });
});

describe('round 5: structs, tezos pairs, template self-spend, re-initialisers', () => {
  it('a struct from a library that a mapping refers to (Counters.Counter) is part of the spec and of the Aptos design', async () => {
    const { spec } = await compile(`library Counters { struct Counter { uint256 _value; } function current(Counter storage c) internal view returns (uint256) { return c._value; } function increment(Counter storage c) internal { c._value += 1; } }
      contract X { using Counters for Counters.Counter; mapping(address => Counters.Counter) private _nonces; function bump() external { _nonces[msg.sender].increment(); } function nonces(address a) external view returns (uint) { return _nonces[a].current(); } }`);
    expect(spec.structs.map((s) => s.name)).toContain('Counter');
    const d = new AptosPack().design(spec, {}) as any;
    expect(d.structs.map((s: any) => s.name)).toContain('Counter');
  });

  it('Tezos: a value `sp.pair(a, b)` becomes a tuple', async () => {
    const { spec } = await load('CosmwasmLocker');
    const d = buildDesign(spec);
    const r = normaliseBody('own = self.get_balances(sp.pair(token, sp.self_address))', { d, h: d.instructions.find((h) => h.unit === 'ep_withdraw')!, spec });
    expect(r.body).toBe('own = self.get_balances((token, sp.self_address))');
  });

  it('template self-transferFrom: SPL and FA1.2 get the exact documented rule, other targets and failures stay failures', () => {
    const set = { scenarios: [{ id: 's', kind: 'extra', fn: 'transferFrom', steps: [{ type: 'call', actor: 'bob', fn: 'transferFrom', args: [{ actor: 'bob' }, { actor: 'carol' }, '5'], at: 1 }] }] } as unknown as ScenarioSet;
    const failed = [{ id: 's', title: 't', kind: 'extra', fn: 'transferFrom', status: 'failed' as const, mismatches: [{ at: '0', what: 'x', expected: 'revert (insufficient allowance)', actual: 'success' }], notRunnable: [], checked: 0, notes: [] }];
    for (const t of ['solana', 'tezos']) { const o = documentSelfSpend(t, set, failed)[0]!; expect(o.status).toBe('documented-difference'); expect(o.mismatches[0]!.documented).toMatch(/requires an allowance even for the owner/); }
    expect(documentSelfSpend('cosmwasm', set, failed)[0]!.status).toBe('failed');
    const other = JSON.parse(JSON.stringify(failed)); other[0].mismatches[0].actual = 'revert (x)'; other[0].mismatches[0].expected = 'success';
    expect(documentSelfSpend('solana', set, other)[0]!.status).toBe('failed');
    const notSelf = { scenarios: [{ ...set.scenarios[0]!, steps: [{ type: 'call', actor: 'bob', fn: 'transferFrom', args: [{ actor: 'alice' }, { actor: 'carol' }, '5'], at: 1 }] }] } as unknown as ScenarioSet;
    expect(documentSelfSpend('solana', notSelf, failed)[0]!.status).toBe('failed');
  });

  it('re-initialisers: values readable on the source chain are applied, everything else is reported up front', async () => {
    const { c, spec } = await compile(`contract X { uint public version; string public name; address public lostAndFound; mapping(address=>bool) public blocked; uint public counter; bool public flag;
      function initialize(string memory n0) public { version = 1; name = n0; }
      function initializeV2(string memory n) public { name = n; version = 2; }
      function initializeV2_1(address l) public { lostAndFound = l; }
      function initializeV2_2(address[] memory a) public { for (uint i; i < a.length; i++) blocked[a[i]] = true; }
      function initializeV3() public { counter = 7; }
      function bump() public { counter += 1; } }`);
    spec.foldedInitializer = 'initialize';
    spec.constructor = { ...spec.functions.find((f) => f.name === 'initialize')!, name: 'constructor', kind: 'constructor' } as never;
    const answers: Record<string, string> = {};
    const { encodeAbiParameters } = await import('viem');
    const sel = (await import('viem')).toFunctionSelector;
    answers[sel('version()')] = encodeAbiParameters([{ type: 'uint256' }], [2n]);
    answers[sel('name()')] = encodeAbiParameters([{ type: 'string' }], ['USD Coin']);
    answers[sel('lostAndFound()')] = encodeAbiParameters([{ type: 'address' }], ['0x0000000000000000000000000000000000000001']);
    answers[sel('counter()')] = encodeAbiParameters([{ type: 'uint256' }], [7n]);
    const reader = { getCode: async () => '0x', getStorageAt: async () => '0x', call: async (_t: string, d: string) => answers[d.slice(0, 10)] };
    const st = await discoverReinitState(spec, c.abi as any[], reader, '0xabc');
    expect(st.applied.map((x) => `${x.variable}=${x.value}`)).toEqual([]);
    const why = st.notApplied.map((x) => `${x.fn}: ${x.reason}`).join('\n');
    expect(why).toMatch(/initializeV2: .*deployment argument/);
    expect(why).toMatch(/initializeV2_1: .*addresses are not applied automatically/);
    expect(why).toMatch(/initializeV2_2: .*blocked.*mapping/);
    expect(why).toMatch(/initializeV3: .*counter.*also change it/);
    // the recorded expectation of the getter follows the source chain
    const set = { scenarios: [{ id: 'a', steps: [{ type: 'view', fn: 'name', args: [], at: 0, label: 'name', expect: '' }] }] } as unknown as ScenarioSet;
    alignGetterExpectations(set, spec, st, c.abi as any[]);
    expect((set.scenarios[0] as any).steps[0].expect).toBe('');
  });
});

describe('round 5: negative scenarios', () => {
  it('every guarded function gets a denied-path scenario even when no positive path exists', async () => {
    const { hasAnvil } = await import('./helpers.js');
    if (!hasAnvil) return;
    const { OriginalRunner } = await import('../src/scenario/original.js');
    const { c, spec } = await compile(`contract X { address public owner; uint public total; mapping(address=>uint) public bal;
      constructor() { owner = msg.sender; }
      function setOwner(address n) external { require(msg.sender == owner, "owner"); owner = n; }
      function sweep(uint amount) external { require(msg.sender == owner, "owner"); total -= amount; }
      function withSig(address from, uint v, bytes memory sig, bytes32 h) external { require(sig.length == 65, "len"); address s = ecrecover(h, 27, bytes32(0), bytes32(0)); require(s == from && s != address(0), "bad"); bal[from] += v; }
      function plain(uint v) external { bal[msg.sender] += v; } }`);
    const r = await OriginalRunner.start(c.abi, c.creation);
    try {
      const set = await generateScenarios(spec, r);
      const negs = set.scenarios.filter((x) => x.negative);
      const kinds = (fn: string) => negs.filter((x) => x.negative!.fn === fn).map((x) => x.negative!.kind).sort();
      expect(kinds('withSig')).toEqual(['bad-signature', 'unauthorised']);
      expect(kinds('plain')).toEqual([]);
      expect(negs.every((x) => x.kind === 'access' && x.steps[0]!.type === 'call' && (x.steps[0] as { actor: string }).actor === 'mallory')).toBe(true);
      // sweep / setOwner are guarded: either the explorer's own access scenario or a negative one exists
      for (const fn of ['setOwner', 'sweep']) expect(set.scenarios.some((x) => x.kind === 'access' && x.fn === fn), fn).toBe(true);
    } finally { await r.stop(); }
  }, 60000);
});

describe('round 5: fail-closed is not too broad', () => {
  const FP = `
interface IUp { function transferByLegacy(address a, address b, uint v) external returns (bool); }
interface IReg { function price() external view returns (uint); function isOk(address a) external view returns (bool); function nonBlacklisted(address a) external view; function ping() external; }
contract X {
  bool public deprecated; address public upgraded; IReg public reg; mapping(address=>uint) public bal; uint public last;
  modifier onlyPayloadSize(uint size) { require(!(msg.data.length < size + 4)); _; }
  function transfer(address to, uint v) public onlyPayloadSize(2 * 32) returns (bool) { if (deprecated) { return IUp(upgraded).transferByLegacy(msg.sender, to, v); } bal[msg.sender] -= v; bal[to] += v; return true; }
  function byName(uint v) external { reg.isOk(msg.sender); bal[msg.sender] += v; }
  function readsPrice(uint v) external { uint p = reg.price(); last = p; bal[msg.sender] += v; }
  function notifies(uint v) external { reg.ping(); bal[msg.sender] += v; }
  function voidGuard(uint v) external { reg.nonBlacklisted(msg.sender); bal[msg.sender] += v; }
  function liveFlag(uint v) external { if (deprecated) { reg.nonBlacklisted(msg.sender); } bal[msg.sender] += v; }
}`;
  it('only real guard constructs trigger it: name-only calls, price reads and notifications do not', async () => {
    const { spec } = await compile(FP);
    const f = (n: string) => spec.functions.find((x) => x.name === n)!;
    expect(failClosedReason(f('byName'))).toBeNull();
    expect(failClosedReason(f('readsPrice'))).toBeNull();
    expect(failClosedReason(f('notifies'))).toBeNull();
    expect(failClosedReason(f('voidGuard'))!.reason).toMatch(/nonBlacklisted \(void view call/);
  });

  it('a dead legacy branch (flag false on the source chain) is dropped; a true or unreadable flag keeps the calls', async () => {
    for (const [answer, dead] of [['false', true], ['true', false], [undefined, false]] as const) {
      const { c, spec } = await compile(FP);
      const { encodeAbiParameters, toFunctionSelector } = await import('viem');
      const reader = { getCode: async () => '0x', getStorageAt: async () => '0x', call: async (_t: string, d: string) => (d.slice(0, 10) === toFunctionSelector('deprecated()') && answer ? encodeAbiParameters([{ type: 'bool' }], [answer === 'true']) : undefined) };
      expect(spec.functions.find((x) => x.name === 'transfer')!.externalCalls.length).toBe(1);
      const notes = await dropDeadBranches(spec, c.abi as any[], reader, '0xabc');
      expect(notes.join()).toMatch(dead ? /is dead/ : /external calls are kept/);
      expect(spec.functions.find((x) => x.name === 'transfer')!.externalCalls.length).toBe(dead ? 0 : 1);
      expect(failClosedReason(spec.functions.find((x) => x.name === 'transfer')!)).toBeNull();
      expect(failClosedReason(spec.functions.find((x) => x.name === 'liveFlag')!) === null).toBe(dead);
    }
  });

  it('onlyPayloadSize is a mapped calldata-length check, not a not-translated msg.data feature', async () => {
    const { spec } = await compile(FP);
    expect(spec.nonPortable.some((n) => n.id === 'msg.data')).toBe(false);
    expect(spec.nonPortable.find((n) => n.id === 'calldata-length-check')?.treatment).toBe('mapped');
    expect(spec.functions.find((x) => x.name === 'transfer')!.nonPortable).not.toContain('msg.data');
  });

  it('a helper returning the external answer that a require uses is a guard (TradingSafe isModuleEnabled)', async () => {
    const { spec } = await compile(`interface IP { function isMod(address a) external view returns (bool); }
      contract X { IP p; uint public n; function enabled(address a) internal view returns (bool) { return p.isMod(a); } function use() external { require(enabled(msg.sender), "no"); n++; } }`);
    expect(failClosedReason(spec.functions.find((x) => x.name === 'use')!)!.reason).toMatch(/another contract/);
  });
});

describe('round 5: lint accepts membership guards', () => {
  it('a role-map lookup that returns an error counts as a caller guard (onlyMinters style)', async () => {
    const { spec } = await compile(`contract X { mapping(address=>bool) minters; uint public n; modifier onlyMinters() { require(minters[msg.sender], "no"); _; } function burn(uint a) external onlyMinters { n -= a; } }`);
    const body = '    if !get_minters(deps.storage, &info.sender)? {\n        return Err(ContractError::NotMinter {});\n    }\n    N.save(deps.storage, &a)?;\n    Ok(Response::new())';
    expect(lintSecurity('cosmwasm', spec, (fn) => fn, { burn: body }).find((x) => x.fn === 'burn')!.status).toBe('ok');
    expect(lintSecurity('cosmwasm', spec, (fn) => fn, { burn: '    N.save(deps.storage, &a)?;\n    Ok(Response::new())' }).find((x) => x.fn === 'burn')!.status).toBe('FAIL');
  });
});

describe('round 5: caller-derived keys', () => {
  it('`address owner = _msgSender();` keys resolve to the caller, so Solana gets its Allowances account (N22)', async () => {
    const { spec } = await compile(`contract Ctx { function _msgSender() internal view returns (address) { return msg.sender; } }
      contract X is Ctx { mapping(address=>mapping(address=>uint)) public _allowances;
        function _approve(address owner, address spender, uint v) internal { _allowances[owner][spender] = v; }
        function approve(address spender, uint v) external returns (bool) { address owner = _msgSender(); _approve(owner, spender, v); return true; } }`);
    const acc = spec.functions.find((f) => f.name === 'approve')!.mappingAccesses.find((m) => m.variable === '_allowances')!;
    expect(acc.keys[0]).toEqual({ kind: 'msg.sender' });
    const d = new SolanaPack().design(spec, {});
    const ins = d.instructions.find((i) => i.solidity === 'approve')!;
    expect(ins.accounts.some((r) => r.kind === 'entry')).toBe(true);
    expect(ins.notes.join(' ')).not.toMatch(/could not be resolved/);
  });
});

describe('round 5: CosmWasm event attributes', () => {
  it('attribute keys never start with the reserved underscore', async () => {
    const { genEvents } = await import('../src/targets/cosmwasm/codegen.js');
    const { spec } = await compile(`contract X { event Blacklisted(address indexed _account); function f() external { emit Blacklisted(msg.sender); } }`);
    const code = genEvents(spec);
    expect(code).toContain('add_attribute("account"');
    expect(code).not.toContain('add_attribute("_account"');
  });
});
