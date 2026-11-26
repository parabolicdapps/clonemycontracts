import { describe, expect, it } from 'vitest';
import { buildDesign } from '../src/targets/tezos/design.js';
import { fixElif, lintBody, lintReturns, lintScopes, mask, normaliseBody, splitTop, findClose, wrapSubtractions, unwrapNatAs } from '../src/targets/tezos/lint.js';
import type { HandlerD, TezosDesign } from '../src/targets/tezos/design-types.js';
import { load } from './helpers.js';

let ctx: { d: TezosDesign; ep: HandlerD; view: HandlerD; spec: Awaited<ReturnType<typeof load>>['spec'] };
async function get() {
  if (ctx) return ctx;
  const { spec } = await load('CosmwasmLocker');
  const d = buildDesign(spec);
  ctx = { d, spec, ep: d.instructions.find((h) => h.unit === 'ep_withdraw')!, view: d.instructions.find((h) => h.unit === 'view_unlocked')! };
  return ctx;
}
const rules = (xs: { rule: string }[]) => xs.map((x) => x.rule);

describe('tezos lint helpers', () => {
  it('mask hides strings and comments; splitTop splits at depth 0', () => {
    expect(mask('x = "a, b" # c')).toBe('x = "____"    ');
    expect(splitTop('a, (b, c), "d, e", f(g, h)')).toEqual(['a', '(b, c)', '"d, e"', 'f(g, h)']);
    expect(findClose('f(a, (b))', 1)).toBe(8);
  });
  it('elif chains become nested if/else', () => {
    const r = fixElif(['if a:', '    x = 1', 'elif b:', '    x = 2', 'elif c:', '    x = 3', 'else:', '    x = 4', 'y = 5']);
    expect(r.n).toBe(2);
    expect(r.lines).toEqual(['if a:', '    x = 1', 'else:', '    if b:', '        x = 2', '    else:', '        if c:', '            x = 3', '        else:', '            x = 4', 'y = 5']);
    expect(fixElif(['x = 1']).n).toBe(0);
  });
});

describe('as_nat misuse (contracts without signed integers)', () => {
  it('drops sp.as_nat around values that are already nats, keeps it around subtractions', () => {
    expect(unwrapNatAs('self.data.released = sp.as_nat(self.data.released + amount)').line).toBe('self.data.released = (self.data.released + amount)');
    expect(unwrapNatAs('amount = sp.as_nat(amount, error="x")').line).toBe('amount = amount');
    expect(unwrapNatAs('x = sp.as_nat(self.get_m(k), error="x")').line).toBe('x = self.get_m(k)');
    for (const l of ['x = sp.as_nat(a - b, error="u")', 'x = sp.as_nat(sp.to_int(a))', 'x = sp.as_nat(i)'.replace('(i)', '(abs(i))')]) expect(unwrapNatAs(l).line).toBe(l);
  });
});

