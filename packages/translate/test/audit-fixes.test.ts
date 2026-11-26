import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { compileVerified, compileWithAst, stdInputForSource } from '../src/spec/compile.js';
import { checkSpecAgainstAbi } from '../src/spec/gate.js';
import { extractSpec } from '../src/spec/extract.js';
import { erc20Delegation, permitLike } from '../src/spec/standard.js';
import { initialPlans } from '../src/spec/initial.js';
import { evalInitial } from '../src/spec/constant.js';
import { buildFunctionReports, clip, decideVerdict, renderReport, showValue } from '../src/pipeline/report.js';
import { SolanaPack } from '../src/targets/solana/pack.js';
import { CosmWasmPack } from '../src/targets/cosmwasm/pack.js';
import { AptosPack } from '../src/targets/aptos/pack.js';
import { TezosPack } from '../src/targets/tezos/pack.js';
import { buildDesign } from '../src/targets/solana/design.js';
import { load } from './helpers.js';

const vc = (n: string) => JSON.parse(readFileSync(new URL(`./fixtures/${n}.vc.json`, import.meta.url), 'utf8'));
const src = (body: string, pragma = '^0.8.0') => `pragma solidity ${pragma};\n${body}`;
const compile = async (body: string) => { const c = await compileWithAst({ compilerVersion: '0.8.28+commit.7893614a', stdJsonInput: stdInputForSource('X.sol', src(body)), contract: 'X' }); return extractSpec(c, {}); };

describe('custom ERC-20s are not delegated to the native token program', () => {
  it('USDT (pause, blacklist, fee, upgrade redirect): no delegation, behaviours listed', async () => {
    const spec = extractSpec(await compileVerified(vc('usdt')), {});
    const d = erc20Delegation(spec);
    expect(d.custom).toBe(true);
    expect([...d.delegate]).toEqual([]);
    expect(d.reasons.get('transfer')!.join(' ')).toMatch(/modifiers .*whenNotPaused|uses .*isBlackListed|external calls/);
    const design = buildDesign(spec);
    expect(design.instructions.map((i) => i.solidity)).toEqual(expect.arrayContaining(['transfer', 'transferFrom', 'approve']));
    expect(design.notTranslated.some((n) => n.feature === 'ERC-20 standard function')).toBe(false);
    expect(design.notes.join(' ')).toMatch(/NOT delegated to the SPL Token program/);
    expect(design.instructions.find((i) => i.solidity === 'transfer')!.notes.join(' ')).toMatch(/custom ERC-20 behaviour to preserve/);
  }, 60000);
  it('a plain ERC-20 still is delegated', async () => {
    const { spec } = await load('ERC20Token');
    expect(erc20Delegation(spec).custom).toBe(false);
  });
  it('a fee-on-transfer token and a max-uint approve are custom', async () => {
    const spec = await compile(`contract X { mapping(address=>uint) public balanceOf; mapping(address=>mapping(address=>uint)) public allowance; uint public totalSupply; uint public feeBps = 100; address public treasury;
      event Transfer(address indexed a, address indexed b, uint v); event Approval(address indexed a, address indexed b, uint v);
      function transfer(address to, uint v) public returns (bool) { uint fee = v * feeBps / 10000; balanceOf[msg.sender] -= v; balanceOf[to] += v - fee; balanceOf[treasury] += fee; emit Transfer(msg.sender, to, v); return true; }
      function approve(address s, uint v) public returns (bool) { allowance[msg.sender][s] = v; emit Approval(msg.sender, s, v); return true; }
      function transferFrom(address f, address to, uint v) public returns (bool) { if (allowance[f][msg.sender] != type(uint).max) allowance[f][msg.sender] -= v; balanceOf[f] -= v; balanceOf[to] += v; emit Transfer(f, to, v); return true; } }`);
    const d = erc20Delegation(spec);
    expect(d.custom).toBe(true);
    expect(d.reasons.get('transfer')!.join(' ')).toMatch(/feeBps/);
  });
});

describe('permit-style functions are not translated', () => {
  it('stakeWithPermit is flagged and every target lists it as not translated', async () => {
    const { spec } = await load('StakingRewards');
    expect(spec.functions.some(permitLike)).toBe(false);
    const s2 = await compile(`interface P { function permit(address,address,uint,uint,uint8,bytes32,bytes32) external; function transferFrom(address,address,uint) external returns (bool); }
      contract X { P public t; mapping(address=>uint) public staked; constructor(address a) { t = P(a); }
      function stakeWithPermit(uint amount, uint deadline, uint8 v, bytes32 r, bytes32 s) external { t.permit(msg.sender, address(this), amount, deadline, v, r, s); t.transferFrom(msg.sender, address(this), amount); staked[msg.sender] += amount; } }`);
    expect(s2.functions.filter(permitLike).map((f) => f.name)).toEqual(['stakeWithPermit']);
    for (const pack of [new SolanaPack(), new CosmWasmPack(), new AptosPack(), new TezosPack()]) {
      const d: any = pack.design(s2, {});
      expect(d.notTranslated.some((n: any) => /permit/.test(n.feature) && n.where === 'stakeWithPermit'), pack.id).toBe(true);
      expect(pack.units(d).join(' ')).not.toMatch(/stake_with_permit|stakeWithPermit/i);
    }
  });
});

