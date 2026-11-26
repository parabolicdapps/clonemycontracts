import { describe, expect, it } from 'vitest';
import { compileWithAst, stdInputForSource } from '../src/spec/compile.js';
import { extractSpec } from '../src/spec/extract.js';
import { failClosedReason } from '../src/spec/guards.js';
import { dropDeadBranches } from '../src/spec/reinit.js';

const compile = async (body: string) => { const c = await compileWithAst({ compilerVersion: '0.8.28+commit.7893614a', stdJsonInput: stdInputForSource('X.sol', `pragma solidity ^0.8.0;\n${body}`), contract: 'X' }); return { c, spec: extractSpec(c, {}) }; };
const fc = (spec: Awaited<ReturnType<typeof compile>>['spec'], n: string) => failClosedReason(spec.functions.find((x) => x.name === n)!);

describe('round 6: transitive guard taint (N26 / N27 / N28)', () => {
  it('N26: a signature check reached through `using SignatureUtils for bytes32` and a library staticcall (TradingSafe recoverSafe)', async () => {
    const { spec } = await compile(`
      library SignatureUtils { function isValidSignature(bytes32 digest, address signer, bytes memory sig) internal view returns (bool) { (bool ok, bytes memory r) = signer.staticcall(abi.encodeWithSelector(0x1626ba7e, digest, sig)); return ok && r.length == 32; } }
      contract X { using SignatureUtils for bytes32; address public owner; mapping(address=>bool) public recovering;
        function _validate(bytes32 digest, address s, bytes memory sig) internal view { if (!digest.isValidSignature(s, sig)) revert("bad sig"); }
        function recoverSafe(address newOwner, bytes32 digest, address s, bytes calldata sig) external { _validate(digest, s, sig); owner = newOwner; }
        function setFlag(bool b) external { require(msg.sender == owner, "o"); recovering[msg.sender] = b; } }`);
    expect(fc(spec, 'recoverSafe')!.feature).toMatch(/signature/);
    expect(fc(spec, 'setFlag')).toBeNull();
  });

  it('N27: the error-code return pattern across *Internal / *Fresh helpers (Compound cETH mint)', async () => {
    const { spec } = await compile(`
      interface IComptroller { function mintAllowed(address c, address m, uint a) external returns (uint); function mintVerify(address c, address m, uint a, uint t) external; }
      contract X { IComptroller public comptroller; mapping(address=>uint) public bal; uint public total;
        function fail(uint e) internal pure returns (uint) { return e; }
        function mintFresh(address minter, uint amount) internal returns (uint) {
          uint allowed = comptroller.mintAllowed(address(this), minter, amount);
          if (allowed != 0) { return fail(allowed); }
          bal[minter] += amount; total += amount; return 0; }
        function mintInternal(uint amount) internal returns (uint) { return mintFresh(msg.sender, amount); }
        function mint(uint amount) external returns (uint) { return mintInternal(amount); }
        function plainMint(uint amount) external { bal[msg.sender] += amount; } }`);
    expect(fc(spec, 'mint')!.reason).toMatch(/mintFresh|allowed/);
    expect(fc(spec, 'plainMint')).toBeNull();
  });

  it('N28: Aragon-style `_auth(ROLE)` -> canPerform -> kernel().hasPermission (Lido stETH admin functions)', async () => {
    const { spec } = await compile(`
      interface IKernel { function hasPermission(address who, address where, bytes32 what, bytes calldata how) external view returns (bool); }
      contract AragonApp { IKernel internal k;
        function kernel() public view returns (IKernel) { return k; }
        function canPerform(address sender, bytes32 role, uint[] memory params) public view returns (bool) { return kernel().hasPermission(sender, address(this), role, new bytes(0)); }
        function _auth(bytes32 role) internal view { require(canPerform(msg.sender, role, new uint[](0)), "APP_AUTH_FAILED"); }
        modifier auth(bytes32 role) { _auth(role); _; } }
      contract X is AragonApp { bytes32 constant PAUSE_ROLE = keccak256("PAUSE"); bool public stopped; uint public fee; address public owner;
        function stop() external auth(PAUSE_ROLE) { stopped = true; }
        function setFee(uint f) external auth(PAUSE_ROLE) { fee = f; }
        function localSet(uint f) external { require(msg.sender == owner, "o"); fee = f; } }`);
    expect(fc(spec, 'stop')).not.toBeNull();
    expect(fc(spec, 'setFee')!.reason).toMatch(/another contract/);
    expect(fc(spec, 'localSet')).toBeNull();
  });

  it('local guards, reads that do not gate, token ops, notifications and library helpers are NOT excluded', async () => {
    const { spec } = await compile(`
      interface IERC20 { function transferFrom(address a, address b, uint v) external returns (bool); function balanceOf(address a) external view returns (uint); }
      interface IFeed { function latest() external view returns (uint); function ping(uint x) external; }
      library SafeERC20 { function safeTransferFrom(IERC20 t, address a, address b, uint v) internal { require(t.transferFrom(a, b, v), "x"); } }
      abstract contract Own { address public owner; modifier onlyOwner() { require(msg.sender == owner, "o"); _; } }
      abstract contract Pause { bool public paused; modifier whenNotPaused() { require(!paused, "p"); _; } }
      abstract contract Guard { uint private _s = 1; modifier nonReentrant() { require(_s == 1, "r"); _s = 2; _; _s = 1; } }
      contract X is Own, Pause, Guard { using SafeERC20 for IERC20; IERC20 public token; IFeed public feed; mapping(address=>bool) public roles; mapping(address=>uint) public bal; uint public last; bool public deprecated; address public up;
        function a(uint v) external onlyOwner whenNotPaused nonReentrant { bal[msg.sender] += v; }
        function b(uint v) external { require(roles[msg.sender], "r"); bal[msg.sender] += v; }
        function c(uint v) external { token.safeTransferFrom(msg.sender, address(this), v); bal[msg.sender] += v; }
        function d(uint v) external { require(token.transferFrom(msg.sender, address(this), v), "t"); bal[msg.sender] += v; }
        function e(uint v) external { uint p = feed.latest(); last = p; bal[msg.sender] += v; }
        function f(uint v) external { feed.ping(v); bal[msg.sender] += v; }
        function g(uint v) external { if (deprecated) { require(feed.latest() > 0, "dep"); } bal[msg.sender] += v; }
        function h(address to, uint v) external { (bool ok, ) = to.call{value: v}(""); require(ok, "send"); } }`);
    for (const n of ['a', 'b', 'c', 'd', 'e', 'f', 'h']) expect(fc(spec, n), n).toBeNull();
    // g: the guard is a dead legacy branch once `deprecated` is known to be false on the source chain
    expect(fc(spec, 'g')).not.toBeNull();
    const { encodeAbiParameters, toFunctionSelector } = await import('viem');
    const reader = { getCode: async () => '0x', getStorageAt: async () => '0x', call: async (_t: string, d: string) => (d.slice(0, 10) === toFunctionSelector('deprecated()') ? encodeAbiParameters([{ type: 'bool' }], [false]) : undefined) };
    const notes = await dropDeadBranches(spec, [{ type: 'function', name: 'deprecated', inputs: [], outputs: [{ type: 'bool' }], stateMutability: 'view' }], reader, '0xabc');
    expect(notes.join()).toMatch(/is dead/);
    expect(fc(spec, 'g')).toBeNull();
  });
});

