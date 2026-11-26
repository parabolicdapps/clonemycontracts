import { decodeAbiParameters, keccak256, toBytes } from 'viem';
import type { AbiItem, AbiParam, Hex } from '../types.js';
import { jsonSafe } from './abi.js';

/** Canonical ABI type (tuples expanded) for signature hashing. */
export function canonicalType(p: AbiParam): string {
  const m = /^tuple((\[\d*\])*)$/.exec(p.type);
  if (m && p.components) return `(${p.components.map(canonicalType).join(',')})${m[1] ?? ''}`;
  return p.type;
}

export function signatureOf(item: AbiItem): string {
  return `${item.name}(${(item.inputs ?? []).map(canonicalType).join(',')})`;
}

export function selectorOfSignature(sig: string): Hex {
  return keccak256(toBytes(sig)).slice(0, 10) as Hex;
}

export const selectorOf = (item: AbiItem): Hex => selectorOfSignature(signatureOf(item));

/** Names that look like one-time initialisers. */
export const INITIALISER_NAME = /^(initialize|initialise|init|reinitialize|reinitialise|__\w*init\w*|setup|setUp)(V?\d+(_\d+)*)?$|^initiali[sz]e/i;

export function findFunctionBySelector(abi: AbiItem[], selector: string): AbiItem | undefined {
  return abi.find((i) => i.type === 'function' && selectorOf(i) === selector.toLowerCase());
}

export function initialiserFunctions(abi: AbiItem[]): AbiItem[] {
  return abi.filter((i) => i.type === 'function' && !!i.name && INITIALISER_NAME.test(i.name) && i.stateMutability !== 'view' && i.stateMutability !== 'pure');
}

/** Decode `selector ++ args` against an ABI. Returns null when the selector is unknown or the arguments do not decode. */
export function decodeCall(abi: AbiItem[], data: string): { item: AbiItem; selector: Hex; signature: string; values: unknown[] } | null {
  if (!/^0x[0-9a-fA-F]{8}/.test(data)) return null;
  const selector = data.slice(0, 10).toLowerCase() as Hex;
  const item = findFunctionBySelector(abi, selector);
  if (!item) return null;
  const inputs = item.inputs ?? [];
  try {
    const values = inputs.length ? (decodeAbiParameters(inputs as any, `0x${data.slice(10)}` as Hex) as unknown[]).map(jsonSafe) : [];
    return { item, selector, signature: signatureOf(item), values };
  } catch {
    return null;
  }
}
