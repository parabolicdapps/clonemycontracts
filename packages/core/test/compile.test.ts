import { describe, expect, it } from 'vitest';
import { compareRuntime, linkBytecode } from '../src/compile/index.js';
import { fixLibrarySelfRuntime } from '../src/compile/self.js';

const meta = (b: string) => 'a264697066735822' + b.repeat(34).slice(0, 68) + '64736f6c63430008130033'; // fake cbor; length bytes below
function withMeta(body: string, tag: string): string {
  const cbor = 'a2646970667358221220' + tag.repeat(64).slice(0, 64) + '64736f6c63430008130033';
  const len = (cbor.length / 2).toString(16).padStart(4, '0');
  return body + cbor + len;
}
void meta;

describe('bytecode comparison', () => {
  const body = '6080604052' + '00'.repeat(40) + 'f3fe';
  it('exact', () => expect(compareRuntime('0x' + withMeta(body, 'a'), withMeta(body, 'a'), {}).result).toBe('exact'));
  it('differs only in metadata', () => expect(compareRuntime('0x' + withMeta(body, 'a'), withMeta(body, 'b'), {}).result).toBe('match'));
  it('differs only in immutables', () => {
    const on = '6080' + 'ab'.repeat(32) + 'f3';
    const re = '6080' + '00'.repeat(32) + 'f3';
    expect(compareRuntime('0x' + on, re, { '1': [{ start: 2, length: 32 }] }).result).toBe('match');
    expect(compareRuntime('0x' + on, re, {}).result).toBe('mismatch');
  });
  it('real difference', () => {
    const r = compareRuntime('0x' + withMeta(body, 'a'), withMeta(body.replace('f3fe', 'f3ff'), 'a'), {});
    expect(r.result).toBe('mismatch');
    expect(r.detail).toMatch(/first difference/);
  });
  it('library self-address placeholder', () => {
    const on = '73' + '11'.repeat(20) + '3014';
    const re = '73' + '00'.repeat(20) + '3014';
    expect(fixLibrarySelfRuntime(re, '0x' + on)).toBe(on);
  });
});

describe('library linking', () => {
  it('replaces placeholders at the link-reference offsets', () => {
    const obj = '6000' + '5f'.repeat(0) + '__$abcdefabcdefabcdefabcdefabcdefabcd$__' + '00';
    const { linked, missing } = linkBytecode(obj, { 'a.sol': { Lib: [{ start: 2, length: 20 }] } }, () => '0x' + 'ab'.repeat(20));
    expect(linked).toBe('6000' + 'ab'.repeat(20) + '00');
    expect(missing).toEqual([]);
    expect(linkBytecode(obj, { 'a.sol': { Lib: [{ start: 2, length: 20 }] } }, () => undefined).missing).toEqual(['a.sol:Lib']);
  });
});