describe('nat subtraction wrapping (contracts without signed integers)', () => {
  it('wraps each additive expression that contains a binary minus', () => {
    const w = (l: string) => wrapSubtractions(l).line;
    const E = (x: string) => `sp.as_nat(${x}, error="UNDERFLOW")`;
    expect(w('v = (self.data.total_allocation * (now - self.data.start)) / self.data.duration')).toBe(`v = (self.data.total_allocation * (${E('now - self.data.start')})) / self.data.duration`);
    expect(w('x = a - b')).toBe(`x = ${E('a - b')}`);
    expect(w('if a - b > 3:')).toBe(`if ${E('a - b')} > 3:`);
    expect(w('w = a + b - c * (d - e)')).toBe(`w = ${E(`a + b - c * (${E('d - e')})`)}`);
    expect(w('self.data.m[k] = self.get_m(k) - v')).toBe(`self.data.m[k] = ${E('self.get_m(k) - v')}`);
  });
  it('leaves alone: explicit int math, already wrapped, unary minus, strings, timestamps, mutez', () => {
    for (const l of ['y = sp.to_int(a) - sp.to_int(b)', 'z = sp.as_nat(a - b, error="X")', 'z = sp.as_nat(a - b)', 'q = -1', 'f(a, -b)', 'assert x, "a - b"', 't = sp.now - sp.timestamp(0)', 'u = abs(a - b)', 'x -= 1'.replace('x -= 1', 'x = y')]) expect(wrapSubtractions(l).line).toBe(l);
  });
  it('is part of normalisation, but not for contracts with signed integers', async () => {
    const { d, ep, spec } = await get();
    expect(normaliseBody('x = amount - self.data.total', { d, h: ep, spec }).body).toBe('x = sp.as_nat(amount - self.data.total, error="UNDERFLOW")');
    expect(normaliseBody('n -= 3', { d, h: ep, spec }).body).toBe('n = sp.as_nat(n - (3), error="UNDERFLOW")');
    expect(normaliseBody('x = amount - self.data.total', { d: { ...d, hasSigned: true }, h: ep, spec }).body).toBe('x = amount - self.data.total');
  });
});

describe('tezos normalisation (mechanical rewrites)', () => {
  it('rewrites the constructs that have one meaning', async () => {
    const { d, ep, spec } = await get();
    const src = [
      'require(amount > 0, "zero amount");',
      'x: sp.nat = 3',
      'y = amount // 2',
      'z = 10 ** 18',
      'w = amount ** 2',
      'if msg.sender == self.data.admin && true:',
      '    self.data.total -= amount',
      'elif amount == 0:',
      '    pass',
      'self.data.deposits[msg.sender] += amount',
      'v = self.data.deposits[msg.sender] + self.data.tips.get(msg.sender, default=0)',
      'emit Withdrawn(msg.sender, amount);',
      'sp.failwith("X")',
      'c = sp.contract(sp.nat, a, entry_point="t")',
    ].join('\n');
    const n = normaliseBody(src, { d, h: ep, spec });
    expect(n.body).toContain('assert amount > 0, "zero amount"');
    expect(n.body).toContain('x = 3');
    expect(n.body).toContain('y = amount / 2');
    expect(n.body).toContain(`z = ${10n ** 18n}`);
    expect(n.body).toContain('w = pow_nat((amount, 2))');
    expect(n.body).toContain('if sp.sender == self.data.admin and True:');
    expect(n.body).toContain('self.data.total = sp.as_nat(self.data.total - (amount), error="UNDERFLOW")');
    expect(n.body).not.toContain('elif');
    expect(n.body).toContain('self.data.deposits[sp.sender] = self.get_deposits(sp.sender) + (amount)');
    expect(n.body).toContain('v = self.get_deposits(sp.sender) + self.get_tips(sp.sender)');
    expect(n.body).toContain('sp.emit(sp.record(user=sp.sender, amount=amount), tag="Withdrawn")');
    expect(n.body).toContain('raise "X"');
    expect(normaliseBody('del self.get_deposits(sp.sender)', { d, h: ep, spec }).body).toBe('del self.data.deposits[sp.sender]');
    expect(n.body).toContain('entrypoint="t"');
    expect(n.fixes.length).toBeGreaterThan(8);
    expect(lintBody(n.body, ep, d).filter((i) => i.rule !== 'branch-scope').map((i) => i.rule)).toEqual([]);
  });
  it('does not touch strings or valid code', async () => {
    const { d, ep, spec } = await get();
    const ok = 'assert amount > 0, "x // y ** z && w"\nself.data.total = sp.as_nat(self.data.total - amount, error="U")';
    expect(normaliseBody(ok, { d, h: ep, spec }).body).toBe(ok);
    expect(normaliseBody(ok, { d, h: ep, spec }).fixes).toEqual([]);
  });
});

