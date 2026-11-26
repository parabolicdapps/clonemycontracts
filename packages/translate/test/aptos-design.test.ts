import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AptosPack } from '../src/targets/aptos/pack.js';
import { buildAptosDesign, evalConstant, moveType, scaleOfName } from '../src/targets/aptos/design.js';
import { acquiresFor, annotateLog, genHandler, genModule, indentBody } from '../src/targets/aptos/codegen.js';
import { FRAMEWORK_CALLS_USED } from '../src/targets/aptos/helpers.js';
import { errorBlocks, failingUnits, hintsFor, helpersFor, instructionPrompt, sourceLookup } from '../src/targets/aptos/prompts.js';
import { genTokenModule } from '../src/targets/aptos/template.js';
import { genNftModule } from '../src/targets/aptos/template-nft.js';
import { ident } from '../src/targets/aptos/names.js';
import { load } from './helpers.js';

const api = JSON.parse(readFileSync(new URL('../targets/aptos/api.json', import.meta.url), 'utf8')) as Record<string, Record<string, { arity: number; testOnly?: boolean }>>;

describe('aptos design (deterministic)', () => {
  it('identifiers avoid Move keywords and generated names', () => {
    expect(ident('rewardPerTokenStored')).toBe('reward_per_token_stored');
    expect(ident('_owner')).toBe('owner');
    expect(ident('address')).toBe('address_');
    expect(ident('caller')).toBe('caller_');
  });
  it('types, scales and constants', () => {
    expect(moveType({ solidity: 'uint8', kind: 'uint', bits: 8 })).toBe('u8');
    expect(moveType({ solidity: 'uint256', kind: 'uint', bits: 256 })).toBe('u256');
    expect(moveType({ solidity: 'uint64', kind: 'uint', bits: 64 })).toBe('u64');
    expect(moveType({ solidity: 'address', kind: 'address' })).toBe('address');
    expect(scaleOfName('rewardPerTokenStored', { solidity: 'uint256', kind: 'uint' }, false)).toBe('ratio');
    expect(evalConstant('1e18')).toBe(10n ** 18n);
    expect(evalConstant('7 days')).toBe(604800n);
    expect(evalConstant('10 ** 6')).toBe(1000000n);
    expect(evalConstant('foo()')).toBeNull();
  });
  it('MultiSig: struct abilities, composite key, fixed array, payable receive, error codes from the revert messages', async () => {
    const { spec } = await load('MultiSig2of3');
    const d = buildAptosDesign(spec);
    const tx = d.structs.find((s) => s.name === 'Tx')!;
    expect(tx.abilities).toEqual(['copy', 'drop', 'store']);
    expect(tx.fields.map((f) => `${f.name}:${f.move}`)).toEqual(['to:address', 'value:u256', 'data:vector<u8>', 'executed:bool', 'confirmations:u8']);
    const key = d.structs.find((s) => s.role === 'key')!;
    expect(key.fields.map((f) => f.move)).toEqual(['u256', 'address']);
    expect(d.tables.find((t) => t.solidity === 'confirmed')!.tableKey).toBe(key.name);
    expect(d.arrays.find((a) => a.solidity === 'owners')).toMatchObject({ fixed: 3 });
    expect(d.arrays.find((a) => a.solidity === 'txs')).toMatchObject({ fixed: null });
    const dep = d.instructions.find((i) => i.kind === 'receive')!;
    expect(dep.name).toBe('deposit');
    expect(dep.params.at(-1)).toMatchObject({ name: 'value', move: 'u256' });
    expect(d.errors.map((e) => e.name)).toEqual(expect.arrayContaining(['E_NOT_OWNER', 'E_ALREADY_EXECUTED', 'E_NEED_2_CONFIRMATIONS', 'E_CALL_FAILED', 'E_BAD_OWNER']));
    expect(d.usesNative).toBe(true);
    expect(d.helpers.map((h) => h.name)).toEqual(expect.arrayContaining(['native_push', 'push_txs', 'get_txs', 'set_confirmed', 'len_txs']));
    // the struct getter becomes a tuple-returning view that the scenarios can read
    expect(d.observables.getTx).toMatchObject({ kind: 'view', fn: 'get_tx' });
  });
  it('StakingRewards: tokens come from constructor parameters; pull/push helpers; ratio scale for the per-token value', async () => {
    const { spec } = await load('StakingRewards');
    const d = buildAptosDesign(spec);
    expect(d.tokens.map((t) => t.key)).toEqual(['staking_token', 'reward_token']);
    expect(d.helpers.map((h) => h.name)).toEqual(expect.arrayContaining(['staking_token_pull', 'reward_token_push', 'get_reward_per_token_stored']));
    const init = d.instructions.find((i) => i.kind === 'initialize')!;
    expect(init.params.map((p) => `${p.name}:${p.move}`)).toEqual(['staking:address', 'reward:address']);
    expect(d.observables.rewardPerToken).toMatchObject({ kind: 'view', scales: ['ratio'] });
    expect(d.usesNative).toBe(false);
  });
  it('acquires are computed from the body, never by the model', async () => {
    const { spec } = await load('LinearVesting');
    const d = buildAptosDesign(spec);
    const fund = d.instructions.find((i) => i.name === 'fund')!;
    expect(acquiresFor(d, 'assert!(true, E_REVOKED);', fund)).toBe(false);
    expect(acquiresFor(d, 'let r = get_revoked();', fund)).toBe(true);
    expect(acquiresFor(d, 'borrow_global<State>(@0x1);', fund)).toBe(true);
    expect(genHandler(d, fund, 'let r = get_revoked();')).toContain('acquires State {');
    expect(genHandler(d, fund, undefined)).toContain('abort 0   // STUB');
    expect(indentBody('    a;\n      b;')).toBe('        a;\n          b;');
  });
  it('generated module: units are marked, signatures come from the design, imports follow usage', async () => {
    const { spec } = await load('LinearVesting');
    const d = buildAptosDesign(spec);
    const text = genModule(spec, d, {});
    for (const i of d.instructions) { expect(text).toContain(`// <<unit ${i.name}>>`); expect(text).toContain(`// <<end ${i.name}>>`); }
    expect(text).toContain('public entry fun fund(caller: &signer, amount: u256)');
    expect(text).toContain('#[view]\n    public fun vested(): u256');
    expect(text).toContain('create_resource_account(caller, b"cmc_state")');
    expect(text).not.toContain('aptos_account');
    expect(text).toContain('use aptos_framework::primary_fungible_store;');
  });
  it('compile log lines are attributed to the unit whose markers enclose them', async () => {
    const { spec } = await load('LinearVesting');
    const d = buildAptosDesign(spec);
    const files = new AptosPack().assemble(spec, d, {});
    const src = files['sources/linear_vesting.move']!.split('\n');
    const line = src.findIndex((l) => l.includes('// STUB') && src.slice(0, src.indexOf(l)).length >= 0) + 1;
    const log = `[aptos] error: boom\n[aptos]    ┌─ /tmp/x/sources/linear_vesting.move:${line}:9\n[aptos]    │\n[aptos] warning: x\n`;
    const ann = annotateLog(log, files);
    expect(ann).toMatch(/\[unit \w+\]/);
    expect(failingUnits(ann, d).units.size).toBe(1);
    expect(errorBlocks(ann).length).toBe(1);
  });
  it('prompt restricts the cheat sheet to the state the function touches and lists the generated signature', async () => {
    const { spec } = await load('StakingRewards');
    const d = buildAptosDesign(spec);
    const stake = d.instructions.find((i) => i.name === 'stake')!;
    const names = helpersFor(d, stake).map((h) => h.name);
    expect(names).toContain('staking_token_pull');
    expect(names).toContain('set_total_staked');
    expect(names).not.toContain('reward_token_push');
    const p = instructionPrompt(spec, d, stake, sourceLookup({ 'StakingRewards.sol': '' }));
    expect(p).toContain('public entry fun stake(caller: &signer, amount: u256)');
    expect(p).toContain('E_ZERO_AMOUNT');
    expect(hintsFor('error: cannot infer type of x').join(' ')).toMatch(/Type annotation/);
    expect(hintsFor('error: unbound variable `x`').join(' ')).toMatch(/Unbound name/);
  });
});

