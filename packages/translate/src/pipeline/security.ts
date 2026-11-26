import type { ContractSpec, ScenarioSet } from '../types.js';
import type { ScenarioOutcomeLike } from '../targets/pack.js';
import { SELF_SPEND_RULES } from '../targets/info.js';
import { expectedGuards, failClosedReason } from '../spec/guards.js';

/** result of the static security lint for one function of the rewrite */
export interface LintResult {
  fn: string;
  unit: string;
  /** guards of the original that the generated body was checked for */
  expected: string[];
  status: 'ok' | 'FAIL';
  problems: string[];
}

/** a line that names the caller AND checks something (comparison, assert / require / if / error return) */
const CHECKS = /(==|!=|\bif\b|assert|\bensure|\brequire|\bErr\b|ok_or|\babort|\bfail|\bmust\b|\bonly)/;
const CALLER_TOKEN: Record<string, RegExp> = { solana: /\bcaller\b[^;\n]*\.key\(\)|\.key\(\)[^;\n]*\bcaller\b|signer/i, cosmwasm: /info\.sender/, aptos: /address_of\s*\(/, tezos: /sp\.sender/ };

/** targets where token calls are queued messages / operations that run after the entrypoint and revert the whole transaction when they fail: the position of the pull relative to a state write does not matter there */
const QUEUED_OPS = new Set(['tezos', 'cosmwasm']);

interface TargetRules {
  /** a line that compares / asserts the caller */
  caller: RegExp;
  /** first state write or value transfer */
  write: RegExp;
  /** a token pull (transferFrom into the contract) */
  pull: RegExp;
  comment: RegExp;
}

const RULES: Record<string, TargetRules> = {
  solana: {
    caller: /require_keys_(eq|neq)!|\.key\(\)\s*(==|!=)|(==|!=)\s*[\w.()]*\.key\(\)|\bhas_one\b|helpers::(only|assert|ensure|require|check|verify|authori[sz]e)\w*\(/i,
    write: /ctx\.accounts\.[\w.\[\]]+\s*(\+|-)?=(?!=)|helpers::(lamports_out|lamports_in|user_to_vault|vault_to_account|\w*transfer\w*|\w*mint\w*|\w*burn\w*)\(|transfer_checked|token::transfer|token_interface::(transfer|mint|burn)|\.sub_lamports|\.add_lamports|invoke(_signed)?\(/,
    pull: /transfer_checked|token::transfer|token_interface::transfer|CpiContext|helpers::(user_to_vault|\w*(pull|deposit|transfer_in|transfer_from)\w*)\(/i,
    comment: /\/\/(.*)$/,
  },
  cosmwasm: {
    caller: /info\.sender[^;\n]*(==|!=)|(==|!=)[^;\n]*info\.sender|\b(only|assert|ensure|require|check|verify|authori[sz]e)\w*\([^)]*info/i,
    write: /\.save\(|\.update\(|\.remove\(|BankMsg|\bcw20_transfer(_from)?\(|\bbank_send\(|add_messages?\(|add_submessages?\(|WasmMsg|CosmosMsg/,
    pull: /TransferFrom|\bcw20_transfer_from\(|Cw20ExecuteMsg|WasmMsg::Execute|cw20/i,
    comment: /\/\/(.*)$/,
  },
  aptos: {
    caller: /address_of\s*\([^)]*\)\s*(==|!=)|(==|!=)\s*[\w:]*address_of|assert!\s*\([^;]*address_of|\b(only|assert|ensure|require|check|verify|authori[sz]e)\w*\(/i,
    write: /borrow_global_mut|table::(add|upsert|remove)|\bset_\w+\(|native_push|coin::|\bmove_to\b|primary_fungible_store|fungible_asset::|\b\w+_push\(|\b_?(mint|burn|transfer)\w*\(/,
    pull: /coin::|fungible_asset|primary_fungible_store|\b\w*(pull|withdraw|transfer_from|deposit|take)\w*\(/i,
    comment: /\/\/(.*)$/,
  },
  tezos: {
    caller: /sp\.sender\s*(==|!=)|(==|!=)\s*sp\.sender|assert[^\n]*sp\.sender|\bself\.(only|assert|ensure|require|check|verify|authori[sz]e)\w*\(/i,
    write: /self\.data\.[\w.\[\]]+\s*(\+|-)?=(?!=)|sp\.send\(|sp\.transfer\(|self\.send_native|\.send_native\(|\.erc20_(transfer|transfer_from|approve)\(/,
    pull: /sp\.transfer\(|sp\.contract\(|\bFA\d|token_transfer|\w*pull\w*\(|\.transfer_from\(|\.erc20_transfer_from\(/i,
    comment: /#(.*)$/,
  },
};

/** comment lines in which the generated code admits that it drops a guard / check and keeps going (these are errors, never notes) */
const DROPPED = /(omitted|skipped|skipping|not (translated|enforced|checked|verified|performed|validated)|cannot be (checked|enforced|verified|performed|translated|implemented|reproduced)|accepted as[- ]is|ignored|no equivalent|is dropped|left out|must be enforced (by|off-chain|at))/i;
const ABOUT_GUARD = /(check|guard|access|auth|signature|role|verif|modifier|permission|only[A-Z]\w*|owner|caller|msg\.sender|registry|replay|nonce)/i;
const BENIGN = /(fail(s|ed)? closed|reverts?\b|not supported on this target|reentran|re-entran|nonReentrant|transient|_initialized|initializ|event|gas)/i;

function stripLine(rules: TargetRules, line: string): { code: string; comment: string } {
  const m = rules.comment.exec(line);
  if (!m) return { code: line, comment: '' };
  return { code: line.slice(0, m.index), comment: m[1] ?? '' };
}

/**
 * Static security lint of model-written bodies. For every state-changing public function of the original that has a caller guard, a token pull
 * or an external dependency, the generated body must contain the matching construct BEFORE its first state write / value transfer; a function the
 * pipeline must fail closed on may not exist at all; comments admitting a dropped check are errors.
 */
export function lintSecurity(target: string, spec: ContractSpec, unitOf: (fn: string) => string | null, bodies: Record<string, string>, design?: { instructions?: any[]; accounts?: any[] }): LintResult[] {
  const rules = RULES[target];
  const out: LintResult[] = [];
  for (const f of spec.functions) {
    if (f.kind !== 'function' || !(f.visibility === 'public' || f.visibility === 'external') || f.mutability === 'view' || f.mutability === 'pure') continue;
    const unit = unitOf(f.name);
    if (!unit) continue;
    const body = bodies[unit];
    const problems: string[] = [];
    const expected: string[] = [];
    const fc = failClosedReason(f);
    if (fc) problems.push(`${f.name} must not be translated (${fc.feature}) but the rewrite has an entry point for it`);
    if (f.excluded) problems.push(`${f.name} (${f.excluded.category}) must not be an entry point`);
    if (body !== undefined && rules) {
      const lines = body.split('\n').map((l) => stripLine(rules, l));
      for (const l of lines) if (l.comment && DROPPED.test(l.comment) && ABOUT_GUARD.test(l.comment) && !BENIGN.test(l.comment)) problems.push(`comment admits a dropped check: "${l.comment.trim().slice(0, 140)}"`);
      const g = expectedGuards(f);
      const firstWrite = lines.findIndex((l) => rules.write.test(l.code));
      if (g.caller !== null) {
        expected.push(`caller guard (${g.caller.slice(0, 60)})`);
        const tok = CALLER_TOKEN[target];
        const at = lines.findIndex((l) => rules.caller.test(l.code) || (!!tok && tok.test(l.code) && CHECKS.test(l.code) && !rules.write.test(l.code)));
        if (at < 0) problems.push(`the original restricts the caller (${g.caller.slice(0, 80)}) but the generated body has no caller comparison`);
        else if (firstWrite >= 0 && at > firstWrite) problems.push('the caller guard comes after the first state write / value transfer');
      }
      if (g.pulls.length) {
        expected.push(`token pull (${g.pulls.map((e) => `${e.target}.${e.method}`).join(', ').slice(0, 80)})`);
        const at = lines.findIndex((l) => rules.pull.test(l.code));
        if (at < 0) problems.push(`the original pulls tokens (${g.pulls[0]!.target}.${g.pulls[0]!.method}) but the generated body has no token transfer in`);
        else if (!QUEUED_OPS.has(target) && firstWrite >= 0 && at > firstWrite && !rules.pull.test(lines[firstWrite]!.code)) problems.push('the token pull comes after the first state write: the effect would not depend on the funds');
      }
    }
    // Solana: the accounts the spec reads / writes must all be in the instruction
    if (target === 'solana' && design?.instructions) {
      const ins = design.instructions.find((i: any) => i.solidity === f.name);
      if (ins) {
        for (const n of (ins.notes ?? []) as string[]) if (/could not be resolved to an account/.test(n)) problems.push(`account missing: ${n.slice(0, 160)}`);
        const byState = new Map<string, Set<string>>();
        for (const m of f.mappingAccesses) {
          if (m.keys.some((k) => k.kind === 'literal' || (k.kind === 'expr' && /address\(0\)|^0$/.test(k.text)))) continue;
          const st = design.accounts?.find((a: any) => a.sources?.includes(m.variable));
          if (!st || st.role === 'item') continue;
          (byState.get(st.name) ?? byState.set(st.name, new Set()).get(st.name)!).add(JSON.stringify(m.keys));
        }
        for (const [st, keys] of byState) {
          const have = (ins.accounts ?? []).filter((r: any) => r.kind === 'entry' && r.state === st).length;
          if (have === 0) problems.push(`the spec reads/writes ${st} entries but the instruction has no ${st} account`);
          else if (have < keys.size && !(ins.notes ?? []).some((n: string) => /membership|derived/.test(n))) problems.push(`the spec touches ${keys.size} distinct ${st} entries but the instruction has ${have} ${st} accounts`);
        }
        expected.push('accounts complete');
      }
    }
    if (expected.length || problems.length) out.push({ fn: f.name, unit, expected, status: problems.length ? 'FAIL' : 'ok', problems });
  }
  return out;
}

/** a denied path that the rewrite allowed: the scenario expected a revert (the original reverted) and the rewrite succeeded */
export function negativeFailures(set: ScenarioSet, outcomes: ScenarioOutcomeLike[]): string[] {
  const out: string[] = [];
  const access = new Set(set.scenarios.filter((s) => s.kind === 'access').map((s) => s.id));
  for (const o of outcomes) {
    if (o.status !== 'failed' || !access.has(o.id)) continue;
    const m = o.mismatches.find((x) => !x.documented && typeof x.expected === 'string' && /^revert/.test(x.expected) && typeof x.actual === 'string' && /^success/.test(x.actual));
    if (m) out.push(`${o.fn ?? o.title}: "${o.title}" succeeded on the rewrite but reverted on the original`);
  }
  return out;
}

const SELF_SPEND = SELF_SPEND_RULES;

/**
 * Template paths only (standard SPL token / FA1.2 recipe, no model-written code): a `transferFrom` whose `from` is the caller succeeds on these
 * standards without an allowance while the ERC-20 original reverts. This is classified by code with the exact rule, as a documented difference,
 * not as a failure. Model-written code never gets this treatment.
 */
export function documentSelfSpend(target: string, set: ScenarioSet, outcomes: ScenarioOutcomeLike[]): ScenarioOutcomeLike[] {
  const rule = SELF_SPEND[target];
  if (!rule) return outcomes;
  const byId = new Map(set.scenarios.map((s) => [s.id, s]));
  return outcomes.map((o) => {
    if (o.status !== 'failed') return o;
    const sc = byId.get(o.id);
    if (!sc) return o;
    let changed = false;
    const mismatches = o.mismatches.map((m) => {
      if (m.documented || typeof m.expected !== 'string' || !/^revert/.test(m.expected) || m.actual !== 'success') return m;
      const st = sc.steps[Number(m.at)];
      if (st?.type === 'call' && (st.fn === 'transferFrom' || st.fn.startsWith('transferFrom_')) && st.args[0] && typeof st.args[0] === 'object' && !Array.isArray(st.args[0]) && 'actor' in st.args[0] && st.args[0].actor === st.actor) { changed = true; return { ...m, documented: rule }; }
      return m;
    });
    if (!changed) return o;
    return { ...o, mismatches, status: mismatches.every((m) => m.documented) ? 'documented-difference' as const : 'failed' as const };
  });
}

/**
 * Rust compile logs: `warning: unused variable: `x`` on a `let` statement. The binding is dead, but the right-hand side may still run (`?` returns early,
 * calls have effects), so it usually means the model dropped what the value was for. Returned as an error text for the compile-repair step ('' when none).
 */
export function deadStatements(log: string): string {
  const out: string[] = [];
  const re = /warning: unused variable: `(\w+)`\s*\n\s*--> ([^\n]+)\n(?:[^\n]*\n){0,4}?\s*\d+ \|\s*(let [^\n]*)/g;
  for (let m = re.exec(log); m; m = re.exec(log)) out.push(`error: dead statement\n --> ${m[2]}\n  \`${m[3]!.trim().slice(0, 140)}\` binds \`${m[1]}\` but never uses it. Either use the value (it is the result of a check or lookup the function needs) or delete the statement; do not leave a statement whose only effect is a hidden \`?\` early return.`);
  return [...new Set(out)].slice(0, 12).join('\n');
}
