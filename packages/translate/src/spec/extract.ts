import { detectTokenStandards } from '@cmc/core';
import type {
  AccessControlInfo, ProxyInfoSpec, ContractSpec, ErrorSpec, EventSpec, ExternalCall, FunctionSpec, KeySource, MappingAccess, NonPortableFeature, ParamSpec,
  Requirement, SourceRange, StateVarSpec, StructSpec, TypeRef, EnumSpec,
} from '../types.js';
import type { AstCompile } from './compile.js';
import { evalInitial } from './constant.js';
import { classifyExcluded } from './standard.js';
import { analyseGuardTaint } from './taint.js';
import { overloadKey } from './overloads.js';

// ------------------------------------------------------------------ types

/** user-defined value types of the contract being extracted: name -> underlying type string */
const UDVT = new Map<string, string>();

export function parseType(ts: string): TypeRef {
  let s = ts.trim().replace(/ (memory|calldata|storage ref|storage pointer|storage|payable)$/g, '').trim();
  s = s.replace(/ (memory|calldata|storage ref|storage pointer)$/g, '');
  if (s.startsWith('mapping(')) {
    const inner = s.slice(8, s.lastIndexOf(')'));
    let depth = 0, at = -1;
    for (let i = 0; i < inner.length - 1; i++) {
      const ch = inner[i];
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      else if (depth === 0 && inner.startsWith('=>', i)) { at = i; break; }
    }
    return { solidity: s, kind: 'mapping', key: parseType(inner.slice(0, at)), value: parseType(inner.slice(at + 2)) };
  }
  const arr = /^(.*)\[(\d*)\]$/.exec(s);
  if (arr) return { solidity: s, kind: 'array', element: parseType(arr[1]!), ...(arr[2] ? { length: Number(arr[2]) } : {}) };
  let m = /^uint(\d*)$/.exec(s);
  if (m) return { solidity: s === 'uint' ? 'uint256' : s, kind: 'uint', bits: m[1] ? Number(m[1]) : 256 };
  m = /^int(\d*)$/.exec(s);
  if (m) return { solidity: s === 'int' ? 'int256' : s, kind: 'int', bits: m[1] ? Number(m[1]) : 256 };
  if (s === 'bool') return { solidity: s, kind: 'bool' };
  if (s === 'address') return { solidity: s, kind: 'address' };
  if (s === 'string') return { solidity: s, kind: 'string' };
  if (s === 'bytes') return { solidity: s, kind: 'bytes' };
  m = /^bytes(\d+)$/.exec(s);
  if (m) return { solidity: s, kind: 'fixedbytes', bits: Number(m[1]) * 8 };
  m = /^contract (\S+)$/.exec(s);
  if (m) return { solidity: s, kind: 'contract', name: m[1]!.split('.').pop()! };
  m = /^struct (\S+)$/.exec(s);
  if (m) return { solidity: s, kind: 'struct', name: m[1]!.split('.').pop()! };
  m = /^enum (\S+)$/.exec(s);
  if (m) return { solidity: s, kind: 'enum', name: m[1]!.split('.').pop()! };
  // user-defined value types (`type ShortString is bytes32`) behave as their underlying type
  const under = UDVT.get(s.split('.').pop()!);
  if (under && under !== s) { const u = parseType(under); return { ...u, solidity: s }; }
  return { solidity: s, kind: 'other' };
}

const typeOfDecl = (d: any): TypeRef => parseType(d.typeDescriptions?.typeString ?? d.typeName?.typeDescriptions?.typeString ?? 'unknown');

// ------------------------------------------------------------------ walking

function walk(node: any, fn: (n: any) => boolean | void): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const x of node) walk(x, fn); return; }
  if (node.nodeType) { if (fn(node) === false) return; }
  for (const k of Object.keys(node)) {
    if (k === 'typeDescriptions' || k === 'src') continue;
    const v = node[k];
    if (v && typeof v === 'object') walk(v, fn);
  }
}

interface Effects {
  reads: Set<string>; writes: Set<string>; events: Set<string>; calls: Set<string>; ext: ExternalCall[]; reqs: Requirement[]; maps: MappingAccess[];
  features: Set<string>; timestamp: boolean;
}
const newEffects = (): Effects => ({ reads: new Set(), writes: new Set(), events: new Set(), calls: new Set(), ext: [], reqs: [], maps: [], features: new Set(), timestamp: false });
function merge(into: Effects, from: Effects) {
  for (const k of ['reads', 'writes', 'events', 'calls', 'features'] as const) for (const x of from[k]) into[k].add(x);
  into.ext.push(...from.ext); into.reqs.push(...from.reqs); into.maps.push(...from.maps);
  if (from.timestamp) into.timestamp = true;
}

class Ctx {
  byteSrc = new Map<string, Buffer>();
  fileById = new Map<number, string>();
  declById = new Map<number, any>();
  declContract = new Map<number, string>();
  stateVarIds = new Map<number, string>();
  memo = new Map<string, Effects>();
  busy = new Set<string>();
  chain: any[] = []; // linearized, most derived first
  constructor(public c: AstCompile) {
    for (const [f, id] of Object.entries(c.ids)) { this.fileById.set(id, f); this.byteSrc.set(f, Buffer.from(c.sources[f] ?? '', 'utf8')); }
  }
  text(node: any): string {
    const [s, l, id] = String(node.src).split(':').map(Number) as [number, number, number];
    const b = this.byteSrc.get(this.fileById.get(id) ?? '');
    return b ? b.subarray(s, s + l).toString('utf8').replace(/\s+/g, ' ').trim() : '';
  }
  range(node: any): SourceRange {
    const [s, l, id] = String(node.src).split(':').map(Number) as [number, number, number];
    const file = this.fileById.get(id) ?? '';
    const b = this.byteSrc.get(file) ?? Buffer.alloc(0);
    const count = (end: number) => { let n = 1; for (let i = 0; i < Math.min(end, b.length); i++) if (b[i] === 10) n++; return n; };
    return { file, start: s, length: l, line: count(s), endLine: count(s + l) };
  }
  contractOfFn(def: any): string { return this.declContract.get(def.id) ?? ''; }
}

const ERC20_METHODS = new Set(['transfer', 'transferFrom', 'balanceOf', 'approve', 'allowance', 'totalSupply', 'safeTransfer', 'safeTransferFrom', 'safeApprove', 'safeIncreaseAllowance', 'decimals', 'mint', 'burn', 'burnFrom', 'forceApprove']);

