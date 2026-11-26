// Needs anvil + network: CMC_LIVE=1 npm test. Verifies, on a fork of Base, that every CreateX salt form is predicted exactly.
import { describe, expect, it } from 'vitest';
import { createPublicClient, createWalletClient, http, keccak256 } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { getChain } from '../src/chains/index.js';
import { startAnvil, ANVIL_DEV_KEY } from '../src/deploy/anvil.js';
import { CREATEX, CREATEX_ABI, TOPIC_CREATION, TOPIC_CREATION_SALT, computeCreate2, computeCreate3, createxCalldata, guardSalt, makeSalt } from '../src/deploy/createx.js';
import type { Hex } from '../src/types.js';

// init code of a contract with 1-byte runtime 0x00 (STOP): PUSH1 0 PUSH1 0 MSTORE8, PUSH1 1 PUSH1 0 RETURN
const initCodeFor = (n: number): Hex => `0x600060005360016000f3${n.toString(16).padStart(2, '0')}` as Hex;

describe.skipIf(!process.env.CMC_LIVE)('CreateX address prediction on a fork', () => {
  it('predicts CREATE2 and CREATE3 for every salt form', async () => {
    const chain = getChain('base');
    const anvil = await startAnvil(chain);
    try {
      const account = privateKeyToAccount(ANVIL_DEV_KEY);
      const pub = createPublicClient({ transport: http(anvil.url) });
      const wallet = createWalletClient({ account, transport: http(anvil.url) });
      const E = (n: string) => n.padStart(22, '0');
      const salts: Record<string, Hex> = {
        'sender / no chain-id mixing (00)': makeSalt(E('1'), account.address),
        'sender / chain-id mixing (01)': `0x${account.address.slice(2).toLowerCase()}01${E('2')}` as Hex,
        'zero / no chain-id mixing (00)': makeSalt(E('3'), null),
        'zero / chain-id mixing (01)': `0x${'0'.repeat(40)}01${E('4')}` as Hex,
        'random (not sender, not zero)': `0x${'ab'.repeat(20)}00${E('5')}` as Hex,
      };
      let n = 0;
      for (const [label, salt] of Object.entries(salts)) {
        for (const mode of ['create2', 'create3'] as const) {
          const initCode = initCodeFor(n++);
          const g = guardSalt(salt, account.address, chain.chainId);
          const predicted = mode === 'create2' ? computeCreate2(CREATEX, g, initCode) : computeCreate3(CREATEX, g);
          const hash = await wallet.sendTransaction({ chain: null, to: CREATEX, data: createxCalldata(mode, salt, initCode) });
          const rc = await pub.waitForTransactionReceipt({ hash });
          const log = rc.logs.find((l) => l.address.toLowerCase() === CREATEX.toLowerCase() && (l.topics[0] === TOPIC_CREATION_SALT || l.topics[0] === TOPIC_CREATION))!;
          const actual = `0x${log.topics[1]!.slice(26)}`;
          expect(actual.toLowerCase(), `${mode} ${label}`).toBe(predicted.toLowerCase());
          // CreateX's own view helpers agree
          if (mode === 'create2') {
            const viaView = await pub.readContract({ address: CREATEX, abi: CREATEX_ABI, functionName: 'computeCreate2Address', args: [g, keccak256(initCode)] });
            expect(viaView.toLowerCase()).toBe(predicted.toLowerCase());
          } else {
            const viaView = await pub.readContract({ address: CREATEX, abi: CREATEX_ABI, functionName: 'computeCreate3Address', args: [g] });
            expect(viaView.toLowerCase()).toBe(predicted.toLowerCase());
          }
        }
      }
    } finally { await anvil.stop(); }
  }, 120_000);
});
