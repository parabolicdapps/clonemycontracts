/**
 * Guard-taint analysis (fail-closed, first line of defence).
 *
 * One fixed-point pass over the WHOLE call graph (public / internal / private functions, modifiers, inherited bases, library members reached
 * through `using L for T`). Sources: signature verification (ecrecover, isValidSignature*, recover, tryRecover, checkSignatures, a staticcall,
 * anything that reaches them) and calls to other contracts whose answer the target cannot reproduce (not token operations, not notifications).
 * A source taints its result; a local or state variable assigned from a tainted value is tainted; a function whose return value is tainted
 * taints its call sites. A condition (`if`, `require`, `assert`, `?:`) that reads a tainted value is a GUARD: the enclosing function, and every
 * function that calls it on its path (helper, modifier, inherited function), must be fail-closed. The error-code return pattern
 * (`uint allowed = comptroller.mintAllowed(); if (allowed != 0) return fail(...)`) is the same thing.
 *
 * Local guards are never sources: Ownable, local role mappings, Pausable, ReentrancyGuard read only local state. Token operations, receiver
 * notifications and the audited OpenZeppelin helper libraries (SafeERC20, Address, SafeMath, ...) are not sources either.
 */

export interface GuardTaint { why: string; kind: 'signature' | 'external'; /** the guard sits in the true branch of `if (<bool state variable>)` */ underFlag?: string }

const TOKEN_METHOD = /^(transfer|transferFrom|safeTransfer|safeTransferFrom|safeIncreaseAllowance|safeDecreaseAllowance|forceApprove|approve|safeApprove|balanceOf|allowance|totalSupply|decimals|name|symbol|ownerOf|getApproved|isApprovedForAll|supportsInterface|onERC721Received|onERC1155Received|onERC1155BatchReceived|tokenURI|uri)$/;
const SIG_METHOD = /^(isValidSignature\w*|recover|tryRecover\w*|checkSignatures|checkNSignatures|verify\w*Signature\w*|isValidSignatureNow)$/;
const TRUSTED_LIB = /^(SafeERC20\w*|Address\w*|SafeMath\w*|SignedSafeMath|SafeCast|StorageSlot\w*|Strings|Create2\w*|Clones\w*|Math|SignedMath|Counters\w*|EnumerableSet\w*|EnumerableMap\w*|BitMaps|ReentrancyGuard\w*|Initializable|ContextUpgradeable|Context|ERC165\w*|SafeTransferLib|FixedPointMathLib)$/;

interface Info { def: any; own: GuardTaint[]; callees: number[]; retTainted: boolean; isSig: boolean; direct: boolean }