function rootOf(e: any, alias: Map<number, string>, ctx: Ctx): string | null {
  let cur = e;
  for (let i = 0; i < 20 && cur; i++) {
    switch (cur.nodeType) {
      case 'Identifier': {
        const sv = ctx.stateVarIds.get(cur.referencedDeclaration);
        if (sv) return sv;
        return alias.get(cur.referencedDeclaration) ?? null;
      }
      case 'IndexAccess': cur = cur.baseExpression; break;
      case 'MemberAccess': cur = cur.expression; break;
      case 'TupleExpression': cur = cur.components?.[0]; break;
      default: return null;
    }
  }
  return null;
}

type Binding = Map<string, KeySource>;
function keySource(e: any, params: Set<string>, ctx: Ctx, binding: Binding): KeySource {
  if (e.nodeType === 'MemberAccess' && e.expression?.name === 'msg' && e.memberName === 'sender') return { kind: 'msg.sender' };
  if (e.nodeType === 'FunctionCall' && e.kind === 'typeConversion' && e.arguments?.[0]) return keySource(e.arguments[0], params, ctx, binding);
  if (e.nodeType === 'FunctionCall' && e.expression?.nodeType === 'Identifier' && e.expression.name === '_msgSender' && !(e.arguments ?? []).length) return { kind: 'msg.sender' };
  if (e.nodeType === 'Identifier' && e.name === 'this') return { kind: 'this' };
  if (e.nodeType === 'Identifier') {
    const b = binding.get(e.name);
    if (b) return b;
    if (params.has(e.name) ) return { kind: 'param', name: e.name };
    const sv = ctx.stateVarIds.get(e.referencedDeclaration);
    if (sv) return { kind: 'statevar', name: sv };
  }
  if (e.nodeType === 'Literal') return { kind: 'literal', text: e.value };
  return { kind: 'expr', text: ctx.text(e) };
}