describe('inline initialisers are evaluated by code and applied by generated code on every target', () => {
  const SRC = `contract X { uint256 public rewardsDuration = 60 days; uint256 public periodFinish = 0; uint256 public cap = 1 ether * 3; uint256 public constant BASE = 10 ** 6; uint256 public scaled = BASE * 2; bool public open = true;
    address public owner; mapping(address => uint) public bal; constructor() { owner = msg.sender; } function f(uint a) external { bal[msg.sender] += a * rewardsDuration; } }`;
  it('spec carries evaluated values for literals, unit literals, expressions and constants', async () => {
    const spec = await compile(SRC);
    const v = (n: string) => spec.stateVars.find((s) => s.name === n)!.initial;
    expect(v('rewardsDuration')).toEqual({ kind: 'uint', value: '5184000', via: 'ast' });
    expect(v('cap')).toEqual({ kind: 'uint', value: '3000000000000000000', via: 'ast' });
    expect(v('scaled')).toEqual({ kind: 'uint', value: '2000000', via: 'ast' });
    expect(v('open')).toEqual({ kind: 'bool', value: 'true', via: 'ast' });
    expect(spec.stateVars.find((s) => s.name === 'owner')!.initial).toBeUndefined();
    expect(initialPlans(spec).filter((p) => !p.zero).map((p) => p.sv.name).sort()).toEqual(['BASE'.toLowerCase() === 'x' ? '' : 'cap', 'open', 'rewardsDuration', 'scaled'].sort());
  });
  it('solana: the 60 days value is written into the config at the top of initialize', async () => {
    const spec = await compile(SRC);
    const pack = new SolanaPack();
    const design = pack.design(spec, {});
    const files = pack.assemble(spec, design, {});
    const init = files['programs/app/src/logic/initialize.rs']!;
    expect(init).toMatch(/config\.rewards_duration = 5184000u128;/);
    expect(init).toMatch(/config\.open = true;/);
    expect(init).not.toMatch(/period_finish =/); // zero: nothing to apply
  });
  it('cosmwasm: set_rewards_duration in instantiate', async () => {
    const spec = await compile(SRC);
    const pack = new CosmWasmPack();
    const files = pack.assemble(spec, pack.design(spec, {}), {});
    expect(files['src/handlers/instantiate.rs']).toMatch(/set_rewards_duration\(deps\.storage, &<Uint256 as std::str::FromStr>::from_str\("5184000"\)\.unwrap\(\)\)\?;/);
    expect(files['src/handlers/instantiate.rs']).toMatch(/set_open\(deps\.storage, &true\)/);
  });
  it('aptos: the value sits in the State literal of initialize', async () => {
    const spec = await compile(SRC);
    const pack = new AptosPack();
    const files = pack.assemble(spec, pack.design(spec, {}), {});
    const mv = Object.values(files).find((f) => /public entry fun initialize/.test(f))!;
    expect(mv).toMatch(/rewards_duration: 5184000u256,/);
  });
  it('tezos: the value is in the initial storage', async () => {
    const spec = await compile(SRC);
    const pack = new TezosPack();
    const files = pack.assemble(spec, pack.design(spec, {}), {});
    expect(files['contract_def.py']).toMatch(/self\.data\.rewards_duration = sp\.nat\(5184000\)/);
  });
  it('evalInitial refuses what is not a constant', () => {
    expect(evalInitial({ nodeType: 'Identifier', referencedDeclaration: 1 }, 'uint', 256, new Map())).toBeUndefined();
  });
});

