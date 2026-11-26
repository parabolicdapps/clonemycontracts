import { fetchJson } from '../util/http.js';
import { CmcError, type Address, type Hex, type VerifiedContract, type StdJsonInput } from '../types.js';
import { emptyProxy, normaliseCompilerVersion, spdxFromSources } from './common.js';
import { with0x } from '../util/hex.js';

export const SOURCIFY_BASE = process.env.CMC_SOURCIFY_URL ?? 'https://sourcify.dev/server';

export const SOURCIFY_FIELDS = [
  'abi',
  'compilation',
  'stdJsonInput',
  'creationBytecode.transformationValues',
  'creationBytecode.linkReferences',
  'runtimeBytecode.immutableReferences',
  'runtimeBytecode.linkReferences',
  'deployment',
  'proxyResolution',
].join(',');

/** Pure normaliser (unit tested against recorded fixtures). */
export function normaliseSourcify(raw: any, chainId: number, address: Address): VerifiedContract {
  const comp = raw.compilation ?? {};
  const std = raw.stdJsonInput as StdJsonInput;
  const settings = std.settings ?? {};
  const cs = comp.compilerSettings ?? {};
  const ctor = raw.creationBytecode?.transformationValues?.constructorArguments;
  const proxyRes = raw.proxyResolution ?? {};
  const libraries = settings.libraries ?? cs.libraries ?? {};
  const fqn: string | null = comp.fullyQualifiedName ?? null;
  const mainFile = fqn ? fqn.split(':')[0] : null;
  return {
    address,
    chainId,
    name: comp.name ?? 'Unknown',
    fullyQualifiedName: fqn,
    compilerVersion: normaliseCompilerVersion(comp.compilerVersion ?? ''),
    language: comp.language === 'Vyper' || comp.compiler === 'vyper' ? 'Vyper' : (comp.language ?? 'Solidity'),
    stdJsonInput: std,
    evmVersion: settings.evmVersion ?? cs.evmVersion ?? null,
    optimizer: {
      enabled: !!(settings.optimizer?.enabled ?? cs.optimizer?.enabled),
      runs: Number(settings.optimizer?.runs ?? cs.optimizer?.runs ?? 200),
    },
    abi: raw.abi ?? [],
    constructorArgs: typeof ctor === 'string' ? (with0x(ctor) as Hex) : null,
    libraries,
    creationTxHash: (raw.deployment?.transactionHash as Hex | undefined) ?? null,
    creationBlock: raw.deployment?.blockNumber ? Number(raw.deployment.blockNumber) : null,
    license: spdxFromSources(std.sources ?? {}, mainFile),
    proxy: proxyRes.isProxy
      ? {
          isProxy: true,
          type: proxyRes.proxyType ?? null,
          implementations: (proxyRes.implementations ?? []).map((i: any) => i.address as Address),
        }
      : emptyProxy(),
    immutableReferences: raw.runtimeBytecode?.immutableReferences ?? {},
    matchType: raw.match ?? raw.runtimeMatch ?? null,
    provider: 'sourcify',
    attempts: [],
  };
}

export async function fetchSourcify(chainId: number, address: Address): Promise<VerifiedContract | null> {
  const url = `${SOURCIFY_BASE}/v2/contract/${chainId}/${address}?fields=${SOURCIFY_FIELDS}`;
  const raw = await fetchJson<any>(url);
  if (!raw) return null;
  if (!raw.stdJsonInput?.sources || !raw.compilation) {
    throw new CmcError('Sourcify returned a contract without sources', 'NETWORK');
  }
  return normaliseSourcify(raw, chainId, address);
}
