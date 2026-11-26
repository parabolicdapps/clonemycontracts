import type { ContractSpec } from '../../types.js';
import type { HandlerD, StateVarD, TezosDesign } from './design-types.js';
import { snake } from './names.js';

/**
 * Pre-compile normalisation and lint of a model-written body. The SmartPy compiler stops at the FIRST error, so each compile round fixes one
 * thing; this file removes the whole class of known mistakes before a round is spent:
 *  - `normaliseBody` rewrites mistakes that have exactly one meaning (elif, //, **, annotated assignments, sp.failwith, raw map reads,
 *    `x -= y` on nats, Solidity spellings such as msg.sender or require(...)) and reports every rewrite;
 *  - `lintBody` reports what cannot be rewritten, ALL of it at once, each with a specific message.
 * Every rule below was checked against the real compiler (see test/tezos-lint.test.ts and docs in targets/tezos/primer.md).
 */
export interface LintIssue { line: number; rule: string; message: string }
export interface Normalised { body: string; fixes: string[] }

/** replace the contents of string literals and comments by `_` / spaces so regexes cannot match inside them (same length) */
export function mask(line: string): string {
  let out = '';
  let q: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (q) {
      if (c === '\\') { out += '__'; i++; continue; }
      if (c === q) { q = null; out += c; } else out += '_';
    } else if (c === '"' || c === "'") { q = c; out += c; }
    else if (c === '#') { out += ' '.repeat(line.length - i); break; }
    else out += c;
  }
  return out;
}

export function findClose(s: string, open: number): number {
  const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
  const stack: string[] = [];
  for (let i = open; i < s.length; i++) {
    const c = s[i]!;
    if (pairs[c]) stack.push(pairs[c]!);
    else if (c === ')' || c === ']' || c === '}') { if (stack.pop() !== c) return -1; if (!stack.length) return i; }
  }
  return -1;
}

export function splitTop(s: string): string[] {
  const m = mask(s);
  const out: string[] = []; let depth = 0; let start = 0;
  for (let i = 0; i < m.length; i++) {
    const c = m[i]!;
    if ('([{'.includes(c)) depth++; else if (')]}'.includes(c)) depth--;
    else if (c === ',' && depth === 0) { out.push(s.slice(start, i).trim()); start = i + 1; }
  }
  const last = s.slice(start).trim();
  if (last || out.length) out.push(last);
  return out;
}

interface Ctx { d: TezosDesign; h: HandlerD; spec?: ContractSpec }
const mapVars = (d: TezosDesign): StateVarD[] => d.state.filter((s) => !s.unsupported && (s.kind === 'map' || s.kind === 'array'));
const itemVars = (d: TezosDesign): StateVarD[] => d.state.filter((s) => !s.unsupported && s.kind === 'item');
const isNatLike = (sv: StateVarD) => sv.value.kind === 'uint' || sv.value.kind === 'enum';

const indentOf = (l: string) => l.length - l.trimStart().length;

/** elif chains -> nested if/else (SmartPy rejects `elif`) */
export function fixElif(lines: string[]): { lines: string[]; n: number } {
  let n = 0;
  for (let guard = 0; guard < 200; guard++) {
    const i = lines.findIndex((l) => /^\s*elif\b/.test(mask(l)));
    if (i < 0) break;
    const ind = indentOf(lines[i]!);
    let j = i + 1;
    for (; j < lines.length; j++) {
      const l = lines[j]!;
      if (!l.trim()) continue;
      const li = indentOf(l);
      if (li > ind) continue;
      if (li === ind && /^\s*(elif\b|else\s*:)/.test(mask(l))) continue;
      break;
    }
    const cond = lines[i]!.trim().replace(/^elif\b/, 'if');
    const pad = ' '.repeat(ind);
    const shifted = lines.slice(i + 1, j).map((l) => (l.trim() ? '    ' + l : l));
    lines = [...lines.slice(0, i), `${pad}else:`, `${pad}    ${cond}`, ...shifted, ...lines.slice(j)];
    n++;
  }
  return { lines, n };
}

