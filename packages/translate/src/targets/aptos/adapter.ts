import { ell } from '../../pipeline/report.js';
import { own } from '../../own.js';
import type { Scenario, ScenarioSet, Step, Val } from '../../types.js';
import type { AptosDesign, InstructionDesign, ParamDesign, Scale } from './design-types.js';
import { ident } from './names.js';

/** Neutral scenarios -> a `#[test_only]` Move module, one `#[test]` per scenario (plus one per expected revert, because Move cannot catch an abort). */

export const ACTOR_ADDR: Record<string, string> = { deployer: '@app', alice: '@0xa11ce', bob: '@0xb0b', carol: '@0xca401', mallory: '@0xbad' };
export const STATE_ADDR_EXPR = 'account::create_resource_address(&@app, b"cmc_state")';
export const NATIVE_FUNDING = '1000000000000';

class NotRunnable extends Error {}

export type MarkKind = 'deploy' | 'call' | 'view';
export interface Mark { test: string; kind: MarkKind; step?: number }

export interface ViewRead {
  step: number;
  fn: string;
  label: string;
  /** number of values printed (tuple size) */
  count: number;
  scales: (Scale | 'token-balance')[];
  documented?: string;
}

export interface TestMeta {
  name: string;
  scenarioId: string;
  kind: 'main' | 'revert-step' | 'revert-deploy';
  /** scenario step index for revert-step (call or view that is expected to abort) */
  step?: number;
  views: ViewRead[];
  /** steps (indices) executed by this test and expected to succeed */
  calls: number[];
  /** documented-difference notes by step index (set after a Solidity function without an Aptos equivalent succeeded in the original) */
  documented: Map<number, string>;
}

export interface TestPlan {
  source: string;
  tests: TestMeta[];
  /** mark of each generated line (1-based) */
  marks: Map<number, Mark>;
  notRunnable: Map<string, string>;
  /** address of each actor, for normalising printed addresses */
  addrOf: Map<string, string>;
}

export interface PlanContext { design: AptosDesign; set: ScenarioSet }

const pow10 = (n: number) => 10n ** BigInt(n);
const hex = (v: bigint) => v.toString();
const maxOf = (move: string): bigint | null => { const m = /^u(\d+)$/.exec(move); return m ? (1n << BigInt(m[1]!)) - 1n : null; };

interface LitCtx { design: AptosDesign; set: ScenarioSet; tokens: Set<string> }

function lit(v: Val, move: string, scale: Scale | 'time', c: LitCtx): string {
  if (move === 'address') {
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
      if ('actor' in v) { const a = ACTOR_ADDR[v.actor]; if (!a) throw new NotRunnable(`unknown actor ${v.actor}`); return a; }
      if ('zero' in v) return '@0x0';
      if ('token' in v) { if (!c.tokens.has(v.token)) throw new NotRunnable(`unknown token fixture ${v.token}`); return `tok_${ident(v.token)}`; }
    }
    throw new NotRunnable(`cannot express ${JSON.stringify(v)} as an address`);
  }
  if (move === 'bool') return v === true || v === 'true' ? 'true' : 'false';
  if (move === 'String') return `string::utf8(b"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[^\x20-\x7e]/g, '?')}")`;
  if (move === 'vector<u8>') return typeof v === 'object' && v !== null && !Array.isArray(v) && 'hex' in v ? `x"${v.hex.replace(/^0x/, '')}"` : typeof v === 'string' ? `b"${v.replace(/"/g, '')}"` : 'x""';
  const vm = /^vector<(.+)>$/.exec(move);
  if (vm) { if (!Array.isArray(v)) throw new NotRunnable(`expected an array for ${move}`); return `vector[${v.map((x) => lit(x, vm[1]!, 'plain', c)).join(', ')}]`; }
  const max = maxOf(move);
  if (max === null) throw new NotRunnable(`unsupported argument type ${move}`);
  let n: bigint;
  if (typeof v === 'object' && v !== null && !Array.isArray(v) && 'time' in v) n = BigInt(c.set.t0 + v.time);
  else if (typeof v === 'string' || typeof v === 'number') n = BigInt(v); else throw new NotRunnable(`cannot express ${JSON.stringify(v)} as ${move}`);
  if (scale === 'token' && n !== 0n) {
    const div = BigInt(c.design.decimals.divisor);
    if (n % div !== 0n) throw new NotRunnable(`amount ${n} is not a multiple of the unit conversion 10^${c.design.decimals.original - c.design.decimals.aptos}`);
    n /= div;
    if (n > ((1n << 64n) - 1n)) throw new NotRunnable(`amount ${n} does not fit a u64 fungible-asset amount at ${c.design.decimals.aptos} decimals`);
  }
  if (n > max) throw new NotRunnable(`value ${n} does not fit ${move}`);
  return hex(n);
}

