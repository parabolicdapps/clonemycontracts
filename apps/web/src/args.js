import { isAddress } from 'viem';

export const isRef = (v) => !!v && typeof v === 'object' && '$ref' in v;

/** Text shown in an argument input for a JSON-safe plan value. */
export function displayValue(v) {
  if (v === null || v === undefined || isRef(v)) return '';
  return typeof v === 'string' ? v : JSON.stringify(v);
}

/** Returns an error message for a user-entered argument of the given ABI type, or '' when fine. */
export function checkArg(type, text) {
  const t = text.trim();
  if (t === '') return 'A value is required.';
  if (type.endsWith(']') || type === 'tuple') {
    try { JSON.parse(t); return ''; } catch { return 'Enter valid JSON, for example ["0x..."].'; }
  }
  if (type === 'address') return t === 'deployer' || isAddress(t) ? '' : 'Enter a valid address (0x and 40 hex characters; mixed case must be a correct checksum), or the word deployer for your wallet.';
  if (/^uint\d*$/.test(type)) return /^\d+$/.test(t) ? '' : 'Enter a non-negative whole number.';
  if (/^int\d*$/.test(type)) return /^-?\d+$/.test(t) ? '' : 'Enter a whole number.';
  if (type === 'bool') return t === 'true' || t === 'false' ? '' : 'Enter true or false.';
  if (/^bytes\d*$/.test(type)) return /^0x([0-9a-fA-F]{2})*$/.test(t) ? '' : 'Enter hex bytes starting with 0x.';
  return '';
}

export const shortAddr = (a) => (typeof a === 'string' && a.length > 14 ? `${a.slice(0, 8)}…${a.slice(-6)}` : a);
