import { readFileSync } from 'node:fs';
import type { Address, Hex } from '../src/types.js';
import type { ChainReader } from '../src/analyse/index.js';
import { normaliseSourcify } from '../src/fetch/sourcify.js';
import { normaliseBlockscout } from '../src/fetch/blockscout.js';

export const fx = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

export const ADDR = {
  dai: '0x6B175474E89094C44Da98b954EedeAC495271d0F' as Address,
  router: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D' as Address,
  usdcProxy: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as Address,
  usdcImpl: '0x43506849D7C04F9138D1A2050bbF3A0c054402dd' as Address,
  sigChecker: '0x800c32EAa2a6C93CF4Cb51794450eD77fBFBB172' as Address,
  posDescriptor: '0x91ae842A5Ffd8d12023116943e72A606179294f3' as Address,
  nftDescriptor: '0x42B24A95702b9986e82d421cC3568932790A48Ec' as Address,
};

const files: Record<string, string> = {
  [ADDR.dai.toLowerCase()]: 'sourcify-dai-1.json',
  [ADDR.router.toLowerCase()]: 'sourcify-univ2router02-1.json',
  [ADDR.usdcProxy.toLowerCase()]: 'sourcify-usdc-proxy-1.json',
  [ADDR.usdcImpl.toLowerCase()]: 'sourcify-usdc-impl-1.json',
  [ADDR.sigChecker.toLowerCase()]: 'sourcify-signaturechecker-1.json',
  [ADDR.posDescriptor.toLowerCase()]: 'sourcify-nftposdescriptor-1.json',
  [ADDR.nftDescriptor.toLowerCase()]: 'sourcify-nftdescriptor-lib-1.json',
};

export const loadVc = (addr: Address, chainId = 1) => normaliseSourcify(fx(files[addr.toLowerCase()]!), chainId, addr);
export const fetchFixture = async (chainId: number, addr: Address) => loadVc(addr, chainId);

/** Reader that says: WETH/known stuff has code, one EOA, everything else is a contract. */
export const stubReader = (eoas: string[] = []): ChainReader => ({
  getCode: async (a: Address) => (eoas.map((x) => x.toLowerCase()).includes(a.toLowerCase()) ? '0x' : ('0x6080' as Hex)),
  getStorageAt: async () => '0x' + '00'.repeat(32) as Hex,
});

/** Offline stand-ins for the explorer history calls (no early transactions known). */
export const offlineExplorer = {
  fetchEarlyTransactions: async () => ({ txs: [], source: 'none' as const, note: 'offline test' }),
  fetchCreationTxHash: async () => null,
};