export function analyseGuardTaint(ctx: { declById: Map<number, any>; declContract: Map<number, string>; stateVarIds: Map<number, string>; chain: any[]; text(n: any): string }): Map<number, GuardTaint[]> {
  const defs: any[] = [];
  for (const d of ctx.declById.values()) {
    if (d.nodeType !== 'ContractDefinition') continue;
    if (TRUSTED_LIB.test(d.name ?? '')) continue;
    for (const n of d.nodes ?? []) if ((n.nodeType === 'FunctionDefinition' || n.nodeType === 'ModifierDefinition') && n.body) defs.push(n);
  }
  const infos = new Map<number, Info>();
  for (const d of defs) infos.set(d.id, { def: d, own: [], callees: [], retTainted: false, isSig: false, direct: false });
  const taintedState = new Set<number>();
  const contractOf = (id: number) => ctx.declContract.get(id) ?? '';

  /** the most derived definition of an internally called function (virtual dispatch within the linearised chain) */
  const resolve = (decl: any): any => {
    if (!decl || decl.nodeType !== 'FunctionDefinition') return decl;
    const owner = contractOf(decl.id);
    if (!ctx.chain.some((b) => b.name === owner)) return decl;
    for (const b of ctx.chain) for (const n of b.nodes ?? []) if (n.nodeType === 'FunctionDefinition' && n.name === decl.name && n.kind === decl.kind && (n.parameters?.parameters?.length ?? 0) === (decl.parameters?.parameters?.length ?? 0) && n.body) return n;
    return decl;
  };

  const children = (n: any): any[] => {
    const out: any[] = [];
    for (const k of Object.keys(n)) {
      if (k === 'typeDescriptions' || k === 'src') continue;
      const v = n[k];
      if (Array.isArray(v)) { for (const x of v) if (x && typeof x === 'object') out.push(x); } else if (v && typeof v === 'object' && v.nodeType) out.push(v);
    }
    return out;
  };

  const rootDecl = (e: any): number | null => {
    let cur = e;
    for (let i = 0; i < 20 && cur; i++) {
      if (cur.nodeType === 'Identifier') return cur.referencedDeclaration ?? null;
      if (cur.nodeType === 'IndexAccess') cur = cur.baseExpression; else if (cur.nodeType === 'MemberAccess') cur = cur.expression; else if (cur.nodeType === 'TupleExpression') cur = cur.components?.[0]; else return null;
    }
    return null;
  };

  /** the call `n` is a taint source; returns its kind or null */
  const sourceOf = (n: any, info: Info): 'signature' | 'external' | null => {
    if (n.nodeType !== 'FunctionCall' || n.kind === 'typeConversion' || n.kind === 'structConstructorCall') return null;
    const c = n.expression?.nodeType === 'FunctionCallOptions' ? n.expression.expression : n.expression;
    if (!c) return null;
    if (c.nodeType === 'Identifier') {
      if (c.name === 'ecrecover') return 'signature';
      const d = resolve(ctx.declById.get(c.referencedDeclaration));
      const i = d && infos.get(d.id);
      if (i) { if (!info.callees.includes(d.id)) info.callees.push(d.id); if (i.isSig) return 'signature'; if (i.retTainted) return 'external'; }
      return null;
    }
    if (c.nodeType !== 'MemberAccess') return null;
    const m: string = c.memberName;
    if (SIG_METHOD.test(m)) return 'signature';
    const decl = ctx.declById.get(c.referencedDeclaration);
    const recvT: string = c.expression?.typeDescriptions?.typeString ?? '';
    if (decl?.nodeType === 'FunctionDefinition') {
      const rd = resolve(decl);
      const cname = contractOf(rd.id);
      if (TRUSTED_LIB.test(cname)) return null;
      const ownerDef = [...ctx.declById.values()].find((x) => x.nodeType === 'ContractDefinition' && (x.nodes ?? []).some((q: any) => q.id === rd.id));
      if (ownerDef?.contractKind === 'interface' || rd.implemented === false) {
        // a call to another contract through its interface
        if (recvT.startsWith('contract ') && c.expression?.name !== 'this' && c.expression?.name !== 'super' && !TOKEN_METHOD.test(m)) return 'external';
        return null;
      }
      const i = infos.get(rd.id);
      if (i) { if (!info.callees.includes(rd.id)) info.callees.push(rd.id); if (i.isSig) return 'signature'; if (i.retTainted) return 'external'; }
      return null;
    }
    if (m === 'staticcall' && recvT.startsWith('address')) return 'signature';
    if (recvT.startsWith('contract ') && c.expression?.name !== 'this' && c.expression?.name !== 'super' && !TOKEN_METHOD.test(m)) return 'external';
    return null;
  };

  let changed = true;
  const pass = (info: Info, locals: Set<number>) => {
    const d = info.def;
    const tainted = (e: any): boolean => {
      let hit = false;
      const go = (n: any): void => {
        if (hit || !n || typeof n !== 'object') return;
        if (n.nodeType === 'Identifier' && (locals.has(n.referencedDeclaration) || taintedState.has(n.referencedDeclaration))) { hit = true; return; }
        if (n.nodeType === 'FunctionCall' && sourceOf(n, info)) { hit = true; return; }
        for (const c of children(n)) go(c);
      };
      go(e);
      return hit;
    };
    const gate = (cond: any, what: string, flag?: string) => {
      if (!cond || !tainted(cond)) return;
      let kind = 'external' as 'signature' | 'external';
      const scan = (n: any): void => { if (!n || typeof n !== 'object') return; if (n.nodeType === 'FunctionCall' && sourceOf(n, info) === 'signature') kind = 'signature'; for (const c of children(n)) scan(c); };
      scan(cond);
      const why = `${what} \`${ctx.text(cond).slice(0, 90)}\` reads a value that comes from ${kind === 'signature' ? 'signature verification' : 'another contract'}`;
      if (!info.own.some((x) => x.why === why)) { info.own.push({ why, kind, ...(flag ? { underFlag: flag } : {}) }); changed = true; }
    };
    const visit = (n: any, flag: string | undefined): void => {
      if (!n || typeof n !== 'object') return;
      switch (n.nodeType) {
        case 'VariableDeclarationStatement':
          if (n.initialValue && tainted(n.initialValue)) for (const dd of n.declarations ?? []) if (dd && !locals.has(dd.id)) { locals.add(dd.id); changed = true; }
          break;
        case 'Assignment': {
          if (tainted(n.rightHandSide)) {
            const r = rootDecl(n.leftHandSide);
            if (r != null) { if (ctx.stateVarIds.has(r)) { if (!taintedState.has(r)) { taintedState.add(r); changed = true; } } else if (!locals.has(r)) { locals.add(r); changed = true; } }
          }
          break;
        }
        case 'IfStatement': {
          gate(n.condition, 'condition', flag);
          const c = n.condition;
          const f = c?.nodeType === 'Identifier' && ctx.stateVarIds.has(c.referencedDeclaration) && c.typeDescriptions?.typeString === 'bool' ? c.name : undefined;
          visit(n.condition, flag); visit(n.trueBody, f ?? flag); visit(n.falseBody, flag);
          return;
        }
        case 'Conditional': gate(n.condition, 'condition', flag); break;
        case 'FunctionCall': {
          const c = n.expression;
          if (c?.nodeType === 'Identifier' && (c.name === 'require' || c.name === 'assert') && n.arguments?.[0]) gate(n.arguments[0], c.name, flag);
          const s = sourceOf(n, info);
          if (s === 'signature' && !info.isSig) { info.isSig = true; changed = true; }
          if (s && !info.direct) info.direct = true;
          break;
        }
        case 'Return':
          if (n.expression && tainted(n.expression) && !info.retTainted) { info.retTainted = true; changed = true; }
          break;
        default: break;
      }
      for (const c of children(n)) visit(c, flag);
    };
    visit(d.body, undefined);
    for (const p of d.returnParameters?.parameters ?? []) if (locals.has(p.id) && !info.retTainted) { info.retTainted = true; changed = true; }
    // modifiers invoked on the function are on its path
    for (const m of d.modifiers ?? []) {
      const md = ctx.declById.get(m.modifierName?.referencedDeclaration);
      if (md && infos.has(md.id) && !info.callees.includes(md.id)) { info.callees.push(md.id); changed = true; }
      for (const a of m.arguments ?? []) visit(a, undefined);
    }
    for (const cid of info.callees) { const ci = infos.get(cid); if (ci?.isSig && !info.isSig) { info.isSig = true; changed = true; } }
  };

  const localsOf = new Map<number, Set<number>>();
  for (const i of infos.values()) localsOf.set(i.def.id, new Set());
  for (let iter = 0; changed && iter < 30; iter++) {
    changed = false;
    for (const i of infos.values()) pass(i, localsOf.get(i.def.id)!);
  }

  // transitive reasons: own guards plus those of every callee on the path (helpers, modifiers, inherited functions)
  const memo = new Map<number, GuardTaint[]>();
  const reasons = (id: number, seen: Set<number>): GuardTaint[] => {
    if (memo.has(id)) return memo.get(id)!;
    if (seen.has(id)) return [];
    seen.add(id);
    const i = infos.get(id);
    if (!i) return [];
    const out = [...i.own];
    for (const c of i.callees) for (const r of reasons(c, seen)) { const via = `via \`${infos.get(c)?.def.name ?? ''}\`: ${r.why}`; out.push({ ...r, why: r.why.startsWith('via ') ? r.why : via }); }
    if (i.isSig && !out.some((x) => x.kind === 'signature')) out.push({ why: 'verifies a signature', kind: 'signature' });
    memo.set(id, out);
    return out;
  };
  const result = new Map<number, GuardTaint[]>();
  for (const i of infos.values()) { const r = reasons(i.def.id, new Set()); if (r.length) result.set(i.def.id, r); }
  return result;
}