const findCall = (design: AptosDesign, fn: string): InstructionDesign | undefined => (fn === 'receive' ? design.instructions.find((i) => i.kind === 'receive') : design.instructions.find((i) => i.solidity === fn && i.kind === 'entry'));

function callArgs(ins: InstructionDesign, vals: Val[], valueWei: string | undefined, c: LitCtx): string[] {
  return ins.params.map((p: ParamDesign) => {
    if (p.src < 0) {
      const wei = BigInt(valueWei ?? '0'); const div = BigInt(c.design.decimals.divisor);
      if (wei % div !== 0n) throw new NotRunnable(`msg.value ${wei} is not a multiple of the unit conversion`);
      const v = wei / div;
      if (v > ((1n << 64n) - 1n)) throw new NotRunnable('msg.value does not fit u64 octas');
      return v.toString();
    }
    const v = vals[p.src];
    if (v === undefined) throw new NotRunnable(`argument ${p.name} missing`);
    return lit(v, p.move, p.scale, c);
  });
}

interface Emit { text: string; mark?: Mark }

export function buildTestPlan(ctx: PlanContext): TestPlan {
  const { design, set } = ctx;
  const mod = design.moduleName;
  const tokenNames = new Set(set.tokens.map((t) => t.name));
  const c: LitCtx = { design, set, tokens: tokenNames };
  const notRunnable = new Map<string, string>();
  const tests: TestMeta[] = [];
  const bodies: { name: string; lines: Emit[] }[] = [];
  const actorList = set.actors.filter((a) => ACTOR_ADDR[a]);
  const addrOf = new Map(actorList.map((a) => [a, ACTOR_ADDR[a]!]));
  const dropped = new Map((design.droppedFns ?? []).map((d) => [d.fn, d.reason]));

  const fixtures = (name: string, sc: Scenario): string[] => {
    const L: string[] = [];
    L.push(`fx_begin(${set.t0 + sc.deploy.at});`);
    L.push(`fx_accounts(vector[${actorList.map((a) => ACTOR_ADDR[a]).join(', ')}]);`);
    if (design.usesNative) L.push(`fx_native(vector[${actorList.map((a) => ACTOR_ADDR[a]).join(', ')}], ${NATIVE_FUNDING});`);
    for (const t of set.tokens) {
      const div = BigInt(design.decimals.divisor);
      const fs = t.fundings.filter((f) => ACTOR_ADDR[f.actor]);
      const amts = fs.map((f) => { const n = BigInt(f.amount); if (n % div !== 0n) throw new NotRunnable(`funding ${n} of ${t.name} is not a multiple of the unit conversion`); const q = n / div; if (q > (1n << 64n) - 1n) throw new NotRunnable(`funding of ${t.name} does not fit u64`); return q.toString(); });
      L.push(`let tok_${ident(t.name)} = fx_token(b"${ident(t.name)}", vector[${fs.map((f) => ACTOR_ADDR[f.actor]).join(', ')}], vector[${amts.join(', ')}]);`);
      L.push(`debug::print(&string_utils::format1(&b"CMC|${name}|tok:${t.name}|0|{}", tok_${ident(t.name)}));`);
    }
    L.push(`debug::print(&string_utils::format1(&b"CMC|${name}|contract|0|{}", ${STATE_ADDR_EXPR}));`);
    for (const a of actorList) L.push(`let ${ident(a)} = s(${ACTOR_ADDR[a]});`);
    return L;
  };

  const deployLine = (sc: Scenario): string => {
    const init = design.instructions.find((i) => i.kind === 'initialize');
    if (!init) throw new NotRunnable('the design has no initialize function');
    const args = callArgs(init, sc.deploy.args, sc.deploy.valueWei, c);
    if (sc.deploy.actor !== 'deployer') throw new NotRunnable(`deployment by ${sc.deploy.actor}: only the publisher account (deployer) can initialize`);
    return `${mod}::initialize(&deployer, ${[...args].join(', ')});`;
  };

  const stepLines = (name: string, sc: Scenario, i: number, st: Step, meta: TestMeta, opts: { asRevert: boolean }): Emit[] => {
    const out: Emit[] = [];
    out.push({ text: `at(${set.t0 + st.at});` });
    if (st.type === 'call' && st.fn === 'tokenTransfer') {
      // fixture step: the actor moves mock-token units to the contract's store (or another actor)
      const [tk, dest, amount] = st.args as [{ token: string }, Val, string];
      if (!tokenNames.has(tk.token)) throw new NotRunnable(`unknown token fixture ${tk.token}`);
      const q = BigInt(amount); const dv = BigInt(design.decimals.divisor);
      if (q % dv !== 0n) throw new NotRunnable(`funding ${q} is not a multiple of the unit conversion`);
      const to = dest === 'contract' ? STATE_ADDR_EXPR : lit(dest, 'address', 'plain', c);
      out.push({ text: `primary_fungible_store::transfer(&${ident(st.actor)}, object::address_to_object<Metadata>(tok_${ident(tk.token)}), ${to}, ${(q / dv).toString()});`, mark: { test: name, kind: 'call', step: i } });
      if (!opts.asRevert) meta.calls.push(i);
      return out;
    }
    if (st.type === 'call') {
      const ins = findCall(design, st.fn);
      if (!ins) throw new NotRunnable(`${st.fn} has no function in the design`);
      const args = callArgs(ins, st.args, st.valueWei, c);
      out.push({ text: `${mod}::${ins.name}(&${ident(st.actor)}, ${args.join(', ')});`, mark: { test: name, kind: 'call', step: i } });
      if (!opts.asRevert) meta.calls.push(i);
      return out;
    }
    // view
    const obs = own(design.observables, st.fn);
    if (!obs) throw new NotRunnable(`${st.fn} is not mapped to anything in the design`);
    if (obs.kind === 'token-balance') {
      const [tk, holder] = st.args as [{ token: string }, Val];
      if (!tokenNames.has(tk.token)) throw new NotRunnable(`unknown token fixture ${tk.token}`);
      const who = holder === 'contract' ? STATE_ADDR_EXPR : lit(holder, 'address', 'plain', c);
      out.push({ text: `let r = primary_fungible_store::balance(${who}, object::address_to_object<Metadata>(tok_${ident(tk.token)}));`, mark: { test: name, kind: 'view', step: i } });
      out.push({ text: `debug::print(&string_utils::format1(&b"CMC|${name}|${i}|0|{}", r));` });
      meta.views.push({ step: i, fn: st.fn, label: (st as { label: string }).label, count: 1, scales: ['token-balance'] });
      return out;
    }
    if (obs.kind !== 'view') throw new NotRunnable(`${st.fn}: ${obs.kind === 'unobservable' ? obs.reason : 'not observable'}`);
    if (st.args.length !== obs.params.length) throw new NotRunnable(`${st.fn} expects ${obs.params.length} argument(s)`);
    const args = st.args.map((a, k) => lit(a, obs.params[k]!, 'plain', c));
    const n = obs.scales.length;
    const lhs = n === 1 ? 'r' : `(${Array.from({ length: n }, (_, k) => `r${k}`).join(', ')})`;
    out.push({ text: `let ${lhs} = ${mod}::${obs.fn}(${args.join(', ')});`, mark: { test: name, kind: 'view', step: i } });
    for (let k = 0; k < n; k++) out.push({ text: `debug::print(&string_utils::format1(&b"CMC|${name}|${i}|${k}|{}", ${n === 1 ? 'r' : `r${k}`}));` });
    if (!opts.asRevert) meta.views.push({ step: i, fn: st.fn, label: (st as { label: string }).label, count: n, scales: obs.scales });
    return out;
  };

  const testName = (id: string, suffix = '') => `s_${id.replace(/[^A-Za-z0-9]/g, '_').toLowerCase()}${suffix}`;

  for (const sc of set.scenarios) {
    try {
      const pre = (name: string) => fixtures(name, sc).map((text) => ({ text }) as Emit);
      const dep = deployLine(sc);
      if (sc.deploy.expect?.status === 'revert') {
        const name = testName(sc.id, '_d');
        const meta: TestMeta = { name, scenarioId: sc.id, kind: 'revert-deploy', views: [], calls: [], documented: new Map() };
        bodies.push({ name, lines: [...pre(name), { text: dep, mark: { test: name, kind: 'deploy' } }] });
        tests.push(meta);
        continue;
      }
      // main test: everything that is expected to succeed, in order
      const name = testName(sc.id);
      const meta: TestMeta = { name, scenarioId: sc.id, kind: 'main', views: [], calls: [], documented: new Map() };
      const lines: Emit[] = [...pre(name), { text: `at(${set.t0 + sc.deploy.at});` }, { text: dep, mark: { test: name, kind: 'deploy' } }];
      const reverting: number[] = [];
      let droppedOk: string | null = null;
      const emitted: { i: number; lines: Emit[] }[] = [];
      for (const [i, st] of sc.steps.entries()) {
        const exp = st.type === 'call' ? st.expect : (st.expect as { __revert?: boolean } | undefined)?.__revert ? { status: 'revert' as const } : { status: 'success' as const };
        if (st.type === 'call' && dropped.has(st.fn)) { if (exp?.status === 'success') droppedOk = `${st.fn}: ${dropped.get(st.fn)}`; continue; }
        if (st.type === 'view' && dropped.has(st.fn)) { meta.documented.set(i, `${st.fn}: ${dropped.get(st.fn)}`); continue; }
        if (droppedOk) meta.documented.set(i, droppedOk);
        if (st.type === 'view' && st.fn === 'decimals' && design.decimals.original !== design.decimals.aptos) continue; // stated once in the report header, not compared
        if (exp?.status === 'revert') { reverting.push(i); continue; }
        emitted.push({ i, lines: stepLines(name, sc, i, st, meta, { asRevert: false }) });
      }
      for (const e of emitted) lines.push(...e.lines);
      bodies.push({ name, lines }); tests.push(meta);
      // one test per expected revert: the steps before it that succeed, then the step itself
      for (const j of reverting) {
        const rn = testName(sc.id, `_r${j}`);
        const rm: TestMeta = { name: rn, scenarioId: sc.id, kind: 'revert-step', step: j, views: [], calls: [], documented: new Map(meta.documented) };
        const rl: Emit[] = [...pre(rn), { text: `at(${set.t0 + sc.deploy.at});` }, { text: dep, mark: { test: rn, kind: 'deploy' } }];
        for (const e of emitted) { if (e.i >= j) break; const st = sc.steps[e.i]!; if (st.type === 'call') rl.push(...stepLines(rn, sc, e.i, st, rm, { asRevert: false })); }
        rm.calls = [];
        rl.push(...stepLines(rn, sc, j, sc.steps[j]!, rm, { asRevert: true }));
        bodies.push({ name: rn, lines: rl }); tests.push(rm);
      }
    } catch (e) {
      if (!(e instanceof NotRunnable)) throw e;
      notRunnable.set(sc.id, e.message);
    }
  }
  // assemble
  const head = testHeader(design);
  const out: string[] = head.split('\n');
  const marks = new Map<number, Mark>();
  for (const b of bodies) {
    out.push('', '    #[test]', `    fun ${b.name}() {`);
    for (const l of b.lines) { out.push(`        ${l.text}`); if (l.mark) marks.set(out.length, l.mark); }
    out.push('    }');
  }
  out.push('}', '');
  return { source: out.join('\n'), tests, marks, notRunnable, addrOf };
}