/** replace `self.data.NAME[KEY]` reads (not assignment targets) by `self.get_NAME(KEY)`, and compound assignments on entries by plain ones */
function fixMapAccess(line: string, d: TezosDesign, fixes: string[]): string {
  let cur = line;
  for (const sv of mapVars(d)) {
    const tok = `self.data.${sv.name}[`;
    for (let guard = 0; guard < 20; guard++) {
      const m = mask(cur);
      let pos = -1;
      // find the first occurrence that is a READ
      let from = 0;
      while (true) {
        const p = m.indexOf(tok, from);
        if (p < 0) break;
        const before = m.slice(0, p);
        const open = p + tok.length - 1;
        const close = findClose(m, open);
        if (close < 0) { from = p + 1; continue; }
        const after = m.slice(close + 1);
        const isTarget = /^\s*$/.test(before.replace(/\bdel\s*$/, '')) && /^\s*=(?!=)/.test(after);
        const isCompound = /^\s*$/.test(before) && /^\s*(\+|-|\*|\/)=/.test(after);
        if (isTarget) { from = close + 1; continue; }
        pos = p;
        if (isCompound) {
          const op = /^\s*(\+|-|\*|\/)=/.exec(after)![1]!;
          const key = cur.slice(open + 1, close);
          const afterStart = close + 1 + after.indexOf(op + '=') + 2;
          const rhs = cur.slice(afterStart).trim().replace(/;$/, '');
          const getter = sv.kind === 'array' ? `self.get_${sv.name}(${key})` : `self.get_${sv.name}(${key})`;
          let expr = `${getter} ${op} (${rhs})`;
          if (op === '-' && isNatLike(sv)) expr = `sp.as_nat(${getter} - (${rhs}), error="UNDERFLOW")`;
          cur = `${cur.slice(0, p)}self.data.${sv.name}[${key}] = ${expr}`;
          fixes.push(`compound assignment on \`${sv.name}[..]\` rewritten to read through \`self.get_${sv.name}\` (a missing entry reads as the Solidity default)`);
        } else {
          const key = cur.slice(open + 1, close);
          cur = `${cur.slice(0, p)}self.get_${sv.name}(${key})${cur.slice(close + 1)}`;
          fixes.push(`read of \`self.data.${sv.name}[..]\` rewritten to \`self.get_${sv.name}(..)\``);
        }
        break;
      }
      if (pos < 0) break;
    }
    // .get(key, default=..) / .get(key) -> helper
    for (let guard = 0; guard < 20; guard++) {
      const m = mask(cur);
      const t = `self.data.${sv.name}.get(`;
      const p = m.indexOf(t);
      if (p < 0) break;
      const open = p + t.length - 1;
      const close = findClose(m, open);
      if (close < 0) break;
      const args = splitTop(cur.slice(open + 1, close));
      cur = `${cur.slice(0, p)}self.get_${sv.name}(${args[0]})${cur.slice(close + 1)}`;
      fixes.push(`\`self.data.${sv.name}.get(..)\` rewritten to \`self.get_${sv.name}(..)\` (the helper already defaults to the Solidity zero value)`);
    }
    if (sv.kind === 'array') {
      cur = cur.replace(new RegExp(`\\b(?:sp\\.)?len\\(self\\.data\\.${sv.name}\\)`, 'g'), () => { fixes.push(`length of \`${sv.name}\` rewritten to ${sv.fixedLen ? `the constant ${sv.fixedLen}` : `\`self.data.${sv.name}_len\``}`); return sv.fixedLen ? `sp.nat(${sv.fixedLen})` : `self.data.${sv.name}_len`; });
      if (!sv.fixedLen) cur = cur.replace(new RegExp(`self\\.data\\.${sv.name}\\.push\\(`, 'g'), () => { fixes.push(`\`${sv.name}.push\` rewritten to \`self.push_${sv.name}\``); return `self.push_${sv.name}(`; });
      if (!sv.fixedLen) cur = cur.replace(new RegExp(`self\\.data\\.${sv.name}\\.pop\\(\\)`, 'g'), () => { fixes.push(`\`${sv.name}.pop\` rewritten to \`self.pop_${sv.name}\``); return `self.pop_${sv.name}()`; });
    }
  }
  return cur;
}

const BOUNDARY_WORD = /\b(and|or|not|if|elif|else|while|for|assert|return|in|raise)\s*$/;
const isCmpAt = (m: string, i: number) => /[<>]/.test(m[i]!) || (m[i] === '=' && (m[i - 1] === '=' || m[i - 1] === '!' || m[i - 1] === '<' || m[i - 1] === '>' || m[i + 1] === '='));

/** span (start, end) of the additive expression around the binary minus at `i` in masked line `m` */
function additiveSpan(m: string, i: number): [number, number] {
  let s = 0; let d = 0;
  for (let k = i - 1; k >= 0; k--) {
    const c = m[k]!;
    if (c === ')' || c === ']' || c === '}') d++;
    else if (c === '(' || c === '[' || c === '{') { if (d === 0) { s = k + 1; break; } d--; }
    else if (d === 0 && (c === ',' || c === ':' || (c === '=' && !isCmpAt(m, k)) || isCmpAt(m, k) || BOUNDARY_WORD.test(m.slice(0, k + 1)))) { s = k + 1; break; }
  }
  let e = m.length; d = 0;
  for (let k = i + 1; k < m.length; k++) {
    const c = m[k]!;
    if (c === '(' || c === '[' || c === '{') d++;
    else if (c === ')' || c === ']' || c === '}') { if (d === 0) { e = k; break; } d--; }
    else if (d === 0 && (c === ',' || c === ':' || c === '#' || (c === '=' && !isCmpAt(m, k)) || isCmpAt(m, k) || /^\s+(and|or|if|else|for)\b/.test(m.slice(k)) && /\s/.test(c))) { e = k; break; }
  }
  return [s, e];
}

/**
 * In a contract without any signed integer every Solidity subtraction is a uint subtraction that reverts on underflow. SmartPy's `a - b` of nats is an
 * INT, the number one type error of the benchmark ("nat and int cannot be multiplied"): wrap each additive expression that contains a binary minus in
 * `sp.as_nat(.., error="UNDERFLOW")`. Explicit integer math (sp.to_int, abs, timestamps) is left alone.
 */