function analyseBody(body: any, params: Set<string>, ctx: Ctx, binding: Binding, modifierName?: string, internalDef = false): Effects {
  const eff = newEffects();
  const alias = new Map<number, string>();
  // locals initialised with the caller (`address owner = _msgSender();`) are the caller wherever they are used as a key or passed on
  binding = new Map(binding);
  walk(body, (n) => {
    if (n.nodeType === 'VariableDeclarationStatement' && n.initialValue && n.declarations?.length === 1 && n.declarations[0]?.name) {
      const k = keySource(n.initialValue, params, ctx, binding);
      if (k.kind === 'msg.sender') binding.set(n.declarations[0].name, k);
    }
  });
  // storage-pointer locals: `Tx storage t = txs[i]` -> t aliases state var txs
  walk(body, (n) => {
    if (n.nodeType === 'VariableDeclarationStatement' && n.initialValue && n.declarations?.[0]?.storageLocation === 'storage') {
      const root = rootOf(n.initialValue, alias, ctx);
      if (root && n.declarations[0]?.id != null) alias.set(n.declarations[0].id, root);
    }
  });
  const mapAccesses = new Set<any>();
  const innerIdx = new Set<any>();
  const lvalueRoots = new Set<any>();
  const addMapAccess = (e: any, write: boolean) => {
    // collect keys from outermost IndexAccess chain
    const keys: KeySource[] = [];
    let cur = e;
    while (cur && cur.nodeType === 'IndexAccess') { keys.unshift(keySource(cur.indexExpression, params, ctx, binding)); cur = cur.baseExpression; }
    const root = cur && cur.nodeType === 'Identifier' ? ctx.stateVarIds.get(cur.referencedDeclaration) ?? alias.get(cur.referencedDeclaration) : null;
    if (root) eff.maps.push({ variable: root, keys, write });
  };
  // calls whose result decides something, and calls under `if (flag)` of a bool state variable
  const inCond = new Set<number>(); const underFlag = new Map<number, string>();
  const mark = (x: any) => walk(x, (m) => { if (m.nodeType === 'FunctionCall') inCond.add(m.id); });
  walk(body, (n) => {
    if (n.nodeType === 'FunctionCall' && n.expression?.nodeType === 'Identifier' && (n.expression.name === 'require' || n.expression.name === 'assert') && n.arguments?.[0]) mark(n.arguments[0]);
    if (n.nodeType === 'IfStatement') {
      mark(n.condition);
      const c = n.condition;
      if (c?.nodeType === 'Identifier' && ctx.stateVarIds.get(c.referencedDeclaration) && c.typeDescriptions?.typeString === 'bool') walk(n.trueBody, (m) => { if (m.nodeType === 'FunctionCall') underFlag.set(m.id, c.name); });
    }
    if (n.nodeType === 'Return' && internalDef && n.expression) mark(n.expression);
  });
  walk(body, (n) => {
    switch (n.nodeType) {
      case 'Assignment': {
        const r = rootOf(n.leftHandSide, alias, ctx);
        if (r) { eff.writes.add(r); if (n.operator !== '=') eff.reads.add(r); }
        lvalueRoots.add(n.leftHandSide);
        if (n.leftHandSide.nodeType === 'IndexAccess') { addMapAccess(n.leftHandSide, true); mapAccesses.add(n.leftHandSide); if (n.leftHandSide.baseExpression?.nodeType === 'IndexAccess') innerIdx.add(n.leftHandSide.baseExpression); }
        break;
      }
      case 'UnaryOperation':
        if (['++', '--', 'delete'].includes(n.operator)) {
          const r = rootOf(n.subExpression, alias, ctx);
          if (r) { eff.writes.add(r); eff.reads.add(r); }
          if (n.subExpression.nodeType === 'IndexAccess') { addMapAccess(n.subExpression, true); mapAccesses.add(n.subExpression); if (n.subExpression.baseExpression?.nodeType === 'IndexAccess') innerIdx.add(n.subExpression.baseExpression); }
        }
        break;
      case 'IndexAccess':
        if (n.baseExpression?.nodeType === 'IndexAccess') innerIdx.add(n.baseExpression);
        if (!mapAccesses.has(n) && !innerIdx.has(n)) { addMapAccess(n, false); }
        break;
      case 'Identifier': {
        const sv = ctx.stateVarIds.get(n.referencedDeclaration);
        if (sv) eff.reads.add(sv);
        if (n.name === 'selfdestruct' || n.name === 'suicide') eff.features.add('selfdestruct');
        if (n.name === 'now' && !sv && !ctx.declById.has(n.referencedDeclaration)) eff.timestamp = true; // pre-0.7 alias of block.timestamp
        if (n.name === 'ecrecover') eff.features.add('signatures');
        if (n.name === 'blockhash' || n.name === 'gasleft') eff.features.add('block-context');
        break;
      }
      case 'InlineAssembly': eff.features.add('assembly'); break;
      case 'NewExpression': if (n.typeName?.nodeType === 'UserDefinedTypeName') eff.features.add('contract-creation'); break;
      case 'MemberAccess': {
        if (n.memberName === 'max' && /^type\(u?int/.test(ctx.text(n.expression ?? {}))) eff.features.add('max-uint');
        const base = n.expression?.name;
        if (base === 'tx' && n.memberName === 'origin') eff.features.add('tx.origin');
        if (base === 'block') {
          if (n.memberName === 'timestamp') eff.timestamp = true;
          else eff.features.add(`block.${n.memberName}`);
        }
        if (base === 'msg' && n.memberName === 'value') eff.features.add('native-value');
        if (base === 'msg' && n.memberName === 'data') eff.features.add('msg.data');
        if (n.memberName === 'delegatecall') eff.features.add('delegatecall');
        if (['encodePacked', 'encode', 'encodeWithSelector', 'encodeWithSignature'].includes(n.memberName) && base === 'abi') eff.features.add('abi-encoding');
        if (n.memberName === 'balance' && n.expression?.typeDescriptions?.typeString?.startsWith('address')) eff.features.add('native-value');
        break;
      }
      case 'EmitStatement': {
        const callee = n.eventCall?.expression;
        const name = callee?.name ?? callee?.memberName;
        if (name) eff.events.add(name);
        break;
      }
      case 'Throw': {
        eff.reqs.push({ kind: 'revert', condition: 'always', message: 'throw', range: ctx.range(n), ...(modifierName ? { fromModifier: modifierName } : {}) });
        break;
      }
      case 'RevertStatement': {
        eff.reqs.push({ kind: 'revert', condition: 'always (custom error)', message: ctx.text(n.errorCall?.expression ?? n), range: ctx.range(n), ...(modifierName ? { fromModifier: modifierName } : {}) });
        break;
      }
      case 'IfStatement': {
        const t = n.trueBody;
        const stmts = t?.nodeType === 'Block' ? t.statements : t ? [t] : [];
        const first = stmts[0];
        const isRevert = first && (first.nodeType === 'RevertStatement' || first.nodeType === 'Throw' || (first.nodeType === 'ExpressionStatement' && first.expression?.nodeType === 'FunctionCall' && first.expression.expression?.name === 'revert'));
        if (isRevert && stmts.length === 1) eff.reqs.push({ kind: 'if-revert', condition: ctx.text(n.condition), message: ctx.text(first), range: ctx.range(n), ...(modifierName ? { fromModifier: modifierName } : {}) });
        break;
      }
      case 'FunctionCall': {
        const callee = n.expression;
        if (n.kind === 'typeConversion' && /^uint/.test(n.typeDescriptions?.typeString ?? '') && n.arguments?.[0]?.nodeType === 'UnaryOperation' && n.arguments[0].operator === '-' && n.arguments[0].subExpression?.value === '1') eff.features.add('max-uint');
        if (n.kind === 'functionCall') {
          if (callee.nodeType === 'Identifier' && (callee.name === 'require' || callee.name === 'assert')) {
            const msg = n.arguments?.[1];
            eff.reqs.push({ kind: callee.name, condition: ctx.text(n.arguments[0]), ...(msg?.nodeType === 'Literal' ? { message: msg.value } : msg ? { message: ctx.text(msg) } : {}), range: ctx.range(n), ...(modifierName ? { fromModifier: modifierName } : {}) });
          } else if (callee.nodeType === 'Identifier' && callee.name === 'revert') {
            const m = n.arguments?.[0];
            eff.reqs.push({ kind: 'revert', condition: 'always', ...(m?.nodeType === 'Literal' ? { message: m.value } : {}), range: ctx.range(n), ...(modifierName ? { fromModifier: modifierName } : {}) });
          } else if (callee.nodeType === 'Identifier' && ctx.declById.get(callee.referencedDeclaration)?.nodeType === 'FunctionDefinition') {
            const def = ctx.declById.get(callee.referencedDeclaration);
            eff.calls.add(def.name);
            const target = resolveOverride(def, ctx);
            const nb: Binding = new Map();
            (target.parameters?.parameters ?? []).forEach((p: any, i: number) => { if (n.arguments?.[i]) nb.set(p.name, keySource(n.arguments[i], params, ctx, binding)); });
            merge(eff, analyseFunction(target, ctx, nb));
          } else if (callee.nodeType === 'MemberAccess' && ctx.declById.get(callee.referencedDeclaration)?.nodeType === 'FunctionDefinition' && (callee.expression?.name === 'super' || ctx.declById.get(callee.expression?.referencedDeclaration)?.nodeType === 'ContractDefinition')) {
            // super.f(...) / Base.f(...): the base implementation runs, with its events, requires and state accesses (also on 0.4.x)
            const def = ctx.declById.get(callee.referencedDeclaration);
            eff.calls.add(def.name);
            const nb: Binding = new Map();
            (def.parameters?.parameters ?? []).forEach((p: any, i: number) => { if (n.arguments?.[i]) nb.set(p.name, keySource(n.arguments[i], params, ctx, binding)); });
            merge(eff, analyseFunction(def, ctx, nb));
          } else {
            const c = callee.nodeType === 'FunctionCallOptions' ? callee.expression : callee;
            const sendsValue = callee.nodeType === 'FunctionCallOptions' && (callee.names ?? []).includes('value');
            if (c.nodeType === 'MemberAccess') {
              const recvT: string = c.expression?.typeDescriptions?.typeString ?? '';
              const low = ['call', 'delegatecall', 'staticcall', 'send', 'transfer'].includes(c.memberName) && recvT.startsWith('address');
              if (low) {
                eff.ext.push({ target: ctx.text(c.expression), method: c.memberName, sendsValue: sendsValue || c.memberName === 'send' || c.memberName === 'transfer', low: true, args: (n.arguments ?? []).map((a: any) => keySource(a, params, ctx, binding)) });
                if (c.memberName !== 'delegatecall' && (sendsValue || ['send', 'transfer'].includes(c.memberName))) eff.features.add('native-value');
                if (c.memberName === 'call' || c.memberName === 'staticcall') eff.features.add('low-level-call');
              } else if (recvT.startsWith('contract ') && c.expression?.name !== 'this' && c.expression?.name !== 'super') {
                { const decl = ctx.declById.get(c.referencedDeclaration); const voidView = decl?.nodeType === 'FunctionDefinition' && (decl.stateMutability === 'view' || decl.stateMutability === 'pure') && (decl.returnParameters?.parameters?.length ?? 0) === 0;
                  eff.ext.push({ target: ctx.text(c.expression), method: c.memberName, targetType: recvT.slice(9), sendsValue, low: false, ...(voidView ? { voidView: true } : {}), ...(inCond.has(n.id) ? { inCondition: true } : {}), ...(underFlag.has(n.id) ? { underFlag: underFlag.get(n.id)! } : {}), args: (n.arguments ?? []).map((a: any) => keySource(a, params, ctx, binding)) }); }
              }
              if (c.memberName === 'recover' || /^ECDSA|SignatureChecker/.test(ctx.text(c.expression))) eff.features.add('signatures');
            }
          }
        }
        // push/pop on state arrays count as writes
        if (callee.nodeType === 'MemberAccess' && ['push', 'pop'].includes(callee.memberName)) {
          const r = rootOf(callee.expression, alias, ctx);
          if (r) { eff.writes.add(r); eff.reads.add(r); }
        }
        break;
      }
    }
  });
  return eff;
}

function resolveOverride(def: any, ctx: Ctx): any {
  for (const c of ctx.chain) {
    for (const n of c.nodes) {
      if (n.nodeType === 'FunctionDefinition' && n.kind === def.kind && n.name === def.name && n.parameters.parameters.length === def.parameters.parameters.length && n.implemented) return n;
    }
  }
  return def;
}

function analyseFunction(def: any, ctx: Ctx, binding: Binding = new Map()): Effects {
  const key = `${def.id}:${JSON.stringify([...binding.entries()])}`;
  const hit = ctx.memo.get(key);
  if (hit) return hit;
  if (ctx.busy.has(key)) return newEffects();
  ctx.busy.add(key);
  const eff = newEffects();
  const params = new Set<string>((def.parameters?.parameters ?? []).map((p: any) => p.name));
  if (def.body) merge(eff, analyseBody(def.body, params, ctx, binding, undefined, def.visibility === 'internal' || def.visibility === 'private'));
  for (const m of def.modifiers ?? []) {
    const md = ctx.declById.get(m.modifierName?.referencedDeclaration);
    if (md?.nodeType === 'ModifierDefinition' && md.body) {
      const mb: Binding = new Map();
      md.parameters.parameters.forEach((p: any, i: number) => { if (m.arguments?.[i]) mb.set(p.name, keySource(m.arguments[i], params, ctx, binding)); });
      const me = analyseBody(md.body, new Set<string>(), ctx, mb, md.name);
      // modifier params are bound to the invocation arguments: map `account` -> actual expression text for key sources
      for (const e of me.ext) if (!e.fromModifier) e.fromModifier = md.name;
      // `onlyPayloadSize`: a calldata length check against short-address padding; typed arguments make it meaningless here, it is not "raw calldata"
      if (me.features.has('msg.data') && !ctx.text(md.body).replace(/msg\.data\.length\s*(>=|==|>|<)[^;)]*\+\s*4/g, '').includes('msg.data')) { me.features.delete('msg.data'); me.features.add('calldata-length-check'); }
      merge(eff, me);
      eff.calls.add(`modifier:${md.name}`);
      if (/nonReentrant/i.test(md.name)) eff.features.add('reentrancy-guard');
    } else if (m.modifierName?.name && /nonReentrant/i.test(m.modifierName.name)) eff.features.add('reentrancy-guard');
  }
  ctx.busy.delete(key);
  ctx.memo.set(key, eff);
  return eff;
}

