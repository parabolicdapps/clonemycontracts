import type { InitialValue } from '../types.js';

const UNITS: Record<string, bigint> = {
  wei: 1n, gwei: 10n ** 9n, szabo: 10n ** 12n, finney: 10n ** 15n, ether: 10n ** 18n,
  seconds: 1n, minutes: 60n, hours: 3600n, days: 86400n, weeks: 604800n, years: 31536000n,
};
const MASK = (bits: number) => (1n << BigInt(bits)) - 1n;

type V = bigint | boolean | string | { addr: string } | undefined;

function literal(n: any): V {
  if (n.kind === 'bool') return n.value === 'true';
  if (n.kind === 'string') return n.value as string;
  const raw = String(n.value ?? '').replace(/_/g, '');
  const unit = n.subdenomination ? UNITS[n.subdenomination] : 1n;
  if (unit === undefined) return undefined;
  if (n.kind === 'number' || n.kind === undefined || n.kind === 'hexString' && false) {
    if (/^0x[0-9a-fA-F]+$/.test(raw)) return BigInt(raw) * unit;
    if (/^\d+$/.test(raw)) return BigInt(raw) * unit;
    const m = /^(\d+)(?:\.(\d+))?[eE]\+?(\d+)$/.exec(raw);
    if (m) { const frac = m[2] ?? ''; const e = BigInt(m[3]!) - BigInt(frac.length); if (e < 0n) return undefined; return BigInt(m[1]! + frac) * 10n ** e * unit; }
    const d = /^(\d+)\.(\d+)$/.exec(raw);
    if (d) { const scale = 10n ** BigInt(d[2]!.length); const num = BigInt(d[1]! + d[2]!) * unit; return num % scale === 0n ? num / scale : undefined; }
  }
  return undefined;
}

/** Evaluate an expression node of the solc AST as a compile-time constant. Returns undefined when it is not one. */
export function evalConst(n: any, decl: Map<number, any>, depth = 0): V {
  if (!n || depth > 30) return undefined;
  switch (n.nodeType) {
    case 'Literal': return literal(n);
    case 'TupleExpression': return n.components?.length === 1 ? evalConst(n.components[0], decl, depth + 1) : undefined;
    case 'UnaryOperation': {
      if (n.operator === '-') { const v = evalConst(n.subExpression, decl, depth + 1); return typeof v === 'bigint' ? -v : undefined; }
      if (n.operator === '!') { const v = evalConst(n.subExpression, decl, depth + 1); return typeof v === 'boolean' ? !v : undefined; }
      return undefined;
    }
    case 'BinaryOperation': {
      const a = evalConst(n.leftExpression, decl, depth + 1), b = evalConst(n.rightExpression, decl, depth + 1);
      if (typeof a === 'bigint' && typeof b === 'bigint') {
        switch (n.operator) {
          case '+': return a + b; case '-': return a - b; case '*': return a * b;
          case '/': return b === 0n ? undefined : a / b; case '%': return b === 0n ? undefined : a % b;
          case '**': return b < 0n || b > 512n ? undefined : a ** b;
          case '<<': return a << b; case '>>': return a >> b; case '&': return a & b; case '|': return a | b; case '^': return a ^ b;
        }
        return undefined;
      }
      if (typeof a === 'boolean' && typeof b === 'boolean') { if (n.operator === '&&') return a && b; if (n.operator === '||') return a || b; }
      return undefined;
    }
    case 'Identifier': {
      const d = decl.get(n.referencedDeclaration);
      if (d?.nodeType === 'VariableDeclaration' && (d.constant || d.mutability === 'constant') && d.value) return evalConst(d.value, decl, depth + 1);
      return undefined;
    }
    case 'MemberAccess': {
      // type(uint256).max / .min and Library.CONSTANT
      const e = n.expression;
      if (e?.nodeType === 'FunctionCall' && e.expression?.name === 'type' && ['max', 'min'].includes(n.memberName)) {
        const ts: string = e.arguments?.[0]?.typeDescriptions?.typeString ?? e.typeDescriptions?.typeString ?? '';
        const m = /uint(\d*)/.exec(ts) ?? /int(\d*)/.exec(ts);
        const t = /type\((u?int\d*)\)/.exec(ts)?.[1] ?? /(u?int\d*)/.exec(ts)?.[1];
        if (t) {
          const bits = Number(/\d+/.exec(t)?.[0] ?? 256);
          if (t.startsWith('uint')) return n.memberName === 'max' ? MASK(bits) : 0n;
          return n.memberName === 'max' ? MASK(bits - 1) : -(1n << BigInt(bits - 1));
        }
        void m;
      }
      const d = decl.get(n.referencedDeclaration);
      if (d?.nodeType === 'VariableDeclaration' && (d.constant || d.mutability === 'constant') && d.value) return evalConst(d.value, decl, depth + 1);
      return undefined;
    }
    case 'FunctionCall': {
      if (n.kind !== 'typeConversion' || n.arguments?.length !== 1) return undefined;
      const to: string = n.typeDescriptions?.typeString ?? '';
      const v = evalConst(n.arguments[0], decl, depth + 1);
      if (v === undefined) return undefined;
      if (/^address( payable)?$/.test(to)) { if (typeof v === 'bigint') return { addr: '0x' + v.toString(16).padStart(40, '0') }; return undefined; }
      const m = /^(u?)int(\d*)$/.exec(to);
      if (m && typeof v === 'bigint') {
        const bits = Number(m[2] || 256);
        if (m[1]) return v < 0n ? undefined : v <= MASK(bits) ? v : undefined;
        return v >= -(1n << BigInt(bits - 1)) && v <= MASK(bits - 1) ? v : undefined;
      }
      if (to === 'string' && typeof v === 'string') return v;
      return typeof v === 'boolean' && to === 'bool' ? v : undefined;
    }
    default: return undefined;
  }
}

/** Evaluate and tag with the declared type kind; undefined when the initialiser is not a pure constant of that type. */
export function evalInitial(value: any, typeKind: string, bits: number | undefined, decl: Map<number, any>): InitialValue | undefined {
  const v = evalConst(value, decl);
  if (v === undefined) return undefined;
  if (typeKind === 'uint' && typeof v === 'bigint') return v >= 0n && v <= MASK(bits ?? 256) ? { kind: 'uint', value: v.toString(), via: 'ast' } : undefined;
  if (typeKind === 'int' && typeof v === 'bigint') return { kind: 'int', value: v.toString(), via: 'ast' };
  if (typeKind === 'bool' && typeof v === 'boolean') return { kind: 'bool', value: String(v), via: 'ast' };
  if (typeKind === 'string' && typeof v === 'string') return { kind: 'string', value: v, via: 'ast' };
  if (typeKind === 'address' && typeof v === 'object' && v !== null && 'addr' in v) return { kind: 'address', value: v.addr, via: 'ast' };
  return undefined;
}
