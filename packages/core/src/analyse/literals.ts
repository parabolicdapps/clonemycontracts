import type { Address } from '../types.js';

/** Replace the contents of comments with spaces (newlines kept), so offsets and line numbers stay valid. String literals are respected. */
export function blankComments(src: string): string {
  const out = src.split('');
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i]!;
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') { out[i] = ' '; i++; }
    } else if (c === '/' && d === '*') {
      out[i] = ' '; out[i + 1] = ' '; i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] !== '\n') out[i] = ' '; i++; }
      if (i < n) { out[i] = ' '; out[i + 1] = ' '; i += 2; }
    } else if (c === '"' || c === "'") {
      i++;
      while (i < n && src[i] !== c && src[i] !== '\n') { if (src[i] === '\\') i++; i++; }
      i++;
    } else i++;
  }
  return out.join('');
}

export const ADDRESS_RE = /(?<![0-9a-zA-Z_])0x[0-9a-fA-F]{40}(?![0-9a-zA-Z_])/g;

export interface LiteralLocation { address: Address; file: string; line: number; column: number; snippet: string }

/** Every 20-byte hex literal in code (comments excluded), with file/line/column. */
export function scanLiteralLocations(sources: Record<string, { content: string }>): LiteralLocation[] {
  const out: LiteralLocation[] = [];
  for (const [file, { content }] of Object.entries(sources)) {
    const code = blankComments(content);
    const lines = content.split('\n');
    const lineStarts: number[] = [0];
    for (let i = 0; i < content.length; i++) if (content[i] === '\n') lineStarts.push(i + 1);
    for (const m of code.matchAll(ADDRESS_RE)) {
      const idx = m.index!;
      let lo = 0, hi = lineStarts.length - 1;
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid]! <= idx) lo = mid; else hi = mid - 1; }
      out.push({ address: m[0] as Address, file, line: lo + 1, column: idx - lineStarts[lo]! + 1, snippet: (lines[lo] ?? '').trim().slice(0, 160) });
    }
  }
  return out;
}

/** Replace every occurrence of `from` (case-insensitive, whole literal) with `to`. Returns the new text and the count. */
export function replaceAddress(text: string, from: string, to: string): { text: string; count: number } {
  let count = 0;
  const re = new RegExp(`(?<![0-9a-zA-Z_])${from.replace(/^0x/i, '0x')}(?![0-9a-zA-Z_])`, 'gi');
  const out = text.replace(re, () => { count++; return to; });
  return { text: out, count };
}