describe('aptos framework API (extracted from the vendored sources, not from memory)', () => {
  it('every framework function the generated code calls exists with that arity', () => {
    for (const c of FRAMEWORK_CALLS_USED) {
      const m = /^(.+)::(\w+)\/(\d+)$/.exec(c)!;
      const f = api[m[1]!]?.[m[2]!];
      expect(f, c).toBeDefined();
      expect(f!.arity, c).toBe(Number(m[3]));
    }
  });
  it('the test-module fixtures use real (test-only) functions too', () => {
    for (const c of ['aptos_framework::account::create_signer_for_test/1', 'aptos_framework::account::create_account_for_test/1', 'aptos_framework::timestamp::set_time_has_started_for_testing/1', 'aptos_framework::timestamp::update_global_time_for_test_secs/1', 'aptos_framework::aptos_coin::initialize_for_test/1', 'aptos_framework::primary_fungible_store::create_primary_store_enabled_fungible_asset/7', 'aptos_framework::fungible_asset::generate_mint_ref/1', 'aptos_framework::primary_fungible_store::mint/3', 'aptos_std::string_utils::format1/2', 'aptos_framework::object::create_named_object/2']) {
      const m = /^(.+)::(\w+)\/(\d+)$/.exec(c)!;
      const f = api[m[1]!]?.[m[2]!];
      expect(f, c).toBeDefined();
      expect(f!.arity, c).toBe(Number(m[3]));
    }
  });
  it('the ERC-20 template only calls framework functions that exist', () => {
    const text = genTokenModule({ moduleName: 'token', decimals: { aptos: 8 }, instructions: [{ kind: 'initialize', params: [{ name: 'name', move: 'String' }, { name: 'symbol', move: 'String' }, { name: 'initial_supply', move: 'u64' }] }], template: { features: { mintable: true, burnable: true, ownable: true }, ctor: [{ kind: 'string' }, { kind: 'string' }, { kind: 'supply' }] } } as never);
    for (const m of text.matchAll(/\b(primary_fungible_store|fungible_asset|object|option)::(\w+)\(/g)) {
      const mod = ({ primary_fungible_store: 'aptos_framework::primary_fungible_store', fungible_asset: 'aptos_framework::fungible_asset', object: 'aptos_framework::object', option: 'std::option' } as Record<string, string>)[m[1]!]!;
      expect(api[mod]?.[m[2]!], `${m[1]}::${m[2]}`).toBeDefined();
    }
  });
});

describe('aptos ERC-721 recipe', () => {
  it('only calls framework functions that exist in the vendored sources', () => {
    const text = genNftModule();
    const mods: Record<string, string> = { collection: 'aptos_token_objects::collection', token: 'aptos_token_objects::token', object: 'aptos_framework::object', string: 'std::string', option: 'std::option', signer: 'std::signer', string_utils: 'aptos_std::string_utils' };
    for (const m of text.matchAll(/\b(collection|token|object|string|option|signer|string_utils)::(\w+)(?:<[^>]*>)?\(/g)) expect(api[mods[m[1]!]!]?.[m[2]!], `${m[1]}::${m[2]}`).toBeDefined();
  });
});

describe('aptos template routing', () => {
  it('a plain ERC-20 becomes the Fungible Asset template; everything else goes to the model path', async () => {
    const pack = new AptosPack();
    const t = pack.templates((await load('ERC20Token')).spec, {})!;
    expect(t.needsProgram).toBe(true);
    expect(t.standard).toBe('ERC-20');
    expect(t.design.droppedFns!.map((x) => x.fn).sort()).toEqual(['allowance', 'approve', 'transferFrom']);
    expect(t.files['sources/token.move']).toContain('public entry fun burn(');
    for (const n of ['StakingRewards', 'LinearVesting', 'MultiSig2of3', 'ERC721Mint']) expect(pack.templates((await load(n)).spec, {}), n).toBeNull();
  });
});
