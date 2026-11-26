import { decodeAbiParameters, getAddress } from 'viem';
import type { AbiItem, Address, Hex } from '../types.js';

export const BEACON_SLOT: Hex = '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50';
export const SEL_BEACON_IMPLEMENTATION: Hex = '0x5c60da1b';
export const SEL_FACET_ADDRESSES: Hex = '0x52ef6b2c';
export const SEL_DESCRIPTION: Hex = '0x7284e416';

const MINIMAL_PROXY_PATTERNS: RegExp[] = [
  // EIP-1167 canonical (45 bytes)
  /^363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3$/,
  // vanity / Solady-style variant
  /^3d3d3d3d363d3d37363d73([0-9a-f]{40})5af43d3d93803e602a57fd5bf3$/,
];

/** The implementation address of an EIP-1167 minimal proxy, or null if the runtime code is not one. */
export function parseMinimalProxy(code: string | undefined): Address | null {
  if (!code) return null;
  const c = code.replace(/^0x/, '').toLowerCase();
  for (const re of MINIMAL_PROXY_PATTERNS) {
    const m = re.exec(c);
    if (m) return getAddress(`0x${m[1]}`) as Address;
  }
  return null;
}

/** Init code that deploys a canonical EIP-1167 minimal proxy pointing at `impl`. */
export function minimalProxyInitCode(impl: Address): Hex {
  return `0x3d602d80600a3d3981f3363d3d373d3d3d363d73${impl.slice(2).toLowerCase()}5af43d82803e903d91602b57fd5bf3` as Hex;
}

export function addressFromWord(v: string | undefined): Address | null {
  if (!v || !/^0x0{24}[0-9a-fA-F]{40}$/.test(v) || /^0x0+$/.test(v)) return null;
  return getAddress(`0x${v.slice(26)}`) as Address;
}

/** ABI-level diamond (EIP-2535) loupe/cut functions. */
export function abiLooksLikeDiamond(abi: AbiItem[]): boolean {
  const names = new Set(abi.filter((i) => i.type === 'function').map((i) => i.name));
  return names.has('diamondCut') || (names.has('facets') && names.has('facetAddress'));
}

export function decodeAddressArrayLength(ret: string | undefined): number {
  if (!ret || ret === '0x') return 0;
  try { return (decodeAbiParameters([{ type: 'address[]' }], ret as Hex)[0] as readonly unknown[]).length; } catch { return 0; }
}

export function decodeString(ret: string | undefined): string | null {
  if (!ret || ret === '0x') return null;
  try { return decodeAbiParameters([{ type: 'string' }], ret as Hex)[0] as string; } catch { return null; }
}
