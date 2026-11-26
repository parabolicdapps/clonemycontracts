import { describe, expect, it } from 'vitest';
import { buildDesign } from '../src/targets/tezos/design.js';
import { genContractDef, genProject, parseUnits, stubUnits, indentBody, handlerSignature } from '../src/targets/tezos/codegen.js';
import { typeMap, snake, entryName } from '../src/targets/tezos/names.js';
import { classifyStandard } from '../src/spec/standard.js';
import { buildTemplateDesign, erc20Info, genFa12Module, recipeFiles, recipeFits } from '../src/targets/tezos/template.js';
import { TezosPack } from '../src/targets/tezos/pack.js';
import { handlerPrompt, sourceLookup, SYSTEM, hintsFor, parseUnitSections } from '../src/targets/tezos/prompts.js';
import { load } from './helpers.js';

describe('tezos names and types', () => {
  it('integers are nat/int, no narrowing; address zero is the burn address constant', () => {
    expect(typeMap({ solidity: 'uint8', kind: 'uint', bits: 8 })).toMatchObject({ sp: 'sp.nat', zero: 'sp.nat(0)' });
    expect(typeMap({ solidity: 'uint256', kind: 'uint', bits: 256 }).sp).toBe('sp.nat');
    expect(typeMap({ solidity: 'int128', kind: 'int', bits: 128 }).sp).toBe('sp.int');
    expect(typeMap({ solidity: 'address', kind: 'address' })).toMatchObject({ sp: 'sp.address', zero: 'ZERO_ADDRESS' });
    expect(typeMap({ solidity: 'address[3]', kind: 'array', length: 3, element: { solidity: 'address', kind: 'address' } })).toMatchObject({ sp: 'sp.list[sp.address]', fixed: 3 });
  });
  it('python keywords and generated names are escaped', () => {
    expect(snake('from')).toBe('from_');
    expect(snake('_owner')).toBe('owner');
    expect(snake('totalSupply')).toBe('total_supply');
    const taken = new Set<string>();
    expect(entryName('get_x', taken)).toBe('get_x_');
    expect(entryName('transfer', taken)).toBe('transfer');
    expect(entryName('transfer', taken)).toBe('transfer_');
    expect(entryName('a'.repeat(40), new Set()).length).toBe(31);
  });
});