describe('tezos lint (what cannot be rewritten)', () => {
  it('reports every problem with a specific rule', async () => {
    const { d, ep } = await get();
    const bad = [
      'print(amount)',
      'x = f"{amount}"',
      'y = uint256(amount)',
      'self.data.nothing = 1',
      'self.deposit(amount)',
      'z = self.get_deposits(sp.sender, amount)',
      'a = sp.nat(amount)',
      'b = [i for i in xs]',
      'return amount',
      'self.data.initialized = True',
      'k = tx.origin',
    ].join('\n');
    const r = rules(lintBody(bad, ep, d));
    expect(r).toEqual(expect.arrayContaining(['print', 'fstring', 'solidity-cast', 'unknown-storage', 'unknown-method', 'helper-arity', 'nat-int-cast', 'comprehension', 'return-value', 'reserved-storage', 'solidity-global']));
  });
  it('clean code passes (a local named tx is not the Solidity global)', async () => {
    const { d, ep, view } = await get();
    expect(lintBody('tx = self.get_deposits(sp.sender)\nself.data.total = tx + tx', ep, d)).toEqual([]);
    expect(lintBody('assert amount > 0, "zero"\nself.data.total = sp.as_nat(self.data.total - amount, error="U")\nself.erc20_transfer(sp.record(token=self.data.token, to=sp.sender, amount=amount))', ep, d)).toEqual([]);
    expect(lintBody('return self.now_secs() >= self.data.unlock_at', view, d)).toEqual([]);
  });
  it('views: early return is rejected, return in both branches is fine; entrypoints may not return', async () => {
    const { d, view, ep } = await get();
    expect(rules(lintReturns('if a:\n    return 0\nreturn 1', view))).toEqual(['early-return']);
    expect(lintReturns('if a:\n    return 0\nelse:\n    return 1', view)).toEqual([]);
    expect(lintReturns('t = 0\nif a:\n    t = 1\nreturn t', view)).toEqual([]);
    expect(rules(lintReturns('t = 1', view))).toEqual(['view-return']);
    expect(rules(lintReturns('if a:\n    return 0', view))).toEqual(expect.arrayContaining(['view-return']));
    expect(rules(lintReturns('if a:\n    return\nx = 1', ep))).toEqual(['bare-return']);
    void d;
  });
  it('a variable first assigned inside a block is not visible after it', async () => {
    const { d, ep } = await get();
    expect(rules(lintScopes('if amount > 1:\n    t = 1\nelse:\n    t = 2\nself.data.total = t', ep, d))).toEqual(['branch-scope']);
    expect(lintScopes('t = 0\nif amount > 1:\n    t = 1\nelse:\n    t = 2\nself.data.total = t', ep, d)).toEqual([]);
    expect(lintScopes('for i in sp.range(0, 3):\n    s = i\n    self.data.total = s', ep, d)).toEqual([]);
    expect(rules(lintScopes('for i in sp.range(0, 3):\n    s = i\nself.data.total = s', ep, d))).toEqual(['branch-scope']);
    expect(lintScopes('x = amount\nif x > 1:\n    y = x\n    self.data.total = y', ep, d)).toEqual([]);
  });
});

