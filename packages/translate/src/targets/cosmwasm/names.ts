import type { TypeRef } from '../../types.js';

const RESERVED = new Set(['as', 'break', 'const', 'continue', 'crate', 'else', 'enum', 'extern', 'false', 'fn', 'for', 'if', 'impl', 'in', 'let', 'loop', 'match', 'mod', 'move', 'mut', 'pub', 'ref', 'return', 'self', 'Self', 'static', 'struct', 'super', 'trait', 'true', 'type', 'unsafe', 'use', 'where', 'while', 'async', 'await', 'dyn', 'abstract', 'become', 'box', 'do', 'final', 'macro', 'override', 'priv', 'typeof', 'unsized', 'virtual', 'yield', 'try',
  // names the generated handler signatures already use
  'deps', 'env', 'info']);

export const snake = (s: string): string => {
  const r = s.replace(/^_+/, '').replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2').toLowerCase();
  return RESERVED.has(r) ? `${r}_` : r || 'x';
};
export const pascal = (s: string): string => {
  const parts = s.replace(/^_+/, '').replace(/([a-z0-9])([A-Z])/g, '$1_$2').split(/[_\s]+/).filter(Boolean);
  return parts.map((w) => w[0]!.toUpperCase() + w.slice(1)).join('') || 'X';
};

/** How a Solidity value type appears in handler code and in JSON messages. */
export interface TypeMap {
  kind: 'uint' | 'int' | 'bool' | 'address' | 'string' | 'bytes' | 'array' | 'enum' | 'struct' | 'unsupported';
  /** Rust type inside handlers and storage */
  handler: string;
  /** Rust type in ExecuteMsg / InstantiateMsg / QueryMsg fields and response structs */
  msg: string;
  /** element type for arrays; `fixed` is the required length of a fixed array */
  elem?: TypeMap;
  fixed?: number;
  /** for uint/int: width in bits (as declared) */
  bits?: number;
  /** why it cannot be mapped */
  why?: string;
}

/** The integer policy, one place. uint<=32 keep their width, uint33..64 are u64 in code and Uint64 on the wire, 65..128 Uint128, bigger Uint256. */
export function typeMap(t: TypeRef, ctx: { keyed?: boolean } = {}): TypeMap {
  switch (t.kind) {
    case 'uint': {
      const b = t.bits ?? 256;
      if (ctx.keyed) return { kind: 'uint', handler: 'u64', msg: 'Uint64', bits: b };
      if (b <= 8) return { kind: 'uint', handler: 'u8', msg: 'u8', bits: b };
      if (b <= 16) return { kind: 'uint', handler: 'u16', msg: 'u16', bits: b };
      if (b <= 32) return { kind: 'uint', handler: 'u32', msg: 'u32', bits: b };
      if (b <= 64) return { kind: 'uint', handler: 'u64', msg: 'Uint64', bits: b };
      if (b <= 128) return { kind: 'uint', handler: 'Uint128', msg: 'Uint128', bits: b };
      return { kind: 'uint', handler: 'Uint256', msg: 'Uint256', bits: b };
    }
    case 'int': {
      const b = t.bits ?? 256;
      if (b <= 32) return { kind: 'int', handler: b <= 8 ? 'i8' : b <= 16 ? 'i16' : 'i32', msg: b <= 8 ? 'i8' : b <= 16 ? 'i16' : 'i32', bits: b };
      if (b <= 64) return { kind: 'int', handler: 'i64', msg: 'Int64', bits: b };
      if (b <= 128) return { kind: 'int', handler: 'Int128', msg: 'Int128', bits: b };
      return { kind: 'int', handler: 'Int256', msg: 'Int256', bits: b };
    }
    case 'bool': return { kind: 'bool', handler: 'bool', msg: 'bool' };
    case 'address': case 'contract': return { kind: 'address', handler: 'Addr', msg: 'String' };
    case 'string': return { kind: 'string', handler: 'String', msg: 'String' };
    case 'bytes': case 'fixedbytes': return { kind: 'bytes', handler: 'Binary', msg: 'Binary' };
    case 'enum': return { kind: 'enum', handler: 'u8', msg: 'u8' };
    case 'array': {
      const e = typeMap(t.element!);
      if (e.kind === 'unsupported' || e.kind === 'array' || e.kind === 'struct') return { kind: 'unsupported', handler: 'Vec<()>', msg: 'Vec<()>', why: `array of ${t.element?.solidity}` };
      return { kind: 'array', handler: `Vec<${e.handler}>`, msg: `Vec<${e.msg}>`, elem: e, ...(t.length ? { fixed: t.length } : {}) };
    }
    case 'struct': { const n = t.name ?? 'Struct'; return { kind: 'struct', handler: n, msg: n }; }
    default: return { kind: 'unsupported', handler: '()', msg: '()', why: t.solidity };
  }
}

/** Rust expression for the zero value of a stored type. */
export function defaultExpr(m: TypeMap, structName?: string): string {
  switch (m.kind) {
    case 'uint': case 'int': return m.handler === 'Uint256' || m.handler === 'Uint128' || m.handler === 'Int256' || m.handler === 'Int128' ? `${m.handler}::zero()` : '0';
    case 'bool': return 'false';
    case 'address': return 'zero_addr()';
    case 'string': return 'String::new()';
    case 'bytes': return 'Binary::default()';
    case 'array': return 'vec![]';
    case 'enum': return '0';
    default: return structName ? `${structName}::default()` : 'Default::default()';
  }
}