describe('round 6: dead statements in Rust compile logs (N29)', () => {
  it('an unused `let x = f()?;` becomes an error text that keeps the file location for blame', async () => {
    const { deadStatements } = await import('../src/pipeline/security.js');
    const log = `warning: unused variable: \`bal\`\n  --> programs/app/src/logic/transfer.rs:12:9\n   |\n12 |     let bal = helpers::load(&ctx.accounts.user)?;\n   |         ^^^ help: if this is intentional, prefix it with an underscore: \`_bal\`\n\nwarning: unused variable: \`unused_arg\`\n  --> programs/app/src/logic/x.rs:3:5\n   |\n3  |     amount: u64,\n   |     ^^^^^^`;
    const t = deadStatements(log);
    expect(t).toMatch(/--> programs\/app\/src\/logic\/transfer\.rs:12:9/);
    expect(t).toMatch(/let bal = helpers::load/);
    expect(t).not.toMatch(/unused_arg/);
    expect(deadStatements('Finished dev profile')).toBe('');
  });
});

describe('round 6: Tezos hash spelling (N30)', () => {
  it('keccak256(abi.encode(...)) always becomes sp.keccak(sp.pack(<tuple>))', async () => {
    const { buildDesign } = await import('../src/targets/tezos/design.js');
    const { normaliseBody } = await import('../src/targets/tezos/lint.js');
    const { load } = await import('./helpers.js');
    const { spec } = await load('CosmwasmLocker');
    const d = buildDesign(spec);
    const ctx = { d, h: d.instructions.find((h) => h.unit === 'ep_withdraw')!, spec };
    expect(normaliseBody('id = keccak256(abi.encode(target, value, data, eta))', ctx).body).toBe('id = sp.keccak(sp.pack((target, value, data, eta)))');
    expect(normaliseBody('id = keccak256(abi.encodePacked(a))', ctx).body).toBe('id = sp.keccak(sp.pack(a))');
    expect(normaliseBody('id = keccak256(abi.encode(f(a, b), c))', ctx).body).toBe('id = sp.keccak(sp.pack((f(a, b), c)))');
  });
});