describe('tezos pack: lint short-circuits the compiler round and feeds the repair prompt', () => {
  it('assemble normalises, lints, and compile() rejects without a container', async () => {
    const { TezosPack } = await import('../src/targets/tezos/pack.js');
    const { spec } = await load('CosmwasmLocker');
    const pack = new TezosPack({ host: 'nowhere.invalid', workRoot: '/nonexistent', image: 'none', cpus: 1, memory: '1g', concurrency: 1, timeoutMs: 1000 });
    const d = pack.design(spec, {});
    const bodies = {
      initialize: 'self.data.token = token\nself.data.admin = msg.sender\nself.data.unlock_at = unlock_at',
      ep_withdraw: 'if amount == 0:\n    t = 1\nelif amount == 1:\n    t = 2\nself.data.total = t\nreturn amount',
      view_unlocked: 'if self.now_secs() > 3:\n    return True\nreturn False',
    };
    const files = pack.assemble(spec, d, bodies);
    expect(files['contract_def.py']).toContain('self.data.admin = sp.sender');
    expect(files['contract_def.py']).not.toContain('elif');
    expect(files['NORMALISATIONS.md']).toMatch(/ep_withdraw[\s\S]*elif/);
    const lint = files['cmc/lint.txt']!;
    expect(lint).toMatch(/=== UNIT ep_withdraw ===[\s\S]*lint\[return-value\]/);
    expect(lint).toMatch(/=== UNIT view_unlocked ===[\s\S]*lint\[early-return\]/);
    expect(lint).not.toMatch(/=== UNIT initialize ===/);
    const r = await pack.compile(files);
    expect(r.ok).toBe(false);
    expect(r.seconds).toBeLessThan(1);
    const b = pack.blame(r.log, d);
    expect([...b.units].sort()).toEqual(['ep_withdraw', 'view_unlocked']);
    const rp = pack.repairPrompt(d, 'view_unlocked', bodies.view_unlocked, r.log);
    expect(rp.user).toMatch(/lint\[early-return\]/);
    expect(rp.user).toMatch(/Hints:|Problems/);
    // fixing the bodies removes the lint file
    const ok = pack.assemble(spec, d, { ...bodies, ep_withdraw: 'self.data.total = sp.as_nat(self.data.total - amount)', view_unlocked: 'return self.now_secs() > 3' });
    expect(ok['cmc/lint.txt']).toBeUndefined();
  });
});

describe('round 4: empty bytes literals', () => {
  it('sp.bytes("") (an empty SExpr atom in SmartPy) becomes sp.bytes("0x")', async () => {
    const c = await get();
    const r = normaliseBody('    x = sp.bytes("")\n    y = sp.bytes( \'\' )\n    return sp.bytes("0x")', { d: c.d, h: c.ep, spec: c.spec } as any);
    expect(r.body).toContain('x = sp.bytes("0x")');
    expect(r.body).not.toMatch(/sp\.bytes\(\s*(""|'')\s*\)/);
    expect(r.fixes.join(' ')).toMatch(/empty SExpr atom/);
  });
  it('a user-defined value type (ShortString) is its underlying type, not an unsupported state variable', async () => {
    const { compileWithAst, stdInputForSource } = await import('../src/spec/compile.js');
    const { extractSpec } = await import('../src/spec/extract.js');
    const c = await compileWithAst({ compilerVersion: '0.8.28+commit.7893614a', stdJsonInput: stdInputForSource('X.sol', 'pragma solidity ^0.8.20; type ShortString is bytes32; contract X { ShortString private immutable _version; constructor() { _version = ShortString.wrap(bytes32(uint256(1))); } function v() external view returns (bytes32) { return ShortString.unwrap(_version); } }'), contract: 'X' });
    const spec = extractSpec(c, {});
    expect(spec.stateVars.find((v) => v.name === '_version')!.type.kind).toBe('fixedbytes');
    const d = buildDesign(spec);
    expect(d.state.find((v) => v.solidity === '_version')!.unsupported).toBeUndefined();
  });
  it('types written as calls (sp.TPair(..), sp.cast(x, sp.pair(..))) become subscripts', async () => {
    const c = await get();
    const r = normaliseBody('    k = sp.cast((a, (b, c)), sp.pair(sp.address, sp.pair(sp.address, sp.nat)))\n    t = sp.TPair(sp.address, sp.TPair(sp.address, sp.nat))', { d: c.d, h: c.ep, spec: c.spec } as any);
    expect(r.body).toContain('sp.pair[sp.address, sp.pair[sp.address, sp.nat]]');
    expect(r.body).not.toMatch(/sp\.TPair|sp\.pair\(/);
  });
});
