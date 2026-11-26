import { getChain, unsupportedChainMessage } from '../chains/index.js';
import { CmcError, type Address, type VerifiedContract } from '../types.js';
import { isAddress } from '../util/hex.js';
import { getAddress, isAddress as isChecksumValid } from 'viem';
import { fetchBlockscout } from './blockscout.js';
import { fetchEtherscan } from './etherscan.js';
import { fetchSourcify } from './sourcify.js';

export { normaliseSourcify } from './sourcify.js';
export { normaliseEtherscan, parseEtherscanSource, parseLibraryField } from './etherscan.js';
export { normaliseBlockscout } from './blockscout.js';

/** Fetch verified source: Sourcify, then Etherscan V2 (only with ETHERSCAN_API_KEY), then Blockscout. */
export async function fetchVerifiedContract(chainIdOrAlias: string | number, address: string): Promise<VerifiedContract> {
  const chain = getChain(chainIdOrAlias);
  if (!isAddress(address)) throw new CmcError(`"${address}" is not a valid 20-byte hex address`, 'INPUT');
  if (chain.kind !== 'evm') throw new CmcError(unsupportedChainMessage(chain), 'UNSUPPORTED');
  if (address !== address.toLowerCase() && address !== address.toUpperCase().replace('0X', '0x') && !isChecksumValid(address, { strict: true })) {
    throw new CmcError(`"${address}" has an invalid EIP-55 checksum (typo?)`, 'INPUT');
  }
  const addr = getAddress(address.toLowerCase()) as Address;
  const attempts: VerifiedContract['attempts'] = [];

  const providers: { name: 'sourcify' | 'etherscan' | 'blockscout'; run: () => Promise<VerifiedContract | null> }[] = [
    { name: 'sourcify', run: () => fetchSourcify(chain.chainId, addr) },
  ];
  const key = process.env.ETHERSCAN_API_KEY;
  if (key && chain.explorer.etherscanV2) providers.push({ name: 'etherscan', run: () => fetchEtherscan(chain.chainId, addr, key) });
  if (chain.explorer.blockscoutApi) {
    const base = chain.explorer.blockscoutApi;
    providers.push({ name: 'blockscout', run: () => fetchBlockscout(base, chain.chainId, addr) });
  }

  for (const p of providers) {
    try {
      const c = await p.run();
      if (c) {
        attempts.push({ provider: p.name, ok: true });
        return { ...c, attempts };
      }
      attempts.push({ provider: p.name, ok: false, note: 'not verified' });
    } catch (e) {
      attempts.push({ provider: p.name, ok: false, note: (e as Error).message });
    }
  }
  const notes = attempts.map((a) => `${a.provider}: ${a.note}`).join('; ');
  const allUnverified = attempts.every((a) => a.note === 'not verified');
  throw new CmcError(
    allUnverified
      ? `No verified source found for ${addr} on ${chain.name} (${notes}). Cloning unverified bytecode is not supported.`
      : `Could not fetch source for ${addr} on ${chain.name} (${notes})`,
    allUnverified ? 'UNVERIFIED' : 'NETWORK',
  );
}
