import { concat, encodeAbiParameters, encodeFunctionData, getAddress, keccak256, parseAbi, toHex, pad } from 'viem';
import type { Address, Hex } from '../types.js';

/** CreateX (pcaversaccio/createx), deployed at this address on most EVM chains. */
export const CREATEX: Address = '0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed';

export const CREATEX_ABI = parseAbi([
  'function deployCreate2(bytes32 salt, bytes initCode) payable returns (address newContract)',
  'function deployCreate3(bytes32 salt, bytes initCode) payable returns (address newContract)',
  'function computeCreate2Address(bytes32 salt, bytes32 initCodeHash) view returns (address computedAddress)',
  'function computeCreate2Address(bytes32 salt, bytes32 initCodeHash, address deployer) pure returns (address computedAddress)',
  'function computeCreate3Address(bytes32 salt) view returns (address computedAddress)',
  'function computeCreate3Address(bytes32 salt, address deployer) pure returns (address computedAddress)',
  'event ContractCreation(address indexed newContract, bytes32 indexed salt)',
  'event ContractCreation(address indexed newContract)',
]);

export const TOPIC_CREATION_SALT = keccak256(toHexBytes('ContractCreation(address,bytes32)'));
export const TOPIC_CREATION = keccak256(toHexBytes('ContractCreation(address)'));
function toHexBytes(s: string): Hex { return toHex(new TextEncoder().encode(s)); }

const word = (n: bigint | number) => pad(toHex(BigInt(n)), { size: 32 });

/**
 * Salt layout CreateX understands: 20 bytes (deployer, or zero) | 1 byte redeploy-protection flag | 11 bytes of your own entropy.
 * We use flag 0x00 (no chain-id mixing) so the address is the same on every chain for identical init code (CREATE2) / always (CREATE3).
 */
export function makeSalt(entropy: Hex | string, deployer: Address | null): Hex {
  const e = entropy.replace(/^0x/, '');
  if (!/^[0-9a-fA-F]*$/.test(e) || e.length > 22) throw new Error('salt entropy must be at most 11 bytes of hex (or a full 32-byte salt)');
  const prefix = deployer ? deployer.slice(2).toLowerCase() : '0'.repeat(40);
  return `0x${prefix}00${e.padStart(22, '0')}` as Hex;
}

/** Accepts a full 32-byte salt verbatim or up to 11 bytes of entropy to wrap with {@link makeSalt}. */
export function normaliseSalt(input: string, deployer: Address | null): { salt: Hex; wrapped: boolean } {
  const h = input.replace(/^0x/, '');
  if (!/^[0-9a-fA-F]*$/.test(h) || h.length === 0) throw new Error(`salt "${input}" is not hex`);
  if (h.length === 64) return { salt: `0x${h.toLowerCase()}` as Hex, wrapped: false };
  return { salt: makeSalt(h, deployer), wrapped: true };
}

/** The salt as CreateX will hash it (`_guard`), mirrored from CreateX.sol. `msgSender` is the account calling CreateX. */
export function guardSalt(salt: Hex, msgSender: Address | null, chainId: number): Hex {
  const h = salt.slice(2).toLowerCase();
  const prefix = h.slice(0, 40);
  const flag = h.slice(40, 42);
  const isSender = !!msgSender && prefix === msgSender.slice(2).toLowerCase();
  const isZero = /^0{40}$/.test(prefix);
  if (isSender && flag === '01') return keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'bytes32' }], [msgSender!, BigInt(chainId), salt]));
  if (isSender && flag === '00') return keccak256(concat([pad(msgSender!, { size: 32 }), salt]));
  if (isSender) throw new Error('CreateX rejects this salt (21st byte must be 00 or 01 when the first 20 bytes are your address)');
  if (isZero && flag === '01') return keccak256(concat([word(chainId), salt]));
  if (isZero && flag !== '00') throw new Error('CreateX rejects this salt (21st byte must be 00 or 01 when the first 20 bytes are zero)');
  return keccak256(encodeAbiParameters([{ type: 'bytes32' }], [salt]));
}

export function computeCreate2(factory: Address, guardedSalt: Hex, initCode: Hex): Address {
  const hash = keccak256(concat(['0xff', factory, guardedSalt, keccak256(initCode)]));
  return getAddress(`0x${hash.slice(26)}`) as Address;
}

const CREATE3_PROXY_INITCODE: Hex = '0x67363d3d37363d34f03d5260086018f3';
/** CREATE3 address: depends only on the factory and the guarded salt, never on the init code. */
export function computeCreate3(factory: Address, guardedSalt: Hex): Address {
  const proxy = computeCreate2(factory, guardedSalt, CREATE3_PROXY_INITCODE);
  const hash = keccak256(concat(['0xd694', proxy, '0x01']));
  return getAddress(`0x${hash.slice(26)}`) as Address;
}

export function createxCalldata(mode: 'create2' | 'create3', salt: Hex, initCode: Hex): Hex {
  return encodeFunctionData({ abi: CREATEX_ABI, functionName: mode === 'create2' ? 'deployCreate2' : 'deployCreate3', args: [salt, initCode] });
}