export function wrapSubtractions(line: string): { line: string; n: number } {
  let cur = line; let n = 0;
  for (let guard = 0; guard < 30; guard++) {
    const m = mask(cur);
    let done = true;
    for (let i = 1; i < m.length; i++) {
      if (m[i] !== '-' || m[i + 1] === '=' || m[i + 1] === '>') continue;
      const before = m.slice(0, i).trimEnd();
      if (!/[\w)\]]$/.test(before) || /\b(and|or|not|if|elif|else|while|for|assert|return|in|raise|is)$/.test(before)) continue; // unary minus
      const [s, e] = additiveSpan(m, i);
      const span = cur.slice(s, e).trim();
      const head = m.slice(0, s).trimEnd();
      if (/\b(sp\.as_nat|abs|sp\.to_int|sp\.int|sp\.nat|sp\.mul)\($/.test(head)) continue;
      if (/sp\.(to_int|int|now|timestamp|mutez|tez|add_seconds)|\babs\(|\bint\(/.test(m.slice(s, e))) continue;
      const lead = cur.slice(s, e).match(/^\s*/)![0]; const trail = cur.slice(s, e).match(/\s*$/)![0];
      cur = `${cur.slice(0, s)}${lead}sp.as_nat(${span}, error="UNDERFLOW")${trail}${cur.slice(e)}`;
      n++; done = false;
      break;
    }
    if (done) break;
  }
  return { line: cur, n };
}

const hasBinaryMinus = (m: string): boolean => {
  for (let i = 1; i < m.length; i++) {
    if (m[i] !== '-' || m[i + 1] === '=' || m[i + 1] === '>') continue;
    const before = m.slice(0, i).trimEnd();
    if (/[\w)\]]$/.test(before) && !/\b(and|or|not|if|elif|else|while|for|assert|return|in|raise|is)$/.test(before)) return true;
  }
  return false;
};

/**
 * `sp.as_nat(x)` only accepts an INT; around an expression that is already a nat (`released + amount`) it is a compile error ("sp.is_nat: mismatch
 * between sp.int and sp.nat"), a mistake the model makes constantly. In a contract without signed integers, drop the wrapper when its argument contains no
 * subtraction and no explicit int conversion.
 */