export function testHeader(design: AptosDesign): string {
  const native = design.usesNative;
  return `#[test_only]
module app::cmc_tests {
    use std::option;
    use std::string::{Self, String};
    use std::vector;
    use std::debug;
    use aptos_std::string_utils;
    use aptos_framework::account;
    use aptos_framework::timestamp;
    use aptos_framework::object::{Self, Object};
    use aptos_framework::fungible_asset::{Self, Metadata};
    use aptos_framework::primary_fungible_store;
${native ? '    use aptos_framework::aptos_coin::{Self, AptosCoin};\n    use aptos_framework::coin;\n' : ''}    use app::${design.moduleName};

    const DECIMALS: u8 = ${design.decimals.aptos};

    fun s(a: address): signer { account::create_signer_for_test(a) }
    fun at(t: u64) { if (t > timestamp::now_seconds()) { timestamp::update_global_time_for_test_secs(t); }; }
    fun fx_begin(t: u64) {
        let fw = account::create_signer_for_test(@aptos_framework);
        timestamp::set_time_has_started_for_testing(&fw);
        at(t);
    }
    fun fx_accounts(addrs: vector<address>) {
        let i = 0;
        while (i < vector::length(&addrs)) { account::create_account_for_test(*vector::borrow(&addrs, i)); i = i + 1; };
    }
    fun fx_token(seed: vector<u8>, owners: vector<address>, amounts: vector<u64>): address {
        let creator = account::create_signer_for_test(@0xf00d);
        let cref = object::create_named_object(&creator, seed);
        primary_fungible_store::create_primary_store_enabled_fungible_asset(&cref, option::none(), string::utf8(b"Fixture"), string::utf8(b"FX"), DECIMALS, string::utf8(b""), string::utf8(b""));
        let mref = fungible_asset::generate_mint_ref(&cref);
        let meta: Object<Metadata> = object::object_from_constructor_ref(&cref);
        let i = 0;
        while (i < vector::length(&owners)) { primary_fungible_store::mint(&mref, *vector::borrow(&owners, i), *vector::borrow(&amounts, i)); i = i + 1; };
        object::object_address(&meta)
    }
${native ? `    fun fx_native(addrs: vector<address>, amount: u64) {
        let fw = account::create_signer_for_test(@aptos_framework);
        let (burn, mint) = aptos_coin::initialize_for_test(&fw);
        let i = 0;
        while (i < vector::length(&addrs)) {
            let a = *vector::borrow(&addrs, i);
            coin::register<AptosCoin>(&account::create_signer_for_test(a));
            coin::deposit(a, coin::mint<AptosCoin>(amount, &mint));
            i = i + 1;
        };
        coin::destroy_burn_cap(burn);
        coin::destroy_mint_cap(mint);
    }
` : ''}`;
}

