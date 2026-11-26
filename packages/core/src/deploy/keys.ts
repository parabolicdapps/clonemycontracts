import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';
import { CmcError } from '../types.js';

/** Load the signing key from CMC_PRIVATE_KEY or a Foundry keystore (CMC_KEYSTORE name/path + CMC_KEYSTORE_PASSWORD). Never logged. */
export function loadAccount() {
  const pk = process.env.CMC_PRIVATE_KEY;
  if (pk) {
    const hex = pk.startsWith('0x') ? pk : `0x${pk}`;
    if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) throw new CmcError('CMC_PRIVATE_KEY is not a 32-byte hex key', 'INPUT');
    return privateKeyToAccount(hex as `0x${string}`);
  }
  const ks = process.env.CMC_KEYSTORE;
  if (ks) {
    const dir = process.env.CMC_KEYSTORE_DIR ?? join(homedir(), '.foundry', 'keystores');
    const password = process.env.CMC_KEYSTORE_PASSWORD;
    if (password === undefined) throw new CmcError('CMC_KEYSTORE is set but CMC_KEYSTORE_PASSWORD is not', 'INPUT');
    if (!existsSync(join(dir, ks)) && !readdirSync(dir).includes(ks)) throw new CmcError(`keystore ${ks} not found in ${dir}`, 'INPUT');
    try {
      const cast = existsSync(join(homedir(), '.foundry', 'bin', 'cast')) ? join(homedir(), '.foundry', 'bin', 'cast') : 'cast';
      const out = execFileSync(cast, ['wallet', 'decrypt-keystore', ks, '--keystore-dir', dir, '--unsafe-password', password], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      const m = /0x[0-9a-fA-F]{64}/.exec(out);
      if (!m) throw new Error('unexpected output');
      return privateKeyToAccount(m[0] as `0x${string}`);
    } catch {
      throw new CmcError('could not decrypt the keystore (wrong password or cast missing)', 'INPUT');
    }
  }
  throw new CmcError('no signing key: set CMC_PRIVATE_KEY, or CMC_KEYSTORE + CMC_KEYSTORE_PASSWORD (Foundry keystore)', 'INPUT');
}