export function unwrapNatAs(line: string): { line: string; n: number } {
  let cur = line; let n = 0;
  for (let guard = 0; guard < 20; guard++) {
    const m = mask(cur);
    let done = true;
    for (const x of m.matchAll(/\bsp\.as_nat\(/g)) {
      const open = x.index! + x[0].length - 1;
      const close = findClose(m, open);
      if (close < 0) continue;
      const args = splitTop(cur.slice(open + 1, close));
      const first = args[0] ?? '';
      const fm = mask(first);
      if (hasBinaryMinus(fm) || /sp\.(to_int|int)\(|\babs\(|\bint\(|sp\.now|sp\.timestamp/.test(fm) || !first) continue;
      cur = `${cur.slice(0, x.index!)}${/^[\w.]+(\(.*\))?$/.test(first) || /^\(.*\)$/.test(first) ? first : `(${first})`}${cur.slice(close + 1)}`;
      n++; done = false;
      break;
    }
    if (done) break;
  }
  return { line: cur, n };
}

const SOL_EVENT = /^(\s*)emit\s+(\w+)\s*\((.*)\)\s*;?\s*$/;

export function normaliseBody(body: string, c: Ctx): Normalised {
  const fixes: string[] = [];
  let lines = body.replace(/\r/g, '').replace(/\t/g, '    ').split('\n');
  const d = c.d;
  // multi-line statements are rare in model output; the line-based fixes below skip lines whose brackets are unbalanced
  lines = lines.map((raw) => {
    let l = raw;
    const m0 = mask(l);
    if (/;\s*$/.test(m0)) { l = l.replace(/;\s*$/, ''); fixes.push('trailing `;` removed'); }
    // Solidity spellings
    const sub = (re: RegExp, to: string, what: string) => { l = replaceMasked(l, re, to, () => fixes.push(what)); };
    if (/\bsp\.bytes\(\s*(""|'')\s*\)/.test(l)) { l = l.replace(/\bsp\.bytes\(\s*(""|'')\s*\)/g, 'sp.bytes("0x")'); fixes.push('`sp.bytes("")` -> `sp.bytes("0x")` (an empty string is an empty SExpr atom in SmartPy; empty bytes are `0x`)'); }
    // type position written as a call: `sp.TPair(a, b)` / `sp.cast(x, sp.pair(a, b))` -> `sp.pair[a, b]` (SmartPy 0.25 types are subscripted)
    for (let guard = 0; guard < 6 && /\bsp\.TPair\(/.test(l); guard++) { const before = l; l = l.replace(/\bsp\.TPair\(([^()]*)\)/g, 'sp.pair[$1]'); if (l !== before) fixes.push('`sp.TPair(a, b)` -> `sp.pair[a, b]` (a type)'); }
    for (let guard = 0; guard < 6 && /\bsp\.cast\([^\n]*,\s*sp\.pair\(/.test(l); guard++) { const before = l; l = l.replace(/(\bsp\.cast\([^\n]*,\s*)sp\.pair\(([^()]*)\)/g, '$1sp.pair[$2]'); if (l !== before) fixes.push('type `sp.pair(a, b)` in `sp.cast` -> `sp.pair[a, b]`'); }
    // value position: `sp.pair(a, b)` is not a SmartPy function ("sp.pair is undefined or wrong number of arguments"); a pair value is the tuple `(a, b)`
    for (let guard = 0; guard < 6 && /\bsp\.pair\(/.test(l); guard++) { const before = l; l = l.replace(/\bsp\.pair\(((?:[^()]|\([^()]*\))*,(?:[^()]|\([^()]*\))*)\)/, '($1)'); if (l !== before) fixes.push('value `sp.pair(a, b)` -> tuple `(a, b)`'); else break; }
    // ONE hash spelling: `keccak256(abi.encode(a, b))` / `keccak256(abi.encodePacked(a, b))` / `keccak256(x)` -> `sp.keccak(sp.pack((a, b)))` (fixed packing: the hash of the same
    // operation is identical in every entrypoint, e.g. a timelock's queue / cancel / execute)
    for (let guard = 0; guard < 6; guard++) {
      const km = /\bkeccak256\s*\(/.exec(l);
      if (!km) break;
      const open = km.index + km[0].length - 1;
      const close = findClose(l, open);
      if (close < 0) break;
      let inner = l.slice(open + 1, close).trim();
      const em = /^abi\.(encode|encodePacked)\s*\(/.exec(inner);
      if (em) { const eo = em[0].length - 1; const ec = findClose(inner, eo); if (ec === inner.length - 1) inner = inner.slice(eo + 1, ec).trim(); }
      const args = splitTop(inner).filter((a) => a.length);
      l = `${l.slice(0, km.index)}sp.keccak(sp.pack(${args.length > 1 ? `(${args.join(', ')})` : args[0] ?? 'sp.bytes("0x")'}))${l.slice(close + 1)}`;
      fixes.push('`keccak256(...)` -> `sp.keccak(sp.pack(...))` (one fixed hash packing)');
    }
    sub(/\bmsg\.sender\b/g, 'sp.sender', '`msg.sender` -> `sp.sender`');
    sub(/\bmsg\.value\b/g, 'self.msg_value()', '`msg.value` -> `self.msg_value()`');
    sub(/\bblock\.timestamp\b/g, 'self.now_secs()', '`block.timestamp` -> `self.now_secs()`');
    sub(/\baddress\(this\)/g, 'sp.self_address', '`address(this)` -> `sp.self_address`');
    sub(/\baddress\(0\)/g, 'ZERO_ADDRESS', '`address(0)` -> `ZERO_ADDRESS`');
    sub(/\btrue\b/g, 'True', '`true` -> `True`');
    sub(/\bfalse\b/g, 'False', '`false` -> `False`');
    sub(/\s*&&\s*/g, ' and ', '`&&` -> `and`');
    sub(/\s*\|\|\s*/g, ' or ', '`||` -> `or`');
    sub(/\bsp\.failwith\(([^()]*)\)/g, 'raise $1', '`sp.failwith(x)` -> `raise x`');
    sub(/\bentry_point\s*=/g, 'entrypoint=', '`entry_point=` -> `entrypoint=`');
    // require(cond, "msg") / revert("msg")
    const rq = /^(\s*)require\((.*)\)\s*$/.exec(mask(l)) ? /^(\s*)require\(([\s\S]*)\)\s*$/.exec(l) : null;
    if (rq) { const parts = splitTop(rq[2]!); l = `${rq[1]}assert ${parts[0]}${parts[1] ? `, ${parts[1]}` : ''}`; fixes.push('`require(c, "m")` -> `assert c, "m"`'); }
    const rv = /^(\s*)revert\((.*)\)\s*$/.exec(l);
    if (rv) { l = `${rv[1]}raise ${rv[2] || '"REVERT"'}`; fixes.push('`revert("m")` -> `raise "m"`'); }
    // emit Name(a, b)
    const em = SOL_EVENT.exec(l);
    if (em && c.spec) {
      const ev = c.spec.events.find((e) => e.name === em[2]);
      const args = splitTop(em[3]!);
      if (ev && args.length === ev.params.length) { l = `${em[1]}sp.emit(${ev.params.length ? `sp.record(${ev.params.map((p, i) => `${snake(p.name || `field${i}`)}=${args[i]}`).join(', ')})` : 'sp.unit'}, tag="${ev.name}")`; fixes.push(`\`emit ${ev.name}(..)\` -> \`sp.emit(sp.record(..), tag="${ev.name}")\``); }
    }
    // annotated assignment
    const an = /^(\s*)([A-Za-z_]\w*)\s*:\s*([A-Za-z_][\w.\[\], ]*?)\s*=(?!=)\s*(.+)$/.exec(mask(l));
    if (an && !/^(if|elif|else|for|while|def|class|with|try|except|lambda|assert|return|raise|del|pass)$/.test(an[2]!)) {
      const rhsStart = l.indexOf('=', l.indexOf(':')) + 1;
      l = `${an[1]}${an[2]} = ${l.slice(rhsStart).trim()}`; fixes.push('annotated assignment `x: T = v` -> `x = v`');
    }
    // // and **
    if (/\/\//.test(mask(l))) { l = replaceMasked(l, /\/\//g, '/', () => fixes.push('`//` -> `/` (nat division already floors)')); }
    for (let g = 0; g < 5; g++) {
      const mm = mask(l);
      const p = /(\([^()]*\)|[\w.]+(?:\([^()]*\))?)\s*\*\*\s*(\([^()]*\)|[\w.]+(?:\([^()]*\))?)/.exec(mm);
      if (!p) break;
      const [a, b] = [l.slice(p.index, p.index + p[1]!.length), l.slice(p.index + p[0].length - p[2]!.length, p.index + p[0].length)];
      const lit = /^\d+$/.test(a) && /^\d+$/.test(b) ? (BigInt(a) ** BigInt(b)).toString() : null;
      const rep = lit ?? `pow_nat((${a.replace(/^\((.*)\)$/, '$1')}, ${b.replace(/^\((.*)\)$/, '$1')}))`;
      l = l.slice(0, p.index) + rep + l.slice(p.index + p[0].length);
      fixes.push(lit ? '`a ** b` of literals folded to a number' : '`a ** b` -> `pow_nat((a, b))`');
    }
    // x -= y on a local (nat) variable of a contract without signed integers
    const lm = !d.hasSigned ? /^(\s*)([A-Za-z_]\w*)\s*-=\s*(.+)$/.exec(l) : null;
    if (lm) { l = `${lm[1]}${lm[2]} = sp.as_nat(${lm[2]} - (${lm[3]!.trim()}), error="UNDERFLOW")`; fixes.push('`x -= y` on a nat local -> `sp.as_nat(x - (y), error="UNDERFLOW")`'); }
    // -= on a nat storage item
    const sm = /^(\s*)self\.data\.(\w+)\s*-=\s*(.+)$/.exec(l);
    if (sm) {
      const sv = itemVars(d).find((s) => s.name === sm[2]);
      if (sv && isNatLike(sv)) { l = `${sm[1]}self.data.${sv.name} = sp.as_nat(self.data.${sv.name} - (${sm[3]!.trim()}), error="UNDERFLOW")`; fixes.push(`\`self.data.${sv.name} -= x\` on a nat -> \`sp.as_nat(.. - x, error="UNDERFLOW")\``); }
    }
    return l;
  });
  const e = fixElif(lines); lines = e.lines; if (e.n) fixes.push(`${e.n} \`elif\` rewritten as nested else/if (SmartPy has no elif)`);
  lines = lines.map((l) => fixMapAccess(l, d, fixes));
  lines = lines.map((l) => { const m = /^(\s*)del\s+self\.get_(\w+)\((.*)\)\s*$/.exec(l); if (m && d.state.some((s) => s.name === m[2] && (s.kind === 'map' || s.kind === 'array'))) { fixes.push(`\`del self.get_${m[2]}(k)\` -> \`del self.data.${m[2]}[k]\``); return `${m[1]}del self.data.${m[2]}[${m[3]}]`; } return l; });
  if (!d.hasSigned) lines = lines.map((l) => { const u = unwrapNatAs(l); if (u.n) fixes.push('`sp.as_nat(x)` around an expression that is already a nat (no subtraction inside) removed: as_nat only accepts an int'); return u.line; });
  if (!d.hasSigned) lines = lines.map((l) => { const w = wrapSubtractions(l); if (w.n) fixes.push('`a - b` on nats is an int in SmartPy: wrapped in `sp.as_nat(.., error="UNDERFLOW")` (the contract has no signed integers, so every Solidity subtraction reverts on underflow)'); return w.line; });
  // helper call arity: get_x(a, b) -> get_x((a, b))
  lines = lines.map((l) => fixTupleArgs(l, d, fixes));
  return { body: lines.join('\n'), fixes: [...new Set(fixes)].filter(Boolean) };
}

function replaceMasked(line: string, re: RegExp, to: string, onHit: () => void): string {
  const m = mask(line);
  let out = ''; let last = 0; let hit = false;
  for (const x of m.matchAll(re)) {
    out += line.slice(last, x.index) + to.replace(/\$(\d)/g, (_, n) => (x[Number(n)] !== undefined ? line.slice(x.index! + x[0].indexOf(x[Number(n)]!), x.index! + x[0].indexOf(x[Number(n)]!) + x[Number(n)]!.length) : ''));
    last = x.index! + x[0].length; hit = true;
  }
  if (!hit) return line;
  onHit();
  return out + line.slice(last);
}

function fixTupleArgs(line: string, d: TezosDesign, fixes: string[]): string {
  let cur = line;
  for (const sv of mapVars(d)) {
    if (sv.kind !== 'map' || sv.keys.length < 2) continue;
    const t = `self.get_${sv.name}(`;
    const m = mask(cur);
    const p = m.indexOf(t);
    if (p < 0) continue;
    const open = p + t.length - 1; const close = findClose(m, open);
    if (close < 0) continue;
    const args = splitTop(cur.slice(open + 1, close));
    if (args.length === sv.keys.length && args.length > 1) { cur = `${cur.slice(0, open + 1)}(${args.join(', ')})${cur.slice(close)}`; fixes.push(`\`self.get_${sv.name}(a, b)\` -> \`self.get_${sv.name}((a, b))\` (helpers take ONE argument: a tuple for several keys)`); }
  }
  return cur;
}

// ---------------------------------------------------------------- lint (what cannot be rewritten)

const BAD: { rule: string; re: RegExp; message: string; views?: boolean }[] = [
  { rule: 'fstring', re: /\bf["']/, message: 'f-strings are not supported; build strings with sp.concat([a, b]) (strings only) ' },
  { rule: 'lambda', re: /\blambda\b/, message: 'lambda is not supported' },
  { rule: 'comprehension', re: /\[[^\]]*\bfor\b[^\]]*\bin\b[^\]]*\]/, message: 'list comprehensions are not supported; use a for loop and an accumulator' },
  { rule: 'try', re: /^\s*(try|except|finally)\b/, message: 'try/except does not exist; a failing check aborts the whole transaction (use assert)' },
  { rule: 'import', re: /^\s*(import|from)\s/, message: 'no imports inside a body; everything needed is already in scope' },
  { rule: 'nested-def', re: /^\s*(def|class)\s/, message: 'no nested def/class inside a body; inline the logic' },
  { rule: 'print', re: /\bprint\(/, message: 'print() does not exist in SmartPy contracts; remove it' },
  { rule: 'python-cast', re: /(?<![\w.])(str|int|float|bool|hex|bytes)\(/, message: 'no Python casts: values already have the right SmartPy type (sp.to_int(n) turns a nat into an int, sp.as_nat(i) an int into a nat)' },
  { rule: 'float', re: /(^|[^\w.])\d+\.\d+\b/, message: 'no floating point numbers' },
  { rule: 'solidity-cast', re: /(?<![\w.])(uint\d*|int\d*|bytes\d*|address|payable|bool|string)\(/, message: 'no Solidity casts: SmartPy values already have the right type (use sp.to_int / sp.as_nat to convert between int and nat)' },
  { rule: 'solidity-global', re: /\b(msg\.(sender|value|data|sig)|block\.(timestamp|number|chainid|coinbase|difficulty|gaslimit|prevrandao|basefee)|tx\.(origin|gasprice))\b/, message: 'Solidity global (msg/block/tx): use sp.sender, self.msg_value(), self.now_secs()' },
  { rule: 'sp-undefined', re: /\bsp\.(mod|div|sub|add|exp|sqrt|log|require|verify|TNat|TInt|TAddress|TMap|TBigMap|TList|TRecord|TString|TBool|TMutez|TTimestamp|local|pow|set_type|open_some|is_failing|result|build_lambda|self_entry_point)\b/, message: 'this sp.* name does not exist in SmartPy 0.25 (use assert/raise, sp.nat/sp.address types, plain local variables)' },
  { rule: 'semicolon-decl', re: /^\s*(uint\d*|int\d*|address|bool|string|bytes\d*)\s+(memory\s+|storage\s+|payable\s+)?\w+\s*(=|$)/, message: 'a Solidity declaration: write the SmartPy assignment instead (x = ...)' },
  { rule: 'nat-int-cast', re: /\bsp\.(nat|int)\((?!\s*-?\d+\s*\))/, message: 'sp.nat(x)/sp.int(x) only take a literal number; convert variables with sp.as_nat(i) (int -> nat, aborts if negative) or sp.to_int(n) (nat -> int)' },
  { rule: 'contains', re: /\.(append|extend|insert|remove|update|keys|values|items)\(/, message: 'no Python container methods on state; use the generated helpers and `for` over lists' },
];

export function lintBody(body: string, h: HandlerD, d: TezosDesign): LintIssue[] {
  const out: LintIssue[] = [];
  const lines = body.split('\n');
  const helperNames = new Set(d.helpers.map((x) => x.name));
  const storage = new Set<string>();
  for (const s of d.state) { storage.add(s.name); if (s.kind === 'array' && !s.fixedLen) storage.add(`${s.name}_len`); }
  const oneArg = new Set(d.helpers.filter((x) => !/\(\)$/.test(x.sig)).map((x) => x.name));
  const zeroArg = new Set(d.helpers.filter((x) => /\(\)$/.test(x.sig)).map((x) => x.name));
  let hasReturn = false;
  lines.forEach((raw, idx) => {
    const l = mask(raw);
    const at = idx + 1;
    const add = (rule: string, message: string) => out.push({ line: at, rule, message });
    for (const b of BAD) if (b.re.test(l)) add(b.rule, b.message);
    if (/\bsp\.failwith\b|\brequire\s*\(/.test(l)) add('failwith', 'use `assert cond, "MESSAGE"` or `raise "MESSAGE"`; sp.failwith and require() do not exist');
    if (/^\s*return\b/.test(l)) {
      if (h.kind === 'view') hasReturn = true;
      else if (/^\s*return\s+\S/.test(l)) add('return-value', `${h.kind === 'initialize' ? 'initialize' : 'an entrypoint'} returns nothing: drop the return value (state-changing functions return no value on Tezos)`);
    }
    for (const m of l.matchAll(/\bself\.data\.(\w+)/g)) {
      const f = m[1]!;
      if (f === 'deployer' || f === 'initialized') { if (/\bself\.data\.(deployer|initialized)\s*(=(?!=)|\+=|-=)/.test(l)) add('reserved-storage', `self.data.${f} is generated storage and must not be assigned`); continue; }
      if (!storage.has(f)) add('unknown-storage', `self.data.${f} does not exist. Storage fields: ${[...storage].join(', ') || '(none)'}`);
    }
    for (const sv of mapVars(d)) {
      if (new RegExp(`\\bin\\s+self\\.data\\.${sv.name}\\b`).test(l)) add('map-contains', `\`x in self.data.${sv.name}\` is not allowed: read the value with \`self.get_${sv.name}(key)\` (missing = Solidity default) and compare it`);
      if (new RegExp(`self\\.data\\.${sv.name}\\.(contains|keys|values|items|get|add|remove)\\b`).test(l)) add('map-method', `${sv.name} is a big_map: it has no iteration or membership; use \`self.get_${sv.name}(key)\` and \`self.data.${sv.name}[key] = value\``);
    }
    for (const m of l.matchAll(/\bself\.(\w+)\s*\(/g)) {
      const name = m[1]!;
      if (!helperNames.has(name)) { add('unknown-method', `self.${name}(...) does not exist. Helpers you may call: ${[...helperNames].join(', ')}. Entrypoints cannot call each other: inline the logic`); continue; }
      const open = m.index! + m[0].length - 1;
      const close = findClose(l, open);
      if (close < 0) continue;
      const inner = raw.slice(open + 1, close);
      const args = inner.trim() ? splitTop(inner) : [];
      if (oneArg.has(name) && args.length !== 1) add('helper-arity', `self.${name} takes exactly ONE argument${/^(erc20_|send_native)/.test(name) ? ' (an sp.record(...), see its signature)' : ' (several keys go in a tuple: (a, b))'}, you passed ${args.length}`);
      if (zeroArg.has(name) && args.length) add('helper-arity', `self.${name}() takes no argument`);
    }
    if (h.kind === 'view' && /\bsp\.(sender|amount|source)\b/.test(l)) add('view-context', 'on-chain views cannot read sp.sender / sp.amount / sp.source (no transaction context); take the address as a view argument');
    if (/\bsp\.(contract|transfer|send)\b/.test(l) && h.kind === 'view') add('view-effects', 'views cannot send operations');
  });
  out.push(...lintReturns(body, h));
  out.push(...lintScopes(body, h, d));
  void hasReturn;
  return out;
}

// ---------------------------------------------------------------- structure: return placement and variable scope (both verified on SmartPy 0.25.3)

interface Stmt { line: number; text: string; indent: number; kind: 'simple' | 'if' | 'else' | 'loop'; body: Stmt[]; orelse?: Stmt[] }

/** indentation tree of a body (a statement owns the more-indented lines after it; `else:` attaches to the previous `if`) */
export function parseBlocks(lines: string[]): Stmt[] {
  const root: Stmt[] = [];
  const stack: { indent: number; list: Stmt[] }[] = [{ indent: -1, list: root }];
  let lastIf: Stmt | null = null;
  const lastAt: Map<number, Stmt> = new Map();
  lines.forEach((raw, i) => {
    const m = mask(raw);
    if (!m.trim()) return;
    const indent = indentOf(raw);
    while (stack.length > 1 && indent <= stack[stack.length - 1]!.indent) stack.pop();
    const t = m.trim();
    const kind: Stmt['kind'] = /^if\b.*:$/.test(t) ? 'if' : /^else\s*:$/.test(t) ? 'else' : /^(for|while)\b.*:$/.test(t) ? 'loop' : 'simple';
    const st: Stmt = { line: i + 1, text: raw.trim(), indent, kind, body: [] };
    // a more-indented line belongs to the previous statement of the enclosing block
    const parentList = ((): Stmt[] => {
      const top = stack[stack.length - 1]!;
      if (indent > top.indent) {
        const prev = top.list[top.list.length - 1];
        if (prev && prev.indent < indent && (prev.kind !== 'simple')) { const target = prev.kind === 'else' || prev.kind === 'if' || prev.kind === 'loop' ? (prev.kind === 'else' ? prev.body : prev.body) : prev.body; stack.push({ indent: prev.indent, list: target }); return target; }
      }
      return top.list;
    })();
    if (kind === 'else') {
      const prevIf = [...parentList].reverse().find((x) => x.kind === 'if' && x.indent === indent);
      if (prevIf) { prevIf.orelse = st.body; parentList.push(st); lastIf = prevIf; lastAt.set(indent, prevIf); return; }
    }
    parentList.push(st);
  });
  void lastIf;
  return root;
}

const endsOk = (stmts: Stmt[]): boolean => {
  const last = stmts[stmts.length - 1];
  if (!last) return false;
  if (last.kind === 'simple') return /^return\b/.test(last.text);
  if (last.kind === 'else') { const ifs = [...stmts].reverse().find((x) => x.kind === 'if'); return !!ifs && endsOk(ifs.body) && endsOk(last.body); }
  return false;
};
const containsReturn = (stmts: Stmt[]): Stmt | null => { for (const s of stmts) { if (s.kind === 'simple' && /^return\b/.test(s.text)) return s; const r = containsReturn(s.body); if (r) return r; } return null; };

/** SmartPy: `return` only as the last statement of a view (or of both branches of a final if/else); entrypoints have no return at all */
export function lintReturns(body: string, h: HandlerD): LintIssue[] {
  const out: LintIssue[] = [];
  const lines = body.split('\n');
  const tree = parseBlocks(lines);
  if (h.kind !== 'view') {
    for (const [i, l] of lines.entries()) if (/^\s*return\b/.test(mask(l)) && !/^\s*return\s+\S/.test(mask(l))) out.push({ line: i + 1, rule: 'bare-return', message: 'no `return` in an entrypoint or initialize (SmartPy rejects it): to skip the rest, put the remaining statements in the `else:` of an `if`' });
    return out;
  }
  // every return must be terminal: the body ends with a return, or an if/else whose branches (recursively) end with one; nothing else may contain a return
  const last = tree[tree.length - 1];
  const terminal = new Set<Stmt>();
  const collect = (stmts: Stmt[]) => { const l = stmts[stmts.length - 1]; if (!l) return; if (l.kind === 'simple') terminal.add(l); else if (l.kind === 'else') { const ifs = [...stmts].reverse().find((x) => x.kind === 'if'); if (ifs) collect(ifs.body); collect(l.body); } };
  collect(tree);
  const walk = (stmts: Stmt[]) => { for (const s of stmts) { if (s.kind === 'simple' && /^return\b/.test(s.text) && !terminal.has(s)) out.push({ line: s.line, rule: 'early-return', message: 'SmartPy has no early return: `return` must be the LAST statement of the view (or the last statement of BOTH branches of a final if/else). Declare a local before the if (`t = 0`), assign it in the branches, and `return t` at the end' }); walk(s.body); } };
  walk(tree);
  if (last && !endsOk(tree)) out.push({ line: Math.max(last.line, 1), rule: 'view-return', message: 'a view must END with `return value` (or an if/else whose both branches end with a return)' });
  void containsReturn;
  return out;
}

const PY_BUILTIN = new Set(['sp', 'self', 'True', 'False', 'None', 'and', 'or', 'not', 'if', 'else', 'for', 'while', 'in', 'is', 'assert', 'raise', 'return', 'pass', 'del', 'range', 'len', 'abs', 'min', 'max', 'sum', 'del', 'ZERO_ADDRESS', 'MAX_UINT256', 'u256', 'pow_nat', 'string_utils']);

/** a variable first assigned inside an if/else/for block is not visible after it (SmartPy 0.25.3): report reads of such variables */
export function lintScopes(body: string, h: HandlerD, d: TezosDesign): LintIssue[] {
  const out: LintIssue[] = [];
  const lines = body.split('\n');
  const known = new Set<string>([...h.args.map((a) => a.name), ...PY_BUILTIN, ...d.structs.map((s) => s.name), ...d.structs.map((s) => `${s.name}_ZERO`)]);
  const assignedAnywhere = new Set<string>();
  for (const raw of lines) { const m = /^\s*(?:\(([\w, ]+)\)|([A-Za-z_]\w*))\s*(?:[-+*/%]?=)(?!=)/.exec(mask(raw)); if (m) for (const n of (m[1] ?? m[2]!).split(',').map((x) => x.trim())) assignedAnywhere.add(n); const f = /^\s*for\s+(\w+)\s+in\b/.exec(mask(raw)); if (f) assignedAnywhere.add(f[1]!); }
  const scopes: { indent: number; names: Set<string> }[] = [{ indent: -1, names: new Set() }];
  const reported = new Set<string>();
  lines.forEach((raw, i) => {
    const m = mask(raw);
    if (!m.trim()) return;
    const indent = indentOf(raw);
    while (scopes.length > 1 && indent <= scopes[scopes.length - 1]!.indent) scopes.pop();
    // a new block opened by the previous statement: lines more indented than the top scope's statement
    const prev = lines.slice(0, i).reverse().find((x) => mask(x).trim());
    if (prev && /:\s*$/.test(mask(prev)) && indent > indentOf(prev)) scopes.push({ indent: indentOf(prev), names: new Set(/^\s*for\s+\(?([\w, ]+?)\)?\s+in\b/.exec(mask(prev))?.[1]?.split(',').map((x) => x.trim()) ?? []) });
    const visible = (n: string) => scopes.some((s) => s.names.has(n)) || known.has(n);
    const body2 = m.replace(/^\s*(for\s+\w+\s+in)/, 'for _ in').replace(/^\s*(\(?[\w, ]+\)?\s*)(?:[-+*/%]?=)(?!=)/, (x) => x.replace(/[A-Za-z_]\w*/g, ' '));
    for (const id of body2.matchAll(/(?<![.\w])([A-Za-z_]\w*)\b(?!\s*=(?!=))/g)) {
      const n = id[1]!;
      if (!assignedAnywhere.has(n) || visible(n) || reported.has(n)) continue;
      const afterColon = /^\s*(if|else|for|while)\b/.test(m) && false;
      if (afterColon) continue;
      reported.add(n);
      out.push({ line: i + 1, rule: 'branch-scope', message: `\`${n}\` is used here but was first assigned inside an if/else/for block: SmartPy does not keep such a variable after the block. Declare it BEFORE the block (e.g. \`${n} = 0\`) and assign it inside the branches` });
    }
    const t = /^\s*(?:\(([\w, ]+)\)|([A-Za-z_]\w*))\s*(?:[-+*/%]?=)(?!=)/.exec(m);
    if (t) for (const n of (t[1] ?? t[2]!).split(',').map((x) => x.trim())) scopes[scopes.length - 1]!.names.add(n);
  });
  return out;
}

export function formatIssues(unit: string, issues: LintIssue[]): string {
  return issues.map((i) => `${unit}:${i.line}: lint[${i.rule}] ${i.message}`).join('\n');
}