// ------------------------------------------------------------------ spec

const featureMeta: Record<string, { title: string; treatment: NonPortableFeature['treatment']; detail: string }> = {
  delegatecall: { title: 'delegatecall', treatment: 'not-translated', detail: 'No delegatecall equivalent on the target; code reuse by calling another program/contract changes the storage semantics.' },
  assembly: { title: 'inline assembly', treatment: 'not-translated', detail: 'Inline assembly has no equivalent on the target and must be re-expressed by hand.' },
  selfdestruct: { title: 'selfdestruct', treatment: 'not-translated', detail: 'No equivalent on the target: a deployed contract is not destroyed by itself.' },
  'tx.origin': { title: 'tx.origin', treatment: 'not-translated', detail: 'The target has no transaction-origin concept; only the direct caller is known.' },
  'block.timestamp': { title: 'block.timestamp', treatment: 'mapped', detail: 'Mapped to the block time of the target chain.' },
  'block.number': { title: 'block.number', treatment: 'flagged', detail: 'Block numbers differ in rate and meaning on the target.' },
  'block.chainid': { title: 'block.chainid', treatment: 'flagged', detail: 'The target chain has its own chain identifier (or none).' },
  'block.coinbase': { title: 'block.coinbase', treatment: 'not-translated', detail: 'No block producer address is available to contracts on the target.' },
  'block.prevrandao': { title: 'block.prevrandao/difficulty', treatment: 'not-translated', detail: 'No on-chain randomness source on the target.' },
  'block.difficulty': { title: 'block.difficulty', treatment: 'not-translated', detail: 'No on-chain randomness source on the target.' },
  'block.gaslimit': { title: 'block.gaslimit', treatment: 'not-translated', detail: 'No equivalent on the target.' },
  'block-context': { title: 'blockhash/gasleft', treatment: 'not-translated', detail: 'No direct equivalent on the target.' },
  signatures: { title: 'ecrecover / signature verification', treatment: 'not-translated', detail: 'EVM signature recovery assumes secp256k1 Ethereum addresses; the scheme must be redesigned for the target key scheme.' },
  'native-value': { title: 'payable / native value', treatment: 'mapped', detail: 'ETH value becomes the native coin of the target; msg.value is an explicit amount.' },
  'reentrancy-guard': { title: 'reentrancy guard', treatment: 'mapped', detail: 'The target call model differs; the guard is normally unnecessary but state must be updated before calling out.' },
  uint256: { title: 'uint256 arithmetic', treatment: 'flagged', detail: 'The target may have a narrower integer range than uint256 (see the target design notes); values above it cannot be represented.' },
  upgradeability: { title: 'upgradeability (proxy/initialiser)', treatment: 'flagged', detail: 'Upgrade mechanisms are target specific; proxy patterns are not translated.' },
  'low-level-call': { title: 'low-level call with arbitrary data', treatment: 'not-translated', detail: 'Arbitrary calldata calls to arbitrary targets have no direct form on the target.' },
  'calldata-length-check': { title: 'calldata length check (short-address guard)', treatment: 'mapped', detail: 'A check of the raw calldata length (`onlyPayloadSize`). Typed arguments cannot be short-padded on the target, so the check has no counterpart and is not needed.' },
  'msg.data': { title: 'msg.data', treatment: 'not-translated', detail: 'Raw calldata is not available on the target.' },
  'contract-creation': { title: 'contract creation (new)', treatment: 'not-translated', detail: 'Contracts cannot create contracts this way on the target.' },
  'abi-encoding': { title: 'abi.encode / hashing', treatment: 'flagged', detail: 'The target encodes data differently from the Solidity ABI; hashes that must equal EVM hashes cannot be reproduced without matching the exact encoding.' },
  'dynamic-bytes': { title: 'dynamic bytes arguments', treatment: 'flagged', detail: 'Passed as a byte vector; the semantics of the bytes are chain specific.' },
  'max-uint': { title: 'max uint sentinel (uint(-1) / type(uint256).max)', treatment: 'flagged', detail: 'Used as an "infinite" sentinel (for example an unlimited allowance); the target number range or token program may not have the same sentinel semantics.' },
  fallback: { title: 'receive / fallback functions', treatment: 'flagged', detail: 'The target has no fallback function; native deposits are explicit entry points.' },
};

