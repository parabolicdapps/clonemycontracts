import { decodeAbiParameters, encodeAbiParameters, getAddress } from 'viem';
import type { AbiItem, AbiParam, Address } from '../types.js';
import { isAddress } from './hex.js';

export function jsonSafe(v: unknown): unknown {
  if (typeof v === 'bigint') return v.toString();
  if (Array.isArray(v)) return v.map(jsonSafe);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, jsonSafe(x)]));
  return v;
}

export function constructorInputs(abi: AbiItem[]): AbiParam[] {
  return abi.find((i) => i.type === 'constructor')?.inputs ?? [];
}

export function decodeConstructorArgs(inputs: AbiParam[], hex: string | null): unknown[] | null {
  if (inputs.length === 0) return [];
  if (hex === null) return null;
  try {
    const values = decodeAbiParameters(inputs as any, (hex === '0x' ? '0x' : hex) as `0x${string}`);
    return values.map((v) => jsonSafe(v));
  } catch {
    return null;
  }
}

/** Walk a decoded (json-safe) value along its ABI type and report every address with its path. */
export function findAddresses(param: AbiParam, value: unknown, path: (string | number)[] = []): { path: (string | number)[]; address: Address }[] {
  const out: { path: (string | number)[]; address: Address }[] = [];
  const arr = /^(.*)\[(\d*)\]$/.exec(param.type);
  if (arr && Array.isArray(value)) {
    value.forEach((v, i) => out.push(...findAddresses({ ...param, type: arr[1]! }, v, [...path, i])));
  } else if (param.type === 'address' && typeof value === 'string' && isAddress(value)) {
    out.push({ path, address: value });
  } else if (param.type === 'tuple' && param.components) {
    param.components.forEach((c, i) => {
      const v = Array.isArray(value) ? value[i] : (value as any)?.[c.name ?? ''];
      out.push(...findAddresses(c, v, [...path, i]));
    });
  }
  return out;
}

export function setAtPath(root: unknown, path: (string | number)[], newValue: unknown): unknown {
  if (path.length === 0) return newValue;
  const [h, ...rest] = path;
  if (Array.isArray(root)) {
    const copy = [...root];
    copy[h as number] = setAtPath(copy[h as number], rest, newValue);
    return copy;
  }
  const copy = { ...(root as Record<string, unknown>) };
  copy[h as string] = setAtPath(copy[h as string], rest, newValue);
  return copy;
}

/** Convert a JSON-safe value into what viem expects for the ABI type. */
export function coerceArg(param: AbiParam, v: unknown): unknown {
  const arr = /^(.*)\[(\d*)\]$/.exec(param.type);
  if (arr) {
    if (!Array.isArray(v)) throw new Error(`expected array for ${param.type}`);
    return v.map((x) => coerceArg({ ...param, type: arr[1]! }, x));
  }
  if (param.type === 'tuple') {
    const comps = param.components ?? [];
    return comps.map((c, i) => coerceArg(c, Array.isArray(v) ? v[i] : (v as any)?.[c.name ?? '']));
  }
  if (/^u?int\d*$/.test(param.type)) return BigInt(v as string | number);
  if (param.type === 'address') return getAddress(String(v));
  if (param.type === 'bool') return v === true || v === 'true';
  return v;
}

export function encodeArgs(inputs: AbiParam[], values: unknown[]): `0x${string}` {
  if (inputs.length === 0) return '0x';
  return encodeAbiParameters(inputs as any, inputs.map((p, i) => coerceArg(p, values[i])) as any);
}

/** Parse a CLI `--set` string for an ABI type: JSON for compound types, raw string for scalars. */
export function parseArgValue(param: AbiParam, s: string): unknown {
  if (param.type.endsWith(']') || param.type === 'tuple') return JSON.parse(s);
  return s;
}
