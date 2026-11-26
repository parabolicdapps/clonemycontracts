import type { Address, Hex } from '../types.js';

export const isAddress = (s: string): s is Address => /^0x[0-9a-fA-F]{40}$/.test(s);
export const ZERO_ADDRESS: Address = '0x0000000000000000000000000000000000000000';

export function with0x(s: string): Hex {
  return (s.startsWith('0x') ? s : `0x${s}`) as Hex;
}

/** `0x1234567890…abcdef90`: keeps both ends of a long value; short values are returned unchanged. */
export function elideMiddle(s: string, head = 10, tail = 8): string {
  return s.length <= head + tail + 3 ? s : `${s.slice(0, head)}…${s.slice(-tail)}`;
}

/** A value for prose (check details, log lines): compact JSON in which every long string is elided in the middle, so nothing is ever cut inside a quoted value. Data fields keep the full value. */
export function showValue(v: unknown): string {
  return JSON.stringify(v, (_k, x) => (typeof x === 'string' && x.length > 42 ? elideMiddle(x) : x)) ?? 'undefined';
}