function featureRecords(byFeature: Map<string, Set<string>>): NonPortableFeature[] {
  return [...byFeature.entries()].map(([id, where]) => {
    const m = featureMeta[id] ?? { title: id, treatment: 'flagged' as const, detail: 'Not mapped automatically.' };
    return { id, title: m.title, where: [...where].sort(), detail: m.detail, treatment: m.treatment };
  }).sort((a, b) => a.id.localeCompare(b.id));
}

export interface ExtractOptions { proxy?: ProxyInfoSpec; address?: string; chainId?: number; file?: string; license?: string | null }

export function extractSpec(c: AstCompile, opts: ExtractOptions = {}): ContractSpec {
  const ctx = new Ctx(c);
  UDVT.clear();
  for (const ast of Object.values<any>(c.asts)) walk(ast, (n) => { if (n.nodeType === 'UserDefinedValueTypeDefinition' && n.underlyingType?.typeDescriptions?.typeString) UDVT.set(n.name, n.underlyingType.typeDescriptions.typeString); });
  for (const ast of Object.values(c.asts)) {
    for (const top of ast.nodes) {
      if (top.nodeType === 'ContractDefinition') {
        ctx.declById.set(top.id, top);
        for (const n of top.nodes) { ctx.declById.set(n.id, n); ctx.declContract.set(n.id, top.name); if (n.nodeType === 'VariableDeclaration' && n.stateVariable) ctx.stateVarIds.set(n.id, n.name); }
      } else ctx.declById.set(top.id, top);
    }
  }
  const main = Object.values<any>(c.asts).flatMap((a) => a.nodes).find((n: any) => n.nodeType === 'ContractDefinition' && n.name === c.contractName && (c.asts[c.contractFile]?.nodes.includes(n)));
  if (!main) throw new Error(`contract ${c.contractName} not in AST`);
  ctx.chain = main.linearizedBaseContracts.map((id: number) => ctx.declById.get(id)).filter(Boolean);
  const fileOf = (def: any) => ctx.range(def).file;
  const isOz = (def: any) => /openzeppelin/i.test(fileOf(def));

  // inheritance
  const ozText = Object.entries(c.sources).filter(([f]) => /openzeppelin/i.test(f)).map(([f, s]) => f + '\n' + s.slice(0, 600)).join('\n');
  const ozVersion = /OpenZeppelin Contracts[^v\n]*v(\d+\.\d+\.\d+)/.exec(ozText)?.[1] ?? /openzeppelin\/contracts(?:-upgradeable)?@(\d+\.\d+\.\d+)/.exec(ozText)?.[1];
  const inherits = ctx.chain.slice(1).filter((b: any) => b.contractKind !== 'library').map((b: any) => ({ name: b.name, openzeppelin: isOz(b), ...(isOz(b) && ozVersion ? { ozVersion } : {}) }));

  // state vars: base first
  const stateVars: StateVarSpec[] = [];
  for (const b of [...ctx.chain].reverse()) {
    for (const n of b.nodes) {
      if (n.nodeType === 'VariableDeclaration' && n.stateVariable) {
        stateVars.push({
          name: n.name, type: typeOfDecl(n), visibility: n.visibility, constant: n.mutability === 'constant', immutable: n.mutability === 'immutable', definedIn: b.name,
          ...(n.value ? { initialValue: ctx.text(n.value) } : {}),
          ...(n.value ? (() => { const t = typeOfDecl(n); const iv = evalInitial(n.value, t.kind, t.bits, ctx.declById); return iv ? { initial: iv } : { initialUnresolved: true }; })() : {}),
          range: ctx.range(n),
        });
      }
    }
  }
  const structs: StructSpec[] = [], enums: EnumSpec[] = [], events: EventSpec[] = [], errors: ErrorSpec[] = [];
  const seenS = new Set<string>();
  for (const b of [...ctx.chain].reverse()) {
    for (const n of b.nodes) {
      const mk = (ps: any[]): ParamSpec[] => ps.map((p) => ({ name: p.name, type: typeOfDecl(p) }));
      if (n.nodeType === 'StructDefinition' && !seenS.has('s' + n.name)) { seenS.add('s' + n.name); structs.push({ name: n.name, fields: mk(n.members) }); }
      if (n.nodeType === 'EnumDefinition' && !seenS.has('e' + n.name)) { seenS.add('e' + n.name); enums.push({ name: n.name, members: n.members.map((m: any) => m.name) }); }
      if (n.nodeType === 'EventDefinition' && !seenS.has('v' + n.name)) { seenS.add('v' + n.name); events.push({ name: n.name, params: n.parameters.parameters.map((p: any) => ({ name: p.name, type: typeOfDecl(p), indexed: !!p.indexed })) }); }
      if (n.nodeType === 'ErrorDefinition' && !seenS.has('r' + n.name)) { seenS.add('r' + n.name); errors.push({ name: n.name, params: mk(n.parameters.parameters) }); }
    }
  }
  // file-level structs/enums/errors
  for (const ast of Object.values<any>(c.asts)) for (const n of ast.nodes) {
    const mk = (ps: any[]): ParamSpec[] => ps.map((p) => ({ name: p.name, type: typeOfDecl(p) }));
    if (n.nodeType === 'StructDefinition' && !seenS.has('s' + n.name)) { seenS.add('s' + n.name); structs.push({ name: n.name, fields: mk(n.members) }); }
    if (n.nodeType === 'EnumDefinition' && !seenS.has('e' + n.name)) { seenS.add('e' + n.name); enums.push({ name: n.name, members: n.members.map((m: any) => m.name) }); }
  }

  // structs declared inside libraries (e.g. `Counters.Counter`) or in unrelated contracts: any struct a state variable refers to must be in the spec,
  // otherwise a target would emit a mapping of an undeclared type
  {
    const need = new Set<string>();
    const walk = (t: TypeRef | undefined): void => { if (!t) return; if (t.kind === 'struct' && t.name) need.add(t.name); walk(t.value); walk(t.element); walk(t.key); };
    for (const sv of stateVars) walk(sv.type);
    for (let again = true; again;) {
      again = false;
      for (const st of structs) for (const f of st.fields) { const before = need.size; walk(f.type); if (need.size !== before) again = true; }
      for (const ast of Object.values<any>(c.asts)) for (const cn of ast.nodes) {
        if (cn.nodeType !== 'ContractDefinition') continue;
        for (const n of cn.nodes ?? []) if (n.nodeType === 'StructDefinition' && need.has(n.name) && !seenS.has('s' + n.name)) {
          seenS.add('s' + n.name); structs.push({ name: n.name, fields: n.members.map((p: any) => ({ name: p.name, type: typeOfDecl(p) })) }); again = true;
        }
      }
    }
  }

  // functions: most-derived wins
  const defs = new Map<string, any>();
  let ctorDef: any = null, receive = false, fallback = false;
  for (const b of ctx.chain) {
    for (const n of b.nodes) {
      if (n.nodeType !== 'FunctionDefinition') continue;
      if (n.kind === 'constructor') { if (b === main) ctorDef = n; continue; }
      if (n.kind === 'receive') { receive = true; }
      if (n.kind === 'fallback') { fallback = true; }
      if (!n.implemented) continue;
      const key = `${n.kind}:${n.name}(${n.parameters.parameters.map((p: any) => p.typeDescriptions?.typeString).join(',')})`;
      if (!defs.has(key)) defs.set(key, n);
    }
  }
  const featureWhere = new Map<string, Set<string>>();
  const note = (f: string, w: string) => { if (!featureWhere.has(f)) featureWhere.set(f, new Set()); featureWhere.get(f)!.add(w); };

  const mkFn = (def: any): FunctionSpec => {
    const eff = analyseFunction(def, ctx);
    const feats = new Set(eff.features);
    if (eff.timestamp) note('block.timestamp', def.name || def.kind);
    const mut = def.stateMutability as FunctionSpec['mutability'];
    if (mut === 'payable') feats.add('native-value');
    const params: ParamSpec[] = def.parameters.parameters.map((p: any) => ({ name: p.name, type: typeOfDecl(p) }));
    const returns: ParamSpec[] = def.returnParameters.parameters.map((p: any) => ({ name: p.name, type: typeOfDecl(p) }));
    for (const p of [...params, ...returns]) {
      if (p.type.kind === 'bytes') feats.add('dynamic-bytes');
      if ((p.type.kind === 'uint' || p.type.kind === 'int') && (p.type.bits ?? 0) > 128) feats.add('uint256');
    }
    // reads are only meaningful for state vars; fold writes
    const paramAssignments: { param: string; stateVar: string }[] = [];
    if (def.body) walk(def.body, (n) => {
      if (n.nodeType === 'Assignment' && n.operator === '=' && n.leftHandSide?.nodeType === 'Identifier' && ctx.stateVarIds.has(n.leftHandSide.referencedDeclaration)) {
        let r = n.rightHandSide;
        while (r?.nodeType === 'FunctionCall' && r.kind === 'typeConversion' && r.arguments?.[0]) r = r.arguments[0];
        if (r?.nodeType === 'Identifier' && params.some((p) => p.name === r.name)) paramAssignments.push({ param: r.name, stateVar: ctx.stateVarIds.get(n.leftHandSide.referencedDeclaration)! });
      }
    });
    const name = def.kind === 'function' ? def.name : def.kind;
    for (const f of feats) note(f, name);
    const mods = (def.modifiers ?? []).filter((m: any) => ctx.declById.get(m.modifierName?.referencedDeclaration)?.nodeType === 'ModifierDefinition').map((m: any) => m.modifierName.name as string);
    return {
      name, kind: def.kind, visibility: def.visibility, mutability: mut, payable: mut === 'payable', params, returns, modifiers: mods, definedIn: ctx.contractOfFn(def),
      events: [...eff.events].sort(), reads: [...eff.reads].sort(), writes: [...eff.writes].sort(), externalCalls: dedupeExt(eff.ext), requires: eff.reqs,
      ...(paramAssignments.length ? { paramAssignments } : {}),
      ...(def.body?.statements?.length === 1 && def.body.statements[0].nodeType === 'Return' && def.body.statements[0].expression ? { returnExpr: ctx.text(def.body.statements[0].expression) } : {}),
      mappingAccesses: dedupeMaps(eff.maps), calls: [...eff.calls].sort(), usesTimestamp: eff.timestamp, nonPortable: [...feats, ...(eff.timestamp ? ['block.timestamp'] : [])].sort(), range: ctx.range(def),
    };
  };
  const taint = analyseGuardTaint(ctx);
  const functions: FunctionSpec[] = [];
  for (const def of defs.values()) {
    if (def.visibility === 'internal' || def.visibility === 'private') { if (isOz(def) || /^_(msgData|msgSender|contextSuffixLength)$/.test(def.name)) continue; }
    { const fn = mkFn(def); const t = taint.get(def.id); if (t?.length) fn.guardTaint = t; functions.push(fn); }
  }
  // ---- effective constructor: the whole linearised chain, base first (C3 order), with base-constructor arguments from the inheritance list
  // (`contract C is Base("x", 8)`) and from modifier-style calls on derived constructors (`constructor(uint a) Base(a)`), the bases' bodies
  // and constant arguments (applied as evaluated initial values). Works for compact ASTs of 0.4.x - 0.8.x.
  const baseCtorDefs = new Map<number, any>();
  for (const b of ctx.chain) for (const n of b.nodes) if (n.nodeType === 'FunctionDefinition' && n.kind === 'constructor' && n.implemented !== false) baseCtorDefs.set(b.id, n);
  const argOf = new Map<number, Map<string, any>>(); // contract id -> base ctor param name -> argument expression
  const bindArgs = (baseId: number, args: any[] | null | undefined) => {
    const cd = baseCtorDefs.get(baseId);
    if (!cd || !args?.length) return;
    const m = argOf.get(baseId) ?? new Map<string, any>();
    (cd.parameters?.parameters ?? []).forEach((p: any, i: number) => { if (args[i] && !m.has(p.name)) m.set(p.name, args[i]); });
    argOf.set(baseId, m);
  };
  const chainDefs = ctx.chain.filter((b: any) => baseCtorDefs.has(b.id) || b.baseContracts?.some((x: any) => x.arguments?.length));
  for (const b of ctx.chain) {
    for (const bc of b.baseContracts ?? []) bindArgs(bc.baseName?.referencedDeclaration, bc.arguments);
    const cd = baseCtorDefs.get(b.id);
    for (const mi of cd?.modifiers ?? []) if (ctx.declById.get(mi.modifierName?.referencedDeclaration)?.nodeType === 'ContractDefinition') bindArgs(mi.modifierName.referencedDeclaration, mi.arguments);
  }
  void chainDefs;
  let ctor: FunctionSpec | null = ctorDef ? mkFn(ctorDef) : null;
  const literalInits: { stateVar: string; node: any }[] = [];
  const senderAssignments = new Set<string>();
  const extraParamAssign: { param: string; stateVar: string }[] = [];
  const stripConv = (e: any): any => { let r = e; while (r?.nodeType === 'FunctionCall' && r.kind === 'typeConversion' && r.arguments?.[0]) r = r.arguments[0]; return r; };
  const mainParams = new Set<string>((ctorDef?.parameters?.parameters ?? []).map((p: any) => p.name));
  for (const b of [...ctx.chain].reverse()) {
    const cd = baseCtorDefs.get(b.id);
    if (!cd) continue;
    if (cd !== ctorDef) {
      const eff = analyseFunction(cd, ctx, new Map());
      if (!ctor) ctor = { name: 'constructor', kind: 'constructor', visibility: 'public', mutability: 'nonpayable', payable: false, params: [], returns: [], modifiers: [], definedIn: main.name, events: [], reads: [], writes: [], externalCalls: [], requires: [], mappingAccesses: [], calls: [], usesTimestamp: false, nonPortable: [], range: ctx.range(cd) };
      const u = <T,>(a: T[], b2: T[]) => { const seen = new Set(a.map((x) => JSON.stringify(x))); return [...a, ...b2.filter((x) => !seen.has(JSON.stringify(x)))]; };
      ctor.events = [...new Set([...ctor.events, ...eff.events])].sort(); ctor.reads = [...new Set([...ctor.reads, ...eff.reads])].sort(); ctor.writes = [...new Set([...ctor.writes, ...eff.writes])].sort();
      ctor.externalCalls = u(ctor.externalCalls, dedupeExt(eff.ext)); ctor.requires = [...eff.reqs, ...ctor.requires]; ctor.mappingAccesses = u(ctor.mappingAccesses, dedupeMaps(eff.maps)); ctor.calls = [...new Set([...ctor.calls, ...eff.calls])].sort();
      if (eff.timestamp) ctor.usesTimestamp = true;
      ctor.nonPortable = [...new Set([...ctor.nonPortable, ...eff.features])].sort();
    }
    // `stateVar = <rhs>` in this constructor body: signer, constant argument, or a parameter of the effective constructor
    if (cd.body) walk(cd.body, (n) => {
      if (n.nodeType !== 'Assignment' || n.operator !== '=' || n.leftHandSide?.nodeType !== 'Identifier') return;
      const sv = ctx.stateVarIds.get(n.leftHandSide.referencedDeclaration);
      if (!sv) return;
      let r = stripConv(n.rightHandSide);
      if (r?.nodeType === 'MemberAccess' && r.expression?.name === 'msg' && r.memberName === 'sender') { senderAssignments.add(sv); return; }
      if (r?.nodeType === 'Identifier' && (cd.parameters?.parameters ?? []).some((p: any) => p.name === r.name)) {
        // a constructor parameter: follow it up the argument chain (base param -> argument expression -> maybe a derived parameter)
        let cur: any = r, owner = b.id, guard = 0;
        while (guard++ < 10 && cur?.nodeType === 'Identifier') {
          const a = argOf.get(owner)?.get(cur.name);
          if (!a) break;
          cur = stripConv(a);
          owner = -1;
          for (const bb of ctx.chain) { const m = argOf.get(bb.id); if (m && [...m.values()].some((x) => x === a)) { /* the argument lives in bb's inheritance list / ctor: its identifiers are bb's ctor params */ owner = bb.id; break; } }
          // arguments written in a derived contract refer to that contract's own constructor parameters: only `main` is followed further
          break;
        }
        if (cur !== r && cur?.nodeType === 'Identifier' && mainParams.has(cur.name)) extraParamAssign.push({ param: cur.name, stateVar: sv });
        else if (cur !== r) literalInits.push({ stateVar: sv, node: cur });
        else if (cd === ctorDef && mainParams.has(r.name)) { /* already in paramAssignments */ }
        return;
      }
      literalInits.push({ stateVar: sv, node: r });
    });
  }
  if (ctor) {
    if (extraParamAssign.length) ctor.paramAssignments = [...(ctor.paramAssignments ?? []), ...extraParamAssign.filter((x) => !(ctor!.paramAssignments ?? []).some((y) => y.param === x.param && y.stateVar === x.stateVar))];
    if (senderAssignments.size) ctor.senderAssignments = [...senderAssignments].sort();
  }
  // the initialiser that replaces the constructor: given by the proxy resolution, or (no proxy) the longest `initialize` of an implementation whose own constructor does nothing
  let foldedName: string | undefined;
  let initName = opts.proxy?.initializer;
  if (!initName && (!ctor || (ctor.params.length === 0 && ctor.writes.length === 0))) {
    const cands = functions.filter((f) => f.kind === 'function' && (f.visibility === 'public' || f.visibility === 'external') && f.mutability !== 'view' && f.mutability !== 'pure' && /^initiali[sz]e$/i.test(f.solidityName ?? f.name) && (f.modifiers.some((m) => /^initializer$/.test(m)) || f.requires.some((r) => /initiali[sz]ed/i.test(r.condition)))).sort((a, b) => b.params.length - a.params.length);
    initName = cands[0]?.name;
  }
  if (initName) {
    const cands = functions.filter((f) => f.kind === 'function' && (f.name === initName || (f.solidityName ?? f.name) === initName)).sort((a, b) => b.params.length - a.params.length);
    const init = cands[0];
    if (init) {
      functions.splice(functions.indexOf(init), 1);
      ctor = { ...init, name: 'constructor', kind: 'constructor', visibility: 'public', modifiers: init.modifiers.filter((m) => !/^initializer$|^reinitializer|^onlyInitializing$/.test(m)) } as FunctionSpec;
      foldedName = init.solidityName ?? init.name;
      delete (ctor as { solidityName?: string }).solidityName; delete (ctor as { excluded?: unknown }).excluded;
      if (!opts.proxy) ctor.definedIn = init.definedIn;
    }
  }
  for (const li of literalInits) {
    const sv = stateVars.find((x) => x.name === li.stateVar);
    if (!sv) continue;
    const iv = evalInitial(li.node, sv.type.kind, sv.type.bits, ctx.declById);
    if (iv) { sv.initial = iv; delete sv.initialUnresolved; sv.initialValue = sv.initialValue ?? ctx.text(li.node); }
  }
  functions.sort((a, b) => a.range.file.localeCompare(b.range.file) || a.range.start - b.range.start);
  {
    // overloaded public functions: one unit, scenario and report row per SIGNATURE
    const pubFns = functions.filter((f) => f.kind === 'function' && (f.visibility === 'public' || f.visibility === 'external'));
    const cnt = new Map<string, number>();
    for (const f of pubFns) cnt.set(f.name, (cnt.get(f.name) ?? 0) + 1);
    for (const f of pubFns) if (cnt.get(f.name)! > 1) { f.solidityName = f.name; f.name = overloadKey(f.name, f.params.map((p) => p.type.solidity)); }
  }

  // state variable level features
  for (const sv of stateVars) {
    if (sv.type.kind === 'uint' && (sv.type.bits ?? 0) > 128) note('uint256', `state:${sv.name}`);
  }
  const baseNames = new Set(inherits.map((i) => i.name));
  if (baseNames.has('ReentrancyGuard')) note('reentrancy-guard', 'ReentrancyGuard');
  for (const n of ['Initializable', 'UUPSUpgradeable', 'Proxy', 'ERC1967Upgrade', 'TransparentUpgradeableProxy']) if (baseNames.has(n)) note('upgradeability', n);
  if (receive || fallback) note('fallback', receive ? 'receive' : 'fallback');
  if (receive) note('native-value', 'receive');

  // token dependencies
  const ctorContractParams = (ctor?.params ?? []).filter((p) => p.type.kind === 'contract');
  const tokenDeps: ContractSpec['tokenDependencies'] = [];
  const allFns = [...functions, ...(ctor ? [ctor] : [])];
  const consider = (name: string, type: string, origin: 'statevar' | 'ctor-param') => {
    const methods = new Set<string>();
    for (const f of allFns) for (const e of f.externalCalls) if (!e.low && (e.target === name || e.target === `_${name}` || e.target.replace(/^_/, '') === name.replace(/^_/, ''))) methods.add(e.method);
    if (methods.size && [...methods].every((m) => ERC20_METHODS.has(m))) tokenDeps.push({ name, origin, type, methods: [...methods].sort() });
  };
  for (const sv of stateVars) if (sv.type.kind === 'contract') consider(sv.name, sv.type.name ?? '', 'statevar');
  for (const p of ctorContractParams) if (!tokenDeps.some((t) => t.name.replace(/^_/, '') === p.name.replace(/^_/, ''))) consider(p.name, p.type.name ?? '', 'ctor-param');

  // access control
  const guarded: AccessControlInfo['guarded'] = [];
  for (const f of functions) {
    if (f.visibility !== 'public' && f.visibility !== 'external') continue;
    const boolMaps = new Set(stateVars.filter((v) => v.type.kind === 'mapping' && v.type.value?.kind === 'bool').map((v) => v.name));
    const isGuard = (r: Requirement) => {
      const cnd = r.condition.replace(/\s+/g, ' ');
      if (/(^|[^\w.])(msg\.sender|_msgSender\(\)) (==|!=) [\w.()]+$/.test(cnd) || /^[\w.()]+ (==|!=) (msg\.sender|_msgSender\(\))/.test(cnd)) return !/\.(transfer|transferFrom|balanceOf)\(/.test(cnd);
      const m = /\b(\w+)\[(msg\.sender|_msgSender\(\))\]/.exec(cnd);
      if (m && boolMaps.has(m[1]!)) return true;
      return /_checkOwner|_checkRole|hasRole\(/.test(cnd) || /^only/.test(r.fromModifier ?? '');
    };
    const g = f.requires.find(isGuard);
    const viaMod = f.modifiers.find((m) => /^only|whenNotPaused/i.test(m));
    if (g) guarded.push({ fn: f.name, guard: g.fromModifier ? `${g.fromModifier}: ${g.condition}` : g.condition });
    else if (viaMod && /^only/i.test(viaMod)) guarded.push({ fn: f.name, guard: `modifier ${viaMod}` });
  }
  let pattern: AccessControlInfo['pattern'] = 'none';
  let ownerVar: string | undefined;
  if (baseNames.has('AccessControl') || baseNames.has('AccessControlEnumerable')) pattern = 'AccessControl';
  else if (baseNames.has('Ownable') || baseNames.has('Ownable2Step')) { pattern = 'Ownable'; ownerVar = '_owner'; }
  else {
    const ov = stateVars.find((s) => s.type.kind === 'address' && /^(_?owner|_?admin|_?funder)$/i.test(s.name));
    const roleMap = stateVars.find((s) => s.type.kind === 'mapping' && s.type.value?.kind === 'bool' && s.type.key?.kind === 'address' && /owner|admin|role|operator|signer|minter/i.test(s.name));
    if (ov && guarded.length) { pattern = 'custom-owner'; ownerVar = ov.name; }
    else if (roleMap && guarded.some((g) => g.guard.includes(roleMap.name))) pattern = 'custom-roles';
    else if (guarded.length) pattern = 'custom-owner';
  }

  if (opts.proxy) featureWhere.set('upgradeability', new Set([...(featureWhere.get('upgradeability') ?? []), `proxy ${opts.proxy.address} (${opts.proxy.type})`]));
  for (const f of functions) { const ex = classifyExcluded(f); if (ex) f.excluded = ex; }
  if (ctor?.name === 'constructor') { /* the constructor itself is never excluded */ }
  // proxy storage-layout padding and OpenZeppelin initialiser bookkeeping exist only for proxies: not state of the rewrite
  for (let i = stateVars.length - 1; i >= 0; i--) { const v = stateVars[i]!; if (v.visibility !== 'public' && /^__gap|^_gap$|^_?_?initialized(Version)?$|^_?initializing$/.test(v.name)) stateVars.splice(i, 1); }
  const nonPortable = featureRecords(featureWhere);
  return {
    version: 1,
    ...(opts.proxy ? { proxy: opts.proxy } : {}), ...(foldedName ? { foldedInitializer: foldedName } : {}),
    name: c.contractName,
    source: { ...(opts.address ? { address: opts.address } : {}), ...(opts.chainId !== undefined ? { chainId: opts.chainId } : {}), ...(opts.file ? { file: opts.file } : {}), compiler: c.compilerVersion, license: opts.license ?? null },
    inherits, stateVars, structs, enums, events, errors, constructor: ctor, functions,
    modifiers: ctx.chain.flatMap((b: any) => b.nodes.filter((n: any) => n.nodeType === 'ModifierDefinition' && !isOz(n)).map((n: any) => ({ name: n.name, range: ctx.range(n) }))),
    accessControl: { pattern, ...(ownerVar ? { ownerVar } : {}), guarded },
    tokenStandards: detectTokenStandards(c.abi),
    tokenDependencies: tokenDeps, nonPortable, hasReceive: receive, hasFallback: fallback,
  };
}

function dedupeExt(l: ExternalCall[]): ExternalCall[] {
  const seen = new Set<string>(); const out: ExternalCall[] = [];
  for (const e of l) { const k = `${e.target}.${e.method}.${e.sendsValue}.${JSON.stringify(e.args)}`; if (!seen.has(k)) { seen.add(k); out.push(e); } }
  return out;
}
function dedupeMaps(l: MappingAccess[]): MappingAccess[] {
  const seen = new Set<string>(); const out: MappingAccess[] = [];
  for (const m of l) { const k = JSON.stringify([m.variable, m.keys, m.write]); if (!seen.has(k)) { seen.add(k); out.push(m); } }
  return out;
}
