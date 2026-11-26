import { createHash } from 'node:crypto';
import type { TypeRef } from '../../types.js';

/** the tz1 "burn" address used as Solidity's address(0): Tezos has no zero address, nobody holds the key to this one */
export const ZERO_ADDRESS = 'tz1Ke2h7sDdakHJQh8WX4Z372du1KChsksyU';
export const MAX_UINT256 = '115792089237316195423570985008687907853269984665640564039457584007913129639935';

const PY_RESERVED = new Set(['False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield', 'match', 'case', 'type',
  // names the generated code already uses in entrypoints/helpers
  'self', 'sp', 'main', 'params', 'param', 'len', 'abs', 'min', 'max', 'range', 'sum', 'ZERO_ADDRESS', 'MAX_UINT256', 'u256', 'pow_nat']);

export const snake = (s: string): string => {
  const r = s.replace(/^_+/, '').replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2').toLowerCase().replace(/[^a-z0-9_]/g, '_');
  const x = r || 'x';
  const y = /^[0-9]/.test(x) ? `x_${x}` : x;
  return PY_RESERVED.has(y) ? `${y}_` : y;
};
export const pascal = (s: string): string => {
  const parts = s.replace(/^_+/, '').replace(/([a-z0-9])([A-Z])/g, '$1_$2').split(/[_\s]+/).filter(Boolean);
  return parts.map((w) => w[0]!.toUpperCase() + w.slice(1)).join('') || 'X';
};
/** a Michelson entrypoint name: letters, digits, `_`, at most 31 characters */
export const entryName = (solidity: string, taken: Set<string>): string => {
  let n = solidity.replace(/^_+/, '').replace(/[^A-Za-z0-9_]/g, '_') || 'entry';
  if (PY_RESERVED.has(n) || /^(get_|set_|push_|pop_|erc20_|emit_)/.test(n) || ['msg_value', 'now_secs', 'send_native', 'native_balance', 'initialize', '__init__'].includes(n)) n += '_';
  // Michelson entrypoint names are limited to 31 characters: a longer name becomes a deterministic short one (22 characters + `_` + 8 hex of the full name's hash), never a silent cut
  if (n.length > 31) n = `${n.slice(0, 22)}_${createHash('sha1').update(n).digest('hex').slice(0, 8)}`;
  while (taken.has(n)) n = (n.length > 30 ? n.slice(0, 30) : n) + '_';
  taken.add(n);
  return n;
};

/** How a Solidity value type appears in SmartPy code (parameters, storage, return values). */
export interface TypeMap {
  kind: 'uint' | 'int' | 'bool' | 'address' | 'string' | 'bytes' | 'array' | 'enum' | 'struct' | 'unsupported';
  /** SmartPy type expression, e.g. `sp.nat`, `sp.list[sp.address]`, a struct alias name */
  sp: string;
  /** SmartPy expression of the Solidity default (zero) value */
  zero: string;
  elem?: TypeMap;
  /** required length of a fixed array parameter */
  fixed?: number;
  bits?: number;
  why?: string;
}

export function typeMap(t: TypeRef): TypeMap {
  switch (t.kind) {
    case 'uint': return { kind: 'uint', sp: 'sp.nat', zero: 'sp.nat(0)', bits: t.bits ?? 256 };
    case 'int': return { kind: 'int', sp: 'sp.int', zero: 'sp.int(0)', bits: t.bits ?? 256 };
    case 'bool': return { kind: 'bool', sp: 'sp.bool', zero: 'False' };
    case 'address': case 'contract': return { kind: 'address', sp: 'sp.address', zero: 'ZERO_ADDRESS' };
    case 'string': return { kind: 'string', sp: 'sp.string', zero: '""' };
    case 'bytes': case 'fixedbytes': return { kind: 'bytes', sp: 'sp.bytes', zero: 'sp.bytes("0x")' };
    case 'enum': return { kind: 'enum', sp: 'sp.nat', zero: 'sp.nat(0)' };
    case 'array': {
      const e = typeMap(t.element!);
      if (e.kind === 'unsupported' || e.kind === 'array' || e.kind === 'struct') return { kind: 'unsupported', sp: 'sp.unit', zero: '()', why: `array of ${t.element?.solidity}` };
      return { kind: 'array', sp: `sp.list[${e.sp}]`, zero: `sp.cast([], sp.list[${e.sp}])`, elem: e, ...(t.length ? { fixed: t.length } : {}) };
    }
    case 'struct': { const n = t.name ?? 'Struct'; return { kind: 'struct', sp: n, zero: `${n}_ZERO` }; }
    default: return { kind: 'unsupported', sp: 'sp.unit', zero: '()', why: t.solidity };
  }
}