describe('round 6: queue -> cancel scenario for timelock-style contracts (N30)', () => {
  it('queue, cancel with the same arguments, then execute (must fail) are generated and recorded on the original', async () => {
    const { hasAnvil } = await import('./helpers.js');
    if (!hasAnvil) return;
    const { OriginalRunner } = await import('../src/scenario/original.js');
    const { generateScenarios, recordGroundTruth } = await import('../src/scenario/generate.js');
    const { c, spec } = await compile(`contract X { address public admin; mapping(bytes32=>bool) public queued; uint public done;
      constructor() { admin = msg.sender; }
      function queue(address target, uint value, uint eta) external returns (bytes32 id) { require(msg.sender == admin, "a"); id = keccak256(abi.encode(target, value, eta)); queued[id] = true; }
      function cancel(address target, uint value, uint eta) external { require(msg.sender == admin, "a"); queued[keccak256(abi.encode(target, value, eta))] = false; }
      function execute(address target, uint value, uint eta) external { bytes32 id = keccak256(abi.encode(target, value, eta)); require(queued[id], "not queued"); queued[id] = false; done += value; } }`);
    const r = await OriginalRunner.start(c.abi, c.creation);
    try {
      const set = await generateScenarios(spec, r);
      const q = set.scenarios.filter((x) => x.id.startsWith('queue-'));
      expect(q.map((x) => x.fn).sort()).toEqual(['cancel', 'execute']);
      const cancelSc = q.find((x) => x.fn === 'cancel')!;
      expect(cancelSc.steps.filter((s) => s.type === 'call').map((s) => (s as { fn: string }).fn)).toEqual(expect.arrayContaining(['queue', 'cancel', 'execute']));
      await recordGroundTruth(set, r);
      const last = cancelSc.steps.filter((s) => s.type === 'call').pop() as { expect?: { status: string } };
      expect(last.expect?.status).toBe('revert');
    } finally { await r.stop(); }
  }, 60000);
});

describe('round 6: functions on unsupported state are excluded cleanly (Tezos)', () => {
  it('a function using a struct-valued bytes32 role map is not translated, the others stay', async () => {
    const { spec } = await compile(`contract X { struct RoleData { mapping(address=>bool) members; bytes32 adminRole; } mapping(bytes32=>RoleData) private _roles; uint public n;
      function grant(bytes32 r, address a) external { _roles[r].members[a] = true; } function bump() external { n++; } }`);
    const { buildDesign } = await import('../src/targets/tezos/design.js');
    const d = buildDesign(spec);
    expect(d.instructions.some((h) => h.solidity === 'grant')).toBe(false);
    expect(d.instructions.some((h) => h.solidity === 'bump')).toBe(true);
    expect(d.notTranslated.some((n) => n.where === 'grant')).toBe(true);
  });
});
