import { numberToHex } from 'viem';

/** EIP-6963 discovery with a window.ethereum fallback. Resolves to [{id, name, icon, provider}]. */
export function discoverWallets(waitMs = 400) {
  return new Promise((resolve) => {
    const found = new Map();
    const onAnnounce = (event) => {
      const { info, provider } = event.detail ?? {};
      if (info && provider && !found.has(info.uuid)) found.set(info.uuid, { id: info.uuid, name: info.name, icon: info.icon, rdns: info.rdns, provider });
    };
    window.addEventListener('eip6963:announceProvider', onAnnounce);
    window.dispatchEvent(new Event('eip6963:requestProvider'));
    window.setTimeout(() => {
      window.removeEventListener('eip6963:announceProvider', onAnnounce);
      const list = [...found.values()];
      if (!list.length && window.ethereum) list.push({ id: 'window.ethereum', name: 'Browser wallet (window.ethereum)', icon: '', provider: window.ethereum });
      resolve(list);
    }, waitMs);
  });
}

export async function connect(provider) {
  const accounts = await provider.request({ method: 'eth_requestAccounts' });
  if (!accounts?.length) throw new Error('The wallet returned no account.');
  return accounts[0];
}

export async function chainIdOf(provider) {
  return Number.parseInt(await provider.request({ method: 'eth_chainId' }), 16);
}

/** Ask the wallet to switch to the chain, adding it first when it does not know it (error 4902). */
export async function ensureChain(provider, chain) {
  if ((await chainIdOf(provider)) === chain.chainId) return;
  const hexId = numberToHex(chain.chainId);
  try {
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hexId }] });
  } catch (e) {
    if (e?.code !== 4902 && e?.data?.originalError?.code !== 4902) throw e;
    await provider.request({
      method: 'wallet_addEthereumChain',
      params: [{
        chainId: hexId,
        chainName: chain.name,
        nativeCurrency: { name: chain.nativeCurrency, symbol: chain.nativeCurrency, decimals: 18 },
        rpcUrls: chain.rpcUrls,
        blockExplorerUrls: chain.explorer ? [chain.explorer] : undefined,
      }],
    });
  }
  if ((await chainIdOf(provider)) !== chain.chainId) throw new Error(`The wallet is not on ${chain.name}.`);
}

/** Send a contract creation (no `to`) or a call. The wallet signs; we only hand over unsigned data. */
export function sendTx(provider, { from, to, data }) {
  return provider.request({ method: 'eth_sendTransaction', params: [to ? { from, to, data } : { from, data }] });
}

export async function waitReceipt(provider, hash, { timeoutMs = 300_000, intervalMs = 1500 } = {}) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const r = await provider.request({ method: 'eth_getTransactionReceipt', params: [hash] });
    if (r) return r;
    if (Date.now() > end) throw new Error('Timed out waiting for the transaction to be mined.');
    await new Promise((res) => window.setTimeout(res, intervalMs));
  }
}

export const getCode = (provider, address) => provider.request({ method: 'eth_getCode', params: [address, 'latest'] });

export function describeWalletError(e) {
  if (e?.code === 4001 || e?.code === 'ACTION_REJECTED') return 'You rejected the request in the wallet.';
  return (e?.shortMessage ?? e?.message ?? String(e)).split('\n')[0];
}