// ------------------------------------------------------------------------------------------------ result parsing

export interface TestResult {
  name: string;
  passed: boolean;
  /** failure details (when failed) */
  failure?: { line?: number; location?: string; abortCode?: number; kind: 'abort' | 'vm' | 'other'; message: string };
  prints: Map<string, string>;
}

const unq = (s: string) => s.replace(/^"/, '').replace(/"$/, '').replace(/\\"/g, '"').replace(/\\\\/g, '\\');

export function parseTestOutput(log: string): { results: Map<string, TestResult>; compileError: boolean; summary: string | null } {
  const lines = log.replace(/^\[aptos\] ?/gm, '').split('\n');
  const results = new Map<string, TestResult>();
  const get = (n: string): TestResult => { if (!results.has(n)) results.set(n, { name: n, passed: false, prints: new Map() }); return results.get(n)!; };
  for (const l of lines) {
    const m = /^\[ (PASS|FAIL|TIMEOUT)\s*\]\s+\S+::cmc_tests::(\w+)/.exec(l);
    if (m) { get(m[2]!).passed = m[1] === 'PASS'; continue; }
    const d = /^\[debug\] (".*")\s*$/.exec(l);
    if (d) {
      const v = unq(d[1]!);
      const p = /^CMC\|([^|]+)\|([^|]+)\|(\d+)\|([\s\S]*)$/.exec(v);
      if (p) get(p[1]!).prints.set(`${p[2]}|${p[3]}`, p[4]!);
    }
  }
  // failure blocks: "┌── name ──────" ... "└──────────────────"
  let cur: { name: string; text: string[] } | null = null;
  const blocks: { name: string; text: string[] }[] = [];
  for (const l of lines) {
    const h = /^┌── (\w+) ─+/.exec(l);
    if (h) { cur = { name: h[1]!, text: [] }; continue; }
    if (cur && /^└─+/.test(l)) { blocks.push(cur); cur = null; continue; }
    if (cur) cur.text.push(l);
  }
  for (const b of blocks) {
    const t = b.text.join('\n');
    const r = get(b.name);
    r.passed = false;
    const frame = [...t.matchAll(/cmc_tests::\w+\([^)\n]*cmc_tests\.move:(\d+)\)/g)].map((x) => Number(x[1]));
    const primary = /┌─ [^\n]*tests\/cmc_tests\.move:(\d+):\d+/.exec(t);
    const line = frame.length ? frame[frame.length - 1] : primary ? Number(primary[1]) : undefined;
    const code = /aborted with code (\d+)/.exec(t);
    const loc = /┌─ ([^\n]+?):\d+:\d+/.exec(t)?.[1];
    const vm = /but it gave (?:a |an )?([^\n]*?)\.?\s*(?:Error )?(?:originating|rooted)/.exec(t);
    const msg = /(Test was not expected to error, but [^\n]*?)(?: originating| rooted)/.exec(t)?.[1] ?? t.split('\n').find((x) => /error|abort/i.test(x)) ?? 'failed';
    r.failure = { ...(line !== undefined ? { line } : {}), ...(loc ? { location: loc.replace(/^.*\/(sources|tests)\//, '$1/') } : {}), ...(code ? { abortCode: Number(code[1]) } : {}), kind: code ? 'abort' : vm ? 'vm' : 'other', message: ell((vm ? `${vm[1]!.trim()}` : msg).replace(/\s+/g, ' '), 300) };
  }
  const summary = /Test result: (\w+)\. Total tests: (\d+); passed: (\d+); failed: (\d+)/.exec(log)?.[0] ?? null;
  const compileError = results.size === 0 && /error(\[\w+\])?:/.test(log);
  return { results, compileError, summary };
}
