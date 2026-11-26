import type { AbiItem } from '../types.js';

export function detectTokenStandards(abi: AbiItem[]): string[] {
  const fns = new Set(abi.filter((i) => i.type === 'function').map((i) => i.name));
  const has = (...n: string[]) => n.every((x) => fns.has(x));
  const out: string[] = [];
  const erc721 = has('ownerOf', 'balanceOf', 'setApprovalForAll', 'isApprovedForAll', 'getApproved');
  const erc1155 = has('balanceOfBatch', 'safeBatchTransferFrom', 'setApprovalForAll');
  const erc20 = has('totalSupply', 'balanceOf', 'transfer', 'transferFrom', 'approve', 'allowance') && !erc721;
  if (erc20) out.push('ERC-20');
  if (erc721) out.push('ERC-721');
  if (erc1155) out.push('ERC-1155');
  if (erc20 && has('asset', 'convertToShares', 'convertToAssets', 'totalAssets', 'deposit', 'redeem')) out.push('ERC-4626');
  return out;
}
