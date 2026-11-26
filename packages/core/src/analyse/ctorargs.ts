import { compareRuntime, compileContract, librariesLookup, linkBytecode } from '../compile/index.js';
import type { Address, Hex, VerifiedContract } from '../types.js';
import { constructorInputs, decodeConstructorArgs } from '../util/abi.js';

export interface CreationTx { to: Address | null; input: Hex }

export interface RecoverDeps {
  /** creation tx hash discovery when the provider did not give one */
  fetchCreationTxHash?: (address: Address) => Promise<Hex | null>;
  getTransaction?: (hash: Hex) => Promise<CreationTx | null | undefined>;
}

export interface RecoverResult { args: Hex | null; note: string; txHash?: Hex }

/**
 * Recover constructor arguments when the provider omitted them: take the creation transaction input, strip the creation code
 * recompiled with the published settings, and decode the tail against the constructor ABI.
 */
export async function recoverConstructorArgs(vc: VerifiedContract, deps: RecoverDeps): Promise<RecoverResult> {
  const inputs = constructorInputs(vc.abi);
  if (inputs.length === 0) return { args: '0x', note: 'no constructor arguments' };
  let hash: Hex | null = vc.creationTxHash;
  if (!hash && deps.fetchCreationTxHash) hash = await deps.fetchCreationTxHash(vc.address).catch(() => null);
  if (!hash) return { args: null, note: 'creation transaction unknown (no explorer returned it), so constructor arguments could not be recovered' };
  if (!deps.getTransaction) return { args: null, note: 'RPC cannot fetch transactions', txHash: hash };
  const tx = await deps.getTransaction(hash).catch(() => null);
  if (!tx) return { args: null, note: `creation transaction ${hash} could not be fetched from the RPC (pruned or unavailable)`, txHash: hash };
  if (tx.to) {
    return {
      args: null, txHash: hash,
      note: `the contract was created by a call to ${tx.to} (a factory or other contract, i.e. an internal creation), so its constructor arguments are not in the transaction input and cannot be recovered without a trace; supply them with --set`,
    };
  }
  let compiled;
  try {
    compiled = await compileContract({ compilerVersion: vc.compilerVersion, stdJsonInput: vc.stdJsonInput, contract: vc.fullyQualifiedName ?? vc.name, keepLibraries: true });
  } catch (e) {
    return { args: null, txHash: hash, note: `could not recompile to locate the argument tail: ${(e as Error).message.split('\n')[0]}` };
  }
  const { linked, missing } = linkBytecode(compiled.creation.object, compiled.creation.linkReferences, librariesLookup(vc.libraries));
  if (missing.length) return { args: null, txHash: hash, note: `no address for libraries ${missing.join(', ')}; cannot strip the creation code` };
  const input = tx.input.toLowerCase();
  const code = '0x' + linked.toLowerCase();
  if (input.length < code.length) return { args: null, txHash: hash, note: 'creation input is shorter than the recompiled creation code' };
  const head = input.slice(0, code.length);
  const cmp = compareRuntime(head, code, {});
  if (cmp.result === 'mismatch') return { args: null, txHash: hash, note: `creation input does not start with the recompiled creation code (${cmp.detail}); not guessing` };
  const tail = ('0x' + input.slice(code.length)) as Hex;
  if (decodeConstructorArgs(inputs, tail) === null) return { args: null, txHash: hash, note: 'creation input tail does not decode as the constructor arguments' };
  return { args: tail, txHash: hash, note: `recovered from creation transaction ${hash}` };
}
