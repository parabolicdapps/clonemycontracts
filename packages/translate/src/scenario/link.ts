import { CmcError, getChain, getClient, linkBytecode, type VerifiedContract } from '@cmc/core';
import type { AstCompile } from '../spec/compile.js';

const lookup = (libs: Record<string, Record<string, string>>) => (file: string, name: string): string | undefined => libs[file]?.[name] ?? libs['']?.[name] ?? Object.values(libs).map((m) => m[name]).find(Boolean);

export interface PreparedOriginal { creation: string; libraries: { address: string; code: string }[]; ctorArgs: string | null; notes: string[] }

/**
 * Make the ORIGINAL deployable locally: link library placeholders with the addresses of the verified source, preload the libraries' runtime code
 * at those addresses on the local chain, and keep the real constructor arguments (immutables of upgradeable implementations).
 */
export async function prepareOriginal(chain: string | number, vc: VerifiedContract, comp: AstCompile, opts: { getCode?: (address: string) => Promise<string | undefined> } = {}): Promise<PreparedOriginal> {
  const notes: string[] = [];
  const refs = comp.linkReferences as Record<string, Record<string, { start: number; length: number }[]>>;
  const libs: { address: string; code: string }[] = [];
  let creation = comp.creation;
  if (Object.keys(refs ?? {}).length) {
    const used = new Map<string, string>();
    const { linked, missing } = linkBytecode(creation, refs as any, (file, name) => { const a = lookup(vc.libraries ?? {})(file, name); if (a) used.set(`${file}:${name}`, a); return a; });
    if (missing.length) throw new CmcError(`the contract links the librar${missing.length > 1 ? 'ies' : 'y'} ${missing.join(', ')} but the verified source gives no address for it: ground truth cannot be recorded`, 'COMPILE');
    creation = linked;
    const getCode = opts.getCode ?? (async (a: string) => (await (getClient(getChain(chain)) as any).getCode({ address: a })) as string | undefined);
    for (const [k, address] of used) {
      const code = await getCode(address).catch(() => undefined);
      if (!code || code === '0x') throw new CmcError(`library ${k} at ${address} has no code on the source chain: ground truth cannot be recorded`, 'COMPILE');
      libs.push({ address, code });
      notes.push(`library ${k} linked at ${address} (runtime code copied from the source chain)`);
    }
  }
  return { creation, libraries: libs, ctorArgs: vc.constructorArgs && vc.constructorArgs !== '0x' ? vc.constructorArgs : null, notes };
}