describe('tezos design (MultiSig2of3)', () => {
  it('initialize, entrypoints, views, arrays and keyed state', async () => {
    const { spec } = await load('MultiSig2of3');
    const d = buildDesign(spec);
    expect(d.instructions.map((h) => h.unit)).toEqual(expect.arrayContaining(['initialize', 'ep_deposit', 'ep_submit', 'ep_confirm', 'ep_revoke', 'ep_execute', 'view_txCount', 'view_getTx']));
    expect(d.hasInitialize).toBe(true);
    expect(d.native.used).toBe(true);
    const init = d.instructions.find((h) => h.unit === 'initialize')!;
    expect(init.args).toHaveLength(1);
    expect(init.args[0]!.t).toMatchObject({ kind: 'array', fixed: 3, sp: 'sp.list[sp.address]' });
    const gt = d.instructions.find((h) => h.unit === 'view_getTx')!;
    expect(gt.returns!.single).toBe(false);
    expect(gt.returns!.fields.map((f) => f.name)).toEqual(['to', 'value', 'data', 'executed', 'confirmations']);
    expect(d.state.find((s) => s.solidity === 'txs')).toMatchObject({ kind: 'array', struct: 'Tx' });
    expect(d.instructions.find((h) => h.unit === 'view_isOwner')?.generated).toBeTruthy();
    expect(d.notes.join(' ')).toMatch(/calldata is dropped/);
    expect(d.notes.join(' ')).toMatch(/AFTER it returns/);
    expect(d.notes.join(' ')).toMatch(/1 mutez is treated as the base unit exactly like 1 wei/);
  });
  it('generated scaffolding: checks, helpers, struct alias, unit markers and stubs', async () => {
    const { spec } = await load('MultiSig2of3');
    const d = buildDesign(spec);
    const py = genContractDef(spec, d, {});
    expect(py).toContain('Tx: type = sp.record(');
    expect(py).toContain('Tx_ZERO = sp.record(');
    expect(py).toContain('self.data.initialized = False');
    expect(py).toMatch(/def initialize\(self, owners: sp\.list\[sp\.address\]\):[\s\S]*?assert not self\.data\.initialized, "ALREADY_INITIALIZED"[\s\S]*?assert sp\.len\(owners\) == 3, "BAD_ARRAY_LENGTH"/);
    expect(py).toMatch(/def confirm\(self, tx_id: sp\.nat\):\n\s+assert self\.data\.initialized, "NOT_INITIALIZED"\n\s+assert sp\.amount == sp\.mutez\(0\), "NOT_PAYABLE"/);
    expect(py).toMatch(/def deposit\(self\):\n\s+assert self\.data\.initialized, "NOT_INITIALIZED"\n\s+# cmc:stub/);
    expect(py).toContain('def push_txs(self, value):');
    // a FIXED array (address[3] owners) has no length counter and no push/pop: its bound is the declared length
    expect(py).toMatch(/def get_owners\(self, index\):\n\s+assert index < 3, "INDEX_OUT_OF_BOUNDS"\n\s+return self\.data\.owners\.get\(index, default=ZERO_ADDRESS\)/);
    expect(py).not.toContain('owners_len');
    expect(py).not.toContain('push_owners');
    expect(py).toContain('def get_confirmed(self, key):');
    const units = parseUnits(py);
    expect(units.map((u) => u.unit)).toContain('ep_submit');
    expect(units.find((u) => u.unit === 'view_getTx')!.stub).toMatch(/^return sp\.record\(to=ZERO_ADDRESS/);
    // isolating one unit leaves only its body
    const withBodies = genContractDef(spec, d, { ep_submit: 'self.data.is_owner[sp.sender] = True', ep_confirm: 'x = 1' });
    const iso = stubUnits(withBodies, 'ep_submit');
    expect(iso).toContain('self.data.is_owner[sp.sender] = True');
    expect(iso).not.toContain('x = 1');
  });
  it('indentBody keeps relative indentation and handles empty bodies', () => {
    expect(indentBody('if x:\n    y = 1\nz = 2', 12)).toEqual(['            if x:', '                y = 1', '            z = 2']);
    expect(indentBody('    if x:\n        y = 1', 4)).toEqual(['    if x:', '        y = 1']);
    expect(indentBody('', 12)).toEqual(['            pass']);
  });
  it('public state getters are generated views; the prompt lists helpers, storage, events', async () => {
    const { spec, c } = await load('MultiSig2of3');
    const d = buildDesign(spec);
    const p = handlerPrompt(spec, d, d.instructions.find((h) => h.unit === 'ep_confirm')!, sourceLookup(c.sources));
    expect(p).toMatch(/Function to implement: `ep_confirm`/);
    expect(p).toMatch(/def confirm\(self, tx_id: sp\.nat\):/);
    expect(p).toMatch(/self\.get_confirmed\(\(k1, k2\)\)|self\.get_confirmed\(key\)/);
    expect(p).toMatch(/self\.send_native\(sp\.record\(to=<address>, amount=<nat>\)\)/);
    expect(p).toMatch(/sp\.emit\(sp\.record\(/);
    expect(SYSTEM).toMatch(/SMARTPY 0\.25\.3 PRIMER/);
    expect(SYSTEM).toMatch(/NO `elif`/);
  });
});

describe('tezos hints and unit sections', () => {
  it('maps real SmartPy messages to hints', () => {
    expect(hintsFor('Right-hand side of assignment: mismatch between sp.int and sp.nat').join(' ')).toMatch(/sp\.as_nat/);
    expect(hintsFor("m1.py:14: SyntaxError: unknown operator '**'").join(' ')).toMatch(/pow_nat/);
    expect(hintsFor('elseif is not allowed in SmartPy').join(' ')).toMatch(/nested/);
    expect(hintsFor('Entrypoint go has a non-unit return type.: Expected type sp.unit, but got sp.nat.').join(' ')).toMatch(/cannot `return`/);
  });
  it('parses per-unit sections of a compile log', () => {
    const log = '=== FULL ===\nboom\n\n=== UNIT ep_a ===\nline1\nline2\n\n=== UNIT view_b ===\nlint here\n';
    const m = parseUnitSections(log);
    expect(m.get('ep_a')).toBe('line1\nline2');
    expect(m.get('view_b')).toBe('lint here');
    const p = new TezosPack();
    expect(p.blame(log, {} as never)).toEqual({ units: new Set(['ep_a', 'view_b']), other: false });
    expect(p.blame('=== FULL ===\nx\n=== OTHER ===\nscaffold', {} as never).other).toBe(true);
  });
});

describe('tezos template (ERC-20 -> FA1.2)', () => {
  it('the plain ERC-20 fixture is a template; the recipe has FA1.2 entrypoints and ERC-20 semantics', async () => {
    const { spec } = await load('ERC20Token');
    const v = classifyStandard(spec);
    expect(v.match?.standard).toBe('ERC-20');
    expect(recipeFits(spec)).toBeNull();
    const info = erc20Info(spec, v.match!);
    expect(info).toMatchObject({ mintable: true, burnable: true, ownable: true, zeroGuards: true, decimals: 18 });
    const py = genFa12Module(info);
    expect(py).toContain('def transfer(self, param: sp.record(from_=sp.address, to_=sp.address, value=sp.nat).layout(("from_ as from", ("to_ as to", "value")))):');
    expect(py).toContain('def approve(self, param: sp.record(spender=sp.address, value=sp.nat).layout(("spender", "value"))):');
    expect(py).toContain('if allowed != MAX_UINT256:');
    expect(py).toContain('assert param.to_ != ZERO_ADDRESS, "zero address"');
    expect(py).toContain('def mint(self, to_: sp.address, value: sp.nat):');
    expect(py).toContain('def getBalance(self, param: sp.pair[sp.address, sp.contract[sp.nat]]):');
    expect(py).not.toMatch(/is_administrator/);
    // the mock token (no guards, mintable) is a different module name so both can be loaded
    const mock = genFa12Module({ ...info, zeroGuards: false, ownable: false, burnable: false }, { mock: true, moduleName: 'mock_token' });
    expect(mock).toContain('def mock_token():');
    expect(mock).not.toContain('zero address');
    const d = buildTemplateDesign(spec, info);
    expect(d.mode).toBe('template');
    expect(d.notes.join(' ')).toMatch(/FA1.2 rather than FA2/);
    expect(Object.keys(recipeFiles(spec, info, d))).toEqual(expect.arrayContaining(['contract_def.py', 'contract.py', 'deploy-ghostnet.sh', 'token.json']));
  });
  it('contracts that are not plain tokens use the model path; ERC-721 has no template', async () => {
    const p = new TezosPack();
    const { spec } = await load('StakingRewards');
    expect(p.templates(spec, {})).toBeNull();
    const nft = await load('ERC721Mint');
    expect(p.templates(nft.spec, {})).toBeNull();
    const erc = await load('ERC20Token');
    expect(p.templates(erc.spec, {})).not.toBeNull();
  });
  it('whole project assembly of every fixture has a unit block per model-written function', async () => {
    for (const n of ['LinearVesting', 'StakingRewards', 'MultiSig2of3', 'ERC721Mint', 'CosmwasmLocker']) {
      const { spec } = await load(n);
      const d = buildDesign(spec);
      const files = genProject(spec, d, {});
      const blocks = parseUnits(files['contract_def.py']!);
      expect(blocks.map((b) => b.unit).sort()).toEqual(d.instructions.filter((h) => !h.generated).map((h) => h.unit).sort());
      expect(handlerSignature(d.instructions[0]!)).toMatch(/^def \w+\(self/);
    }
  });
});
