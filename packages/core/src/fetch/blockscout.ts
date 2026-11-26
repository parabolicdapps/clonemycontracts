import { fetchJson } from '../util/http.js';
import { type Address, type Hex, type StdJsonInput, type VerifiedContract } from '../types.js';
import { emptyProxy, normaliseCompilerVersion, spdxFromSources } from './common.js';
import { isAddress, with0x } from '../util/hex.js';

export function normaliseBlockscout(raw: any, chainId: number, address: Address): VerifiedContract {
  const sources: Record<string, { content: string }> = {};
  if (raw.file_path && raw.source_code) sources[raw.file_path] = { content: raw.source_code };
  for (const s of raw.additional_sources ?? []) sources[s.file_path] = { content: s.source_code };
  const lang = String(raw.language ?? 'solidity').toLowerCase();
  const settings: StdJsonInput['settings'] = { ...(raw.compiler_settings ?? {}) };
  settings.optimizer ??= { enabled: !!raw.optimization_enabled, runs: raw.optimization_runs ?? 200 };
  if (raw.evm_version && raw.evm_version !== 'default' && !settings.evmVersion) settings.evmVersion = raw.evm_version;
  const libs: Record<string, Record<string, string>> = { ...(settings.libraries ?? {}) };
  for (const l of raw.external_libraries ?? []) {
    if (l.name && isAddress(l.address_hash)) (libs[''] ??= {})[l.name] = l.address_hash;
  }
  settings.libraries = libs;
  const std: StdJsonInput = { language: lang === 'vyper' ? 'Vyper' : lang === 'yul' ? 'Yul' : 'Solidity', sources, settings };
  const impls: Address[] = (raw.implementations ?? []).map((i: any) => i.address_hash ?? i.address).filter((a: unknown): a is Address => typeof a === 'string' && isAddress(a));
  const isProxy = !!raw.proxy_type && raw.proxy_type !== 'unknown' && impls.length > 0;
  return {
    address,
    chainId,
    name: raw.name ?? 'Unknown',
    fullyQualifiedName: raw.file_path && raw.name ? `${raw.file_path}:${raw.name}` : null,
    compilerVersion: normaliseCompilerVersion(raw.compiler_version ?? ''),
    language: std.language,
    stdJsonInput: std,
    evmVersion: settings.evmVersion ?? null,
    optimizer: { enabled: !!settings.optimizer.enabled, runs: Number(settings.optimizer.runs ?? 200) },
    abi: raw.abi ?? [],
    constructorArgs: typeof raw.constructor_args === 'string' ? (with0x(raw.constructor_args) as Hex) : null,
    libraries: libs,
    creationTxHash: null,
    license: raw.license_type && raw.license_type !== 'none' ? String(raw.license_type) : spdxFromSources(sources, raw.file_path),
    proxy: isProxy ? { isProxy: true, type: raw.proxy_type, implementations: impls } : emptyProxy(),
    immutableReferences: {},
    matchType: raw.is_fully_verified ? 'full' : raw.is_partially_verified ? 'partial' : null,
    provider: 'blockscout',
    attempts: [],
  };
}

export async function fetchBlockscout(base: string, chainId: number, address: Address): Promise<VerifiedContract | null> {
  const raw = await fetchJson<any>(`${base.replace(/\/$/, '')}/api/v2/smart-contracts/${address}`);
  if (!raw || raw.is_verified === false || !raw.source_code) return null;
  return normaliseBlockscout(raw, chainId, address);
}