describe('names that collide with Object.prototype members', () => {
  it('functions called toString / hasOwnProperty / valueOf / __proto__ survive design, report and lookups', async () => {
    const spec = await compile(`contract X { uint public a; function toString() public view returns (uint) { return a; } function hasOwnProperty(uint v) public { a = v; } function valueOf() public view returns (uint) { return a; } function __proto__(uint v) public { a = v + 1; } function isPrototypeOf() public {} }`);
    for (const pack of [new SolanaPack(), new CosmWasmPack(), new AptosPack(), new TezosPack()]) {
      const d: any = pack.design(spec, {});
      expect(Object.getPrototypeOf(d.observables)).toBeNull();
      expect(d.observables.toString?.kind ?? 'none').not.toBe(undefined);
      expect(typeof d.observables.hasOwnProperty === 'function').toBe(false);
    }
    // a function named like a prototype member never picks up a lookup result from Object.prototype
    const fnSpec: any = { ...spec, constructor: spec.functions[0], functions: spec.functions.filter((f) => f.kind === 'function') };
    const fidelity: Record<string, string> = {};
    const rows = buildFunctionReports(fnSpec, [], { unitOf: () => null, fidelity, notTranslatedFns: new Map(), differences: new Map(), template: false });
    expect(rows.map((r) => r.fidelity)).toEqual(rows.map(() => null));
    const md = renderReport({ version: 1, contract: 'X', source: {} as any, target: 'solana', path: 'model', status: 'PARTIALLY-VERIFIED', statusReasons: [], coverage: decideVerdict({ compileOk: true, ran: true, behaviourCheck: true, outcomes: [], conformance: [], functions: rows, template: false, set: { scenarios: [] } as any }).coverage, compile: { ok: true, round: 0, rounds: [] }, behaviour: { ran: true, passed: 0, failed: 0, notRunnable: 0, documented: 0, total: 0, rounds: [], conformance: [] }, functions: rows, nonPortable: [], notTranslated: [], designNotes: [], deploy: [], usage: { requests: 0, tokensIn: 0, tokensOut: 0, modelSecs: 0 }, wallSecs: 0, outcomes: [], scenarioCount: 0 });
    expect(md).not.toMatch(/native code|\[object|Object\(\)/);
  });
});

describe('target vocabulary stays inside its own pack', () => {
  const VOCAB: Record<string, RegExp> = {
    solana: /\bClock sysvar|\bCPI\b|lamports|\bSPL\b|borsh|\bAnchor\b|\bPDA\b|litesvm|Token-2022/i,
    cosmwasm: /\bcw20\b|CosmWasm|bech32|cw-multi-test|cw721/i,
    aptos: /\bMove\b|octas|Fungible Asset|\bAptos\b|resource account/,
    tezos: /SmartPy|Michelson|mutez|FA1\.2|Tezos|Ghostnet/i,
  };
  it('plan and report text of one target never mentions another target', async () => {
    const { spec } = await load('StakingRewards');
    const ms = await load('MultiSig2of3');
    const { spec: erc } = await load('ERC20Token');
    const packs = { solana: new SolanaPack(), cosmwasm: new CosmWasmPack(), aptos: new AptosPack(), tezos: new TezosPack() } as const;
    for (const [id, pack] of Object.entries(packs)) {
      for (const sp of [spec, ms.spec, erc]) {
        const tpl = pack.templates(sp, {});
        const design: any = tpl ? tpl.design : pack.design(sp, {});
        const text = [...(design.notes ?? []), ...(design.notTranslated ?? []).map((n: any) => `${n.feature} ${n.where} ${n.reason}`), ...(pack.describeNonPortable?.(sp) ?? sp.nonPortable).map((n) => `${n.title} ${n.detail}`), design.decimalsNote ?? '', design.allowanceNote ?? '', ...pack.deployCommands(design, sp)].join('\n');
        for (const [other, re] of Object.entries(VOCAB)) {
          if (other === id) continue;
          // Solana's own words must not appear in other targets (and vice versa); shared English words are not in the lists
          const hit = re.exec(text);
          expect(hit?.[0] ?? null, `${id} text (${sp.name}) mentions ${other}`).toBeNull();
        }
      }
    }
  });
});

describe('report text', () => {
  it('long values are elided in the middle with an explicit ellipsis, never cut inside a quoted value', () => {
    const h = '0x' + 'ab'.repeat(32);
    expect(clip(h, 200)).toBe(h);
    const long = '0x' + 'cd'.repeat(100);
    const c = clip(long, 60);
    expect(c.length).toBeLessThanOrEqual(60);
    expect(c).toContain('…');
    expect(c.startsWith('0xcdcd') && c.endsWith('cdcd')).toBe(true);
    expect(showValue({ hex: h })).toBe(JSON.stringify({ hex: h }));
    const s = showValue(['x', long], 40);
    expect(JSON.parse(s)[1]).toContain('…');
  });
});

describe('deploy recipes never carry test fixtures', () => {
  const FACTS = { name: 'ApeCoin', symbol: 'APE', decimals: 18, totalSupply: '1000000000000000000000000000', source: 'eth:0xabc' };
  it('with facts every target uses the original values; without them the recipes refuse', async () => {
    const { spec } = await load('ERC20Token');
    for (const pack of [new SolanaPack(), new CosmWasmPack(), new AptosPack(), new TezosPack()]) {
      const withF = pack.templates(spec, { facts: FACTS })!;
      const text = Object.values(withF.files).join('\n') + pack.deployCommands(withF.design, spec).join('\n');
      expect(text, pack.id).toMatch(/ApeCoin/);
      expect(text, pack.id).not.toMatch(/Test Token|"TST"|'TST'/);
      const without = pack.templates(spec, {})!;
      const t2 = Object.values(without.files).join('\n') + pack.deployCommands(without.design, spec).join('\n');
      expect(t2, pack.id).not.toMatch(/Test Token|"TST"|'TST'|1000000'?\b/);
      expect(t2, pack.id).toMatch(/<SET_|:\?set|\$\{TOKEN_NAME|sys\.exit/);
    }
  });
  it('a fixed-supply, non-ownable token gets its mint authority disabled (solana) and no MintRef (aptos)', async () => {
    const spec = await compile(`contract X { string public name = "T"; string public symbol = "T"; uint8 public decimals = 18; uint256 public totalSupply; mapping(address=>uint256) public balanceOf; mapping(address=>mapping(address=>uint256)) public allowance;
      event Transfer(address indexed a, address indexed b, uint v); event Approval(address indexed a, address indexed b, uint v);
      constructor(uint256 supply) { totalSupply = supply; balanceOf[msg.sender] = supply; emit Transfer(address(0), msg.sender, supply); }
      function transfer(address to, uint v) public returns (bool) { balanceOf[msg.sender] -= v; balanceOf[to] += v; emit Transfer(msg.sender, to, v); return true; }
      function approve(address s, uint v) public returns (bool) { allowance[msg.sender][s] = v; emit Approval(msg.sender, s, v); return true; }
      function transferFrom(address f, address to, uint v) public returns (bool) { allowance[f][msg.sender] -= v; balanceOf[f] -= v; balanceOf[to] += v; emit Transfer(f, to, v); return true; } }`);
    const sol = new SolanaPack().templates(spec, { facts: FACTS });
    if (sol) { expect(sol.files['deploy-devnet.sh']).toMatch(/spl-token authorize "\$MINT" mint --disable/); expect(JSON.parse(sol.files['token.json']!).mintAuthority).toBeNull(); }
    const apt = new AptosPack().templates(spec, { facts: FACTS });
    if (apt) { const mv = apt.files['sources/token.move']!; expect(mv).not.toMatch(/mint_ref: MintRef/); expect(mv).not.toMatch(/burn_ref: BurnRef/); }
    expect(sol || apt).toBeTruthy();
  });
});

describe('no other target\'s vocabulary in any generated text (source scan + compare notes)', () => {
  it('shared and non-Solana code never emits Solana wording (covers report.json fields such as comparison notes)', async () => {
    const { readdirSync, readFileSync: rf, statSync } = await import('node:fs');
    const { join } = await import('node:path');
    const root = new URL('../src/', import.meta.url).pathname;
    const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : f.endsWith('.ts') ? [join(d, f)] : []));
    const files = walk(root).filter((f) => !/\/targets\/solana\//.test(f) && !/targets\/info\.ts$/.test(f) && !/spec\/standard\.ts$/.test(f) && !/index\.ts$/.test(f));
    const offenders: string[] = [];
    for (const f of files) for (const [i, line] of rf(f, 'utf8').split('\n').entries()) {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
      const str = [...line.matchAll(/(['`"])((?:\\.|(?!\1).)*)\1/g)].map((m) => m[2]!).join(' ');
      if (/Solana|\bSPL\b|lamports|Anchor/.test(str) && !/Solana wording|local Solana runtime|native SPL token/.test(str)) offenders.push(`${f.slice(root.length)}:${i + 1}: ${str.slice(0, 80)}`);
    }
    expect(offenders).toEqual([]);
  });
});

describe('inherited behaviour reached through super / Base.f() calls', () => {
  it('USDT transfer carries the events and the recipient mapping access of BasicToken.transfer', async () => {
    const spec = extractSpec(await compileVerified(JSON.parse(readFileSync(new URL('./fixtures/usdt.vc.json', import.meta.url), 'utf8'))), {});
    const t = spec.functions.find((f) => f.name === 'transfer')!;
    expect(t.events).toContain('Transfer');
    expect(t.mappingAccesses.some((m) => m.variable === 'balances' && m.write && m.keys[0]?.kind === 'param')).toBe(true);
    expect(spec.functions.find((f) => f.name === 'transferFrom')!.events).toContain('Transfer');
    const { genEvents } = await import('../src/targets/solana/codegen.js');
    expect(genEvents(spec)).toMatch(/pub struct Transfer \{/);
  }, 60000);
});

describe('templates list the capabilities they ADD', () => {
  it('a non-burnable ERC-20 gets burn listed as an extra capability on cw20 and SPL', async () => {
    const spec = await compile(`contract X { string public name = "T"; string public symbol = "TTT"; uint8 public decimals = 18; uint256 public totalSupply; mapping(address=>uint256) public balanceOf; mapping(address=>mapping(address=>uint256)) public allowance;
      event Transfer(address indexed a, address indexed b, uint v); event Approval(address indexed a, address indexed b, uint v);
      constructor(uint256 supply) { totalSupply = supply; balanceOf[msg.sender] = supply; }
      function transfer(address to, uint v) public returns (bool) { balanceOf[msg.sender] -= v; balanceOf[to] += v; emit Transfer(msg.sender, to, v); return true; }
      function approve(address s, uint v) public returns (bool) { allowance[msg.sender][s] = v; emit Approval(msg.sender, s, v); return true; }
      function transferFrom(address f, address to, uint v) public returns (bool) { allowance[f][msg.sender] -= v; balanceOf[f] -= v; balanceOf[to] += v; emit Transfer(f, to, v); return true; } }`);
    for (const pack of [new CosmWasmPack(), new SolanaPack()]) {
      const t = pack.templates(spec, {});
      if (!t) continue;
      expect((t.design as any).extraCapabilities.map((x: any) => x.name).join(' '), pack.id).toMatch(/burn/);
    }
  });
});

describe('overloads and unsupported sources', () => {
  it('overloaded public functions are keyed by signature through spec, design, units, scenarios and the gate', async () => {
    const c = await compileWithAst({ compilerVersion: '0.8.28+commit.7893614a', stdJsonInput: stdInputForSource('X.sol', src(`contract X { uint public total; event E(uint v);
      function put(uint a) external { total += a; emit E(a); }
      function put(uint a, uint b) external { total += a + b; emit E(a + b); }
      function put(address who) external { if (who != address(0)) total += 1; } }`)), contract: 'X' });
    const spec = extractSpec(c, {});
    const names = spec.functions.filter((f) => f.kind === 'function').map((f) => f.name).sort();
    expect(names).toEqual(['put_address', 'put_uint256', 'put_uint256_uint256']);
    expect(spec.functions.find((f) => f.name === 'put_uint256_uint256')!.solidityName).toBe('put');
    expect(checkSpecAgainstAbi(spec, c.abi).problems).toEqual([]);
    for (const pack of [new SolanaPack(), new CosmWasmPack(), new AptosPack(), new TezosPack()]) {
      const d: any = pack.design(spec, {});
      expect(pack.units(d).filter((u) => /put/i.test(u)).length, pack.id).toBe(3);
    }
    const { OriginalRunner } = await import('../src/scenario/original.js');
    const { generateScenarios } = await import('../src/scenario/generate.js');
    const { hasAnvil } = await import('./helpers.js');
    if (hasAnvil) {
      const r = await OriginalRunner.start(c.abi, c.creation);
      try {
        const set = await generateScenarios(spec, r);
        const called = new Set(set.scenarios.flatMap((s) => s.steps).flatMap((st) => (st.type === 'call' && st.fn.startsWith('put') ? [st.fn] : [])));
        expect([...called].sort()).toEqual(['put_address', 'put_uint256', 'put_uint256_uint256']);
      } finally { await r.stop(); }
    }
  }, 60000);
  it('Vyper and Solidity before 0.4.12 are a typed UnsupportedSourceError (code UNSUPPORTED)', async () => {
    const { assertSupportedSource, UnsupportedSourceError } = await import('../src/spec/legacy.js');
    for (const [lang, ver] of [['Vyper', '0.3.7'], ['Solidity', '0.4.11+commit.68ef5810'], ['Solidity', '0.3.6']] as const) {
      let err: any; try { assertSupportedSource(lang, ver); } catch (e) { err = e; }
      expect(err, `${lang} ${ver}`).toBeInstanceOf(UnsupportedSourceError);
      expect(err).toMatchObject({ code: 'UNSUPPORTED', language: lang, version: ver });
    }
    expect(() => assertSupportedSource('Solidity', '0.4.12+commit.194ff033')).not.toThrow();
    expect(() => assertSupportedSource('Solidity', '0.8.28+commit.7893614a')).not.toThrow();
  });
});

describe('round 3: constructors and seeds', () => {
  it('base constructor arguments in the inheritance list and base bodies form the effective constructor', async () => {
    const spec = await compile(`contract D { string public name; string public symbol; uint8 public decimals; constructor(string memory n, string memory s, uint8 d) { name = n; symbol = s; decimals = d; } }
      contract O { address public owner; constructor() { owner = msg.sender; } }
      contract X is O, D("Wrapped BTC", "WBTC", 8) { mapping(address=>uint) public balanceOf; }`);
    const c = spec.constructor!;
    expect(c).not.toBeNull();
    expect(c.writes).toEqual(expect.arrayContaining(['name', 'symbol', 'decimals', 'owner']));
    expect(c.senderAssignments).toEqual(['owner']);
    const iv = (n: string) => spec.stateVars.find((v) => v.name === n)!.initial;
    expect(iv('name')).toEqual({ kind: 'string', value: 'Wrapped BTC', via: 'ast' });
    expect(iv('decimals')).toMatchObject({ kind: 'uint', value: '8' });
  });
  it('modifier-style base constructor calls bind to the derived constructor parameters', async () => {
    const spec = await compile(`contract B { uint public cap; constructor(uint c) { cap = c; } } contract X is B { constructor(uint limit) B(limit) {} }`);
    expect(spec.constructor!.paramAssignments).toEqual([{ param: 'limit', stateVar: 'cap' }]);
  });
  it('Solana: a seed never reads a field of the account created by the same instruction (owner = msg.sender becomes the signer)', async () => {
    const spec = await compile(`contract O { address public owner; constructor() { owner = msg.sender; } }
      contract X is O { mapping(address=>uint) public balances; constructor(uint s) { balances[owner] = s; } }`);
    const d = new SolanaPack().design(spec, {});
    const init = d.instructions.find((i) => i.kind === 'initialize')!;
    const entry = init.accounts.find((r) => r.kind === 'entry')!;
    expect(entry.keys).toEqual([{ kind: 'caller' }]);
    const { selfReferentialSeeds } = await import('../src/targets/solana/design.js');
    expect(selfReferentialSeeds(d)).toEqual([]);
    const bad: any = { instructions: [{ name: 'initialize', accounts: [{ name: 'config', kind: 'config', init: 'init' }, { name: 'user_owner', kind: 'entry', keys: [{ kind: 'config', field: 'owner' }] }] }] };
    expect(selfReferentialSeeds(bad)[0]).toMatch(/derives a PDA seed from config\.owner, but config is created by the same instruction/);
  });
  it('the real USDT design has no self-referential seed', async () => {
    const spec = extractSpec(await compileVerified(JSON.parse(readFileSync(new URL('./fixtures/usdt.vc.json', import.meta.url), 'utf8'))), {});
    const { selfReferentialSeeds } = await import('../src/targets/solana/design.js');
    expect(selfReferentialSeeds(new SolanaPack().design(spec, {}) as any)).toEqual([]);
  }, 60000);
});

describe('round 3: report prose and the plan', () => {
  it('ell() closes what it cut open and never cuts silently', async () => {
    const { ell } = await import('../src/pipeline/report.js');
    const t = 'Mechanical normalisation (kinds: `a - b` of nats wrapped in "sp.as_nat" (underflow) and more text here)';
    const e = ell(t, 60);
    expect(e).toContain('…');
    expect((e.match(/\(/g) ?? []).length).toBe((e.match(/\)/g) ?? []).length);
    expect((e.match(/`/g) ?? []).length % 2).toBe(0);
    expect((e.match(/"/g) ?? []).length % 2).toBe(0);
    expect(ell('short', 60)).toBe('short');
  });
  it('the template header does not repeat "no model-written code"', async () => {
    const { renderReport } = await import('../src/pipeline/report.js');
    const { spec } = await load('ERC20Token');
    const t = new AptosPack().templates(spec, {})!;
    const rep: any = { version: 1, contract: 'X', source: {}, target: 'aptos', path: 'template', standard: 'ERC-20', status: 'PASSED', statusReasons: [], coverage: { functionsTotal: 0, functionsVerified: 0, functionsAbsent: [], functionsPresent: 0, functionsUnverified: [], failedFunctions: [], otherUnverifiedFunctions: [], uncheckedFunctions: [], trivialOnlyFunctions: [], notTranslatedFunctions: [], uncomparedReturns: [], notRunnableScenarios: [], getters: { planned: 0, checked: 0, mismatched: 0, notCompared: [] }, summary: 's' }, compile: { ok: true, round: 0, rounds: [] }, behaviour: { ran: true, passed: 0, failed: 0, notRunnable: 0, documented: 0, total: 0, rounds: [], conformance: [] }, functions: [], nonPortable: [], notTranslated: [], designNotes: [], extraCapabilities: [], deploy: [], usage: { requests: 0, tokensIn: 0, tokensOut: 0, modelSecs: 0 }, wallSecs: 0, outcomes: [], scenarioCount: 0, labels: new AptosPack().reportLabels };
    void t;
    const line = renderReport(rep).split('\n').find((l) => l.startsWith('**Result'))!;
    expect((line.match(/no model-written code/g) ?? []).length).toBe(1);
  });
  it('Tezos entrypoint names over 31 characters become deterministic short names, units and functions agree', async () => {
    const spec = await compile(`contract X { uint public t; struct S { uint a; } function transferFromSomethingVeryLongName(address a, address b, uint160 c, address d) external { t += c; } function transferFromSomethingVeryLongName(uint a) external { t += a; } }`);
    const pack = new TezosPack();
    const d: any = pack.design(spec, {});
    const names = pack.units(d);
    expect(names.every((u: string) => u.replace(/^ep_/, '').length <= 31)).toBe(true);
    expect(new Set(names).size).toBe(names.length);
    expect(d.notes.join(' ')).toMatch(/deterministic short name/);
  });
  it('on every target each translatable public function maps to exactly one unit (no collapsing, no cut names)', async () => {
    const spec = await compile(`contract X { uint public t; mapping(address=>uint) public bal;
      function put(uint a) external { t += a; } function put(uint a, uint b) external { t += a + b; } function put(address w) external { bal[w] += 1; }
      function get() external view returns (uint) { return t; } function get(address w) external view returns (uint) { return bal[w]; } }`);
    const fns = spec.functions.filter((f) => f.kind === 'function' && (f.visibility === 'external' || f.visibility === 'public'));
    for (const pack of [new SolanaPack(), new CosmWasmPack(), new AptosPack(), new TezosPack()]) {
      const d: any = pack.design(spec, {});
      const units = fns.map((f) => pack.unitOf(d, f.name));
      expect(units.every((u) => u), `${pack.id} ${units}`).toBe(true);
      expect(new Set(units).size, pack.id).toBe(fns.length);
      for (const u of units) expect(pack.units(d).includes(u!) || d.instructions.some((i: any) => (i.unit ?? i.name) === u), `${pack.id} ${u}`).toBe(true);
    }
  });
});

describe('round 3: proxies target the implementation', () => {
  const IMPL = `contract Impl { uint public cap; address public owner; bool private done; constructor() { done = true; }
    function initialize(uint c) public { require(!done, "init"); done = true; cap = c; owner = msg.sender; }
    function bump(uint a) external { cap += a; } }`;
  const vcOf = (over: any) => ({ address: '0xP', name: 'TransparentUpgradeableProxy', abi: [], proxy: { isProxy: false, type: null, implementations: [] }, ...over }) as any;
  it('a proxy resolves to its implementation (provider flag, EIP-1967 slot, beacon, minimal proxy) and carries the initialiser', async () => {
    const { resolveRewriteTarget } = await import('../src/spec/proxy.js');
    const impl: any = { address: '0xIMPL', name: 'Impl', abi: [{ type: 'function', name: 'initialize', stateMutability: 'nonpayable', inputs: [{ name: 'c', type: 'uint256' }], outputs: [] }] };
    const fetchImpl = async (_c: any, a: string) => ({ ...impl, address: a });
    const A = '0x' + '00'.repeat(12) + 'ab'.repeat(20);
    const flagged = await resolveRewriteTarget('eth', vcOf({ proxy: { isProxy: true, type: 'transparent', implementations: ['0x' + 'cd'.repeat(20)] } }), { reader: null, fetchImpl });
    expect(flagged.vc.name).toBe('Impl');
    expect(flagged.proxy).toMatchObject({ address: '0xP', type: 'transparent', implementationName: 'Impl', proxyName: 'TransparentUpgradeableProxy', initializer: 'initialize' });
    const bySlot = await resolveRewriteTarget('eth', vcOf({}), { reader: { getCode: async () => '0x', getStorageAt: async (_a, s) => (s.startsWith('0x360894') ? A : '0x' + '00'.repeat(32)), call: async () => undefined }, fetchImpl });
    expect(bySlot.proxy).toMatchObject({ type: 'EIP-1967', implementation: '0x' + 'ab'.repeat(20) });
    const beacon = await resolveRewriteTarget('eth', vcOf({ name: 'BeaconProxy' }), { reader: { getCode: async () => '0x', getStorageAt: async (_a, s) => (s.startsWith('0xa3f0ad') ? A : '0x' + '00'.repeat(32)), call: async () => '0x' + '00'.repeat(12) + 'ef'.repeat(20) }, fetchImpl });
    expect(beacon.proxy).toMatchObject({ type: 'EIP-1967 beacon', implementation: '0x' + 'ef'.repeat(20) });
    const mini = await resolveRewriteTarget('eth', vcOf({ name: 'Clone' }), { reader: { getCode: async () => '0x363d3d373d3d3d363d73' + '12'.repeat(20) + '5af43d82803e903d91602b57fd5bf3', getStorageAt: async () => '0x' + '00'.repeat(32), call: async () => undefined }, fetchImpl });
    expect(mini.proxy).toMatchObject({ type: 'EIP-1167' });
    const plain = await resolveRewriteTarget('eth', vcOf({ name: 'Token', abi: [{ type: 'function', name: 'balanceOf' }] }), { reader: { getCode: async () => '0x6080', getStorageAt: async () => '0x' + '00'.repeat(32), call: async () => undefined }, fetchImpl });
    expect(plain.proxy).toBeNull();
  });
  it('an unresolvable proxy shell is refused, never rewritten', async () => {
    const { resolveRewriteTarget } = await import('../src/spec/proxy.js');
    await expect(resolveRewriteTarget('eth', vcOf({}), { reader: { getCode: async () => '0x', getStorageAt: async () => '0x' + '00'.repeat(32), call: async () => undefined } })).rejects.toMatchObject({ code: 'UNSUPPORTED', message: expect.stringMatching(/refusing to rewrite the proxy shell/) });
  });
  it('the initialiser becomes the constructor, upgradeability is listed, and the gate accepts it', async () => {
    const c = await compileWithAst({ compilerVersion: '0.8.28+commit.7893614a', stdJsonInput: stdInputForSource('X.sol', src(IMPL)), contract: 'Impl' });
    const proxy = { address: '0xP', type: 'transparent', implementation: '0xI', proxyName: 'TransparentUpgradeableProxy', implementationName: 'Impl', initializer: 'initialize' };
    const spec = extractSpec(c, { proxy });
    expect(spec.constructor!.params.map((p) => p.name)).toEqual(['c']);
    expect(spec.constructor!.writes).toEqual(expect.arrayContaining(['cap', 'owner']));
    expect(spec.functions.map((f) => f.name)).not.toContain('initialize');
    expect(spec.nonPortable.map((n) => n.id)).toContain('upgradeability');
    expect(spec.proxy?.implementationName).toBe('Impl');
    expect(checkSpecAgainstAbi(spec, c.abi).problems).toEqual([]);
  });
  it('ground truth runs through a proxy: the initialiser executes via delegatecall with the deployer as msg.sender', async () => {
    const { hasAnvil } = await import('./helpers.js');
    if (!hasAnvil) return;
    const c = await compileWithAst({ compilerVersion: '0.8.28+commit.7893614a', stdJsonInput: stdInputForSource('X.sol', src(IMPL)), contract: 'Impl' });
    const proxy = { address: '0xP', type: 'transparent', implementation: '0xI', proxyName: 'P', implementationName: 'Impl', initializer: 'initialize' };
    const spec = extractSpec(c, { proxy });
    const { OriginalRunner } = await import('../src/scenario/original.js');
    const { generateScenarios, recordGroundTruth } = await import('../src/scenario/generate.js');
    const init = (c.abi as any[]).find((x) => x.name === 'initialize');
    const r = await OriginalRunner.start(c.abi, c.creation, undefined, { proxy: { initializer: init } });
    try {
      const set = await generateScenarios(spec, r);
      await recordGroundTruth(set, r);
      const initSc = set.scenarios.find((s) => s.id.startsWith('init-01'))!;
      expect(initSc.deploy.expect?.status).toBe('success');
      const capStep = initSc.steps.find((s) => s.type === 'view' && s.fn === 'cap') as any;
      expect(capStep.expect).not.toBe('0'); // the initialiser really ran (a bare implementation deploy would leave cap = 0)
      const ownerStep = initSc.steps.find((s) => s.type === 'view' && s.fn === 'owner') as any;
      expect(ownerStep.expect).toBe('actor:deployer');
    } finally { await r.stop(); }
  }, 60000);
});

describe('round 3: owner = msg.sender from a base constructor is applied by generated code', () => {
  it('all four targets set the signer', async () => {
    const spec = await compile(`contract O { address public owner; constructor() { owner = msg.sender; } } contract X is O { uint public v; function set(uint a) external { require(msg.sender == owner); v = a; } }`);
    expect(new CosmWasmPack().assemble(spec, new CosmWasmPack().design(spec, {}), {})['src/handlers/instantiate.rs']).toMatch(/set_owner\(deps\.storage, &info\.sender\.clone\(\)\)\?/);
    const sp = new SolanaPack(); expect(sp.assemble(spec, sp.design(spec, {}), {})['programs/app/src/logic/initialize.rs']).toMatch(/config\.owner = ctx\.accounts\.caller\.key\(\);/);
    const ap = new AptosPack(); expect(Object.values(ap.assemble(spec, ap.design(spec, {}), {})).join('\n')).toMatch(/owner: signer::address_of\(caller\)/);
    const tp = new TezosPack(); expect(tp.assemble(spec, tp.design(spec, {}), {})['contract_def.py']).toMatch(/self\.data\.owner = sp\.sender/);
  });
});

describe('round 4: initialisers and upgrade plumbing are never exposed', () => {
  const SRC4 = `contract U { bool private _initialized; uint8 public version; address public owner; string public name; uint256[50] private __gap; mapping(address=>uint) public balanceOf;
    modifier initializer() { require(!_initialized, "already"); _initialized = true; _; }
    modifier reinit(uint8 v) { require(version < v, "ver"); _; version = v; }
    function initialize(string memory n, address o) public initializer { name = n; owner = o; }
    function initializeV2(string memory n) external reinit(2) { name = n; }
    function initializeV2_1(address lost) external reinit(3) { owner = lost; }
    function upgradeTo(address impl) external { owner = impl; }
    function proxiableUUID() external pure returns (bytes32) { return bytes32(uint256(1)); }
    function mint(uint a) external { require(msg.sender == owner, "no"); balanceOf[msg.sender] += a; } }`;
  it('spec: initialisers / upgrade functions are excluded, the main initialiser is the constructor, gaps and bookkeeping are not state', async () => {
    const c = await compileWithAst({ compilerVersion: '0.8.28+commit.7893614a', stdJsonInput: stdInputForSource('U.sol', src(SRC4)), contract: 'U' });
    const spec = extractSpec(c, {});
    expect(spec.constructor!.params.map((p) => p.name)).toEqual(['n', 'o']);
    expect(spec.foldedInitializer).toBe('initialize');
    const ex = Object.fromEntries(spec.functions.filter((f) => f.excluded).map((f) => [f.name, f.excluded!.category]));
    expect(ex).toEqual({ initializeV2: 'initializer', initializeV2_1: 'initializer', upgradeTo: 'upgrade', proxiableUUID: 'upgrade' });
    expect(spec.stateVars.map((v) => v.name)).not.toEqual(expect.arrayContaining(['__gap']));
    expect(spec.stateVars.map((v) => v.name)).not.toContain('_initialized');
    expect(checkSpecAgainstAbi(spec, c.abi).problems).toEqual([]);
    for (const pack of [new SolanaPack(), new CosmWasmPack(), new AptosPack(), new TezosPack()]) {
      const d: any = pack.design(spec, {});
      const units = pack.units(d).join(' ');
      expect(units, pack.id).not.toMatch(/initialize_?v2|initializeV2|upgrade_?to|upgradeTo|proxiable/i);
      expect(d.notTranslated.filter((n: any) => /initialiser|upgrade/.test(n.feature)).map((n: any) => n.where).sort(), pack.id).toEqual(['initializeV2', 'initializeV2_1', 'proxiableUUID', 'upgradeTo']);
      // not even a mention of the gap in the generated state
      expect(JSON.stringify(d).includes('__gap') || JSON.stringify(d).includes('gap_'), pack.id).toBe(false);
    }
  });
  it('the original rejects the probes; a rewrite without those entry points passes the security check', async () => {
    const { hasAnvil } = await import('./helpers.js');
    if (!hasAnvil) return;
    const c = await compileWithAst({ compilerVersion: '0.8.28+commit.7893614a', stdJsonInput: stdInputForSource('U.sol', src(SRC4)), contract: 'U' });
    const spec = extractSpec(c, {});
    const { OriginalRunner } = await import('../src/scenario/original.js');
    const { generateScenarios, recordGroundTruth } = await import('../src/scenario/generate.js');
    const init = (c.abi as any[]).find((x) => x.name === 'initialize');
    const r = await OriginalRunner.start(c.abi, c.creation, undefined, { proxy: { initializer: init } });
    try {
      const set = await generateScenarios(spec, r);
      await recordGroundTruth(set, r);
      const probes = set.scenarios.filter((s) => s.probe);
      expect(probes.map((s) => s.probe).sort()).toEqual(['initializeV2', 'initializeV2_1', 'upgradeTo']); // probed whatever the local original answers: the rule is absolute
      expect(probes.every((s) => s.deploy.expect?.status === 'success' && s.steps.every((st) => st.type === 'call' && st.actor === 'mallory'))).toBe(true);
      expect(set.scenarios.some((s) => s.steps.some((st) => st.type === 'call' && /^initializeV2|^upgradeTo/.test(st.fn) && !s.probe))).toBe(false);
    } finally { await r.stop(); }
  }, 60000);
});

describe('round 4: custom token on Solana, aliasing, string getters', () => {
  const TOK = `contract O { address public owner; constructor() { owner = msg.sender; } }
    contract T is O { string public name; string public symbol; uint public basisPointsRate = 10; mapping(address=>uint) public balances; uint public _totalSupply;
      constructor(uint s, string memory n, string memory sy) { _totalSupply = s; balances[owner] = s; name = n; symbol = sy; }
      function transfer(address to, uint v) public returns (bool) { uint fee = v * basisPointsRate / 10000; balances[msg.sender] -= v; balances[to] += v - fee; balances[owner] += fee; return true; }
      mapping(address=>mapping(address=>uint)) public allowance; uint public paused2; function totalSupply() public view returns (uint) { return _totalSupply; } event Transfer(address indexed a, address indexed b, uint v); event Approval(address indexed a, address indexed b, uint v);
      function approve(address s2, uint v) public returns (bool) { allowance[msg.sender][s2] = v; emit Approval(msg.sender, s2, v); return true; }
      function transferFrom(address f, address to, uint v) public returns (bool) { allowance[f][msg.sender] -= v; balances[f] -= v; balances[to] += v; emit Transfer(f, to, v); return true; }
      function balanceOf(address a) public view returns (uint) { return balances[a]; } }`;
  it('a program-state token uses ONE unit everywhere: no divisor, no token-scaled amount, string getters observable, aliasable entries are dup', async () => {
    const spec = await compile(TOK.replace('contract T is O', 'contract X is O'));
    const d = new SolanaPack().design(spec, {});
    expect(d.decimals.divisor).toBe('1');
    const scales = new Set<string>();
    for (const ins of d.instructions) { for (const a of ins.args) scales.add(a.scale); if (ins.returns) scales.add(ins.returns.scale); }
    for (const a of d.accounts) for (const f of a.fields) scales.add(f.scale);
    expect(scales.has('token')).toBe(false);
    expect(d.observables.name).toMatchObject({ kind: 'config-field' });
    expect(d.observables.symbol).toMatchObject({ kind: 'config-field' });
    const tr = d.instructions.find((i) => i.solidity === 'transfer')!;
    const dup = tr.accounts.filter((r) => r.kind === 'entry' && r.dup);
    expect(dup.length).toBeGreaterThanOrEqual(2);
    expect(dup[0]!.note).toMatch(/SAME account/);
  });
});
