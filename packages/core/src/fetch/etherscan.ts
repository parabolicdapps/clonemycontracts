import { fetchJson } from '../util/http.js';
import { CmcError, type Address, type Hex, type StdJsonInput, type VerifiedContract } from '../types.js';
import { emptyProxy, normaliseCompilerVersion, parseAbi, spdxFromSources } from './common.js';
import { isAddress, with0x } from '../util/hex.js';

export const ETHERSCAN_V2 = 'https://api.etherscan.io/v2/api';

/** Etherscan's `Library` field: `Name:0xaddr;Name2:0xaddr`. Unknown file -> empty-string key. */
export function parseLibraryField(s: string | undefined): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  if (!s) return out;
  for (const part of s.split(';')) {
    const [name, addr] = part.split(':').map((x) => x.trim());
    if (name && addr && isAddress(addr)) (out[''] ??= {})[name] = addr;
  }
  return out;
}

/**
 * Etherscan `SourceCode` comes in three shapes:
 *  1. single-file flattened source (plain text)
 *  2. standard JSON input wrapped in double braces `{{ ... }}`
 *  3. multi-file JSON map `{ "File.sol": { "content": "..." }, ... }`
 */
export function parseEtherscanSource(item: any): { std: StdJsonInput; shape: 'single' | 'standard-json' | 'multi-file' } {
  const src: string = item.SourceCode ?? '';
  const isVyper = String(item.CompilerVersion ?? '').toLowerCase().startsWith('vyper');
  const optimizer = { enabled: String(item.OptimizationUsed) === '1', runs: Number(item.Runs ?? 200) };
  const evm = item.EVMVersion && item.EVMVersion !== 'Default' ? String(item.EVMVersion) : undefined;
  const libraries = parseLibraryField(item.Library);
  const baseSettings = (): StdJsonInput['settings'] => ({
    optimizer,
    ...(evm ? { evmVersion: evm } : {}),
    libraries,
  });
  const trimmed = src.trim();
  if (trimmed.startsWith('{{') && trimmed.endsWith('}}')) {
    const std = JSON.parse(trimmed.slice(1, -1)) as StdJsonInput;
    std.settings ??= {};
    std.settings.libraries = { ...libraries, ...(std.settings.libraries ?? {}) };
    return { std, shape: 'standard-json' };
  }
  if (trimmed.startsWith('{')) {
    let parsed: any;
    try {
      parsed = JSON.parse(trimmed);
    } catch (e) {
      throw new CmcError(`Etherscan returned unparseable multi-file source: ${(e as Error).message}`, 'NETWORK');
    }
    // some multi-file replies are already full standard JSON (have `sources`), others are the bare file map
    if (parsed.sources && typeof parsed.sources === 'object') {
      const std = parsed as StdJsonInput;
      std.settings ??= baseSettings();
      return { std, shape: 'multi-file' };
    }
    return { std: { language: isVyper ? 'Vyper' : 'Solidity', sources: parsed, settings: baseSettings() }, shape: 'multi-file' };
  }
  const name = String(item.ContractName ?? 'Contract');
  return {
    std: { language: isVyper ? 'Vyper' : 'Solidity', sources: { [`${name}.${isVyper ? 'vy' : 'sol'}`]: { content: src } }, settings: baseSettings() },
    shape: 'single',
  };
}

export function normaliseEtherscan(item: any, chainId: number, address: Address): VerifiedContract {
  const { std } = parseEtherscanSource(item);
  const rawName = String(item.ContractName ?? 'Unknown');
  const name = rawName.includes(':') ? rawName.split(':').pop()! : rawName;
  const fqn = rawName.includes(':') ? rawName : null;
  const implementation = item.Implementation && isAddress(item.Implementation) ? (item.Implementation as Address) : null;
  const isProxy = String(item.Proxy) === '1' && !!implementation;
  const ctor = String(item.ConstructorArguments ?? '');
  const lic = String(item.LicenseType ?? '');
  return {
    address,
    chainId,
    name,
    fullyQualifiedName: fqn,
    compilerVersion: normaliseCompilerVersion(String(item.CompilerVersion ?? '')),
    language: String(item.CompilerVersion ?? '').toLowerCase().startsWith('vyper') ? 'Vyper' : 'Solidity',
    stdJsonInput: std,
    evmVersion: std.settings.evmVersion ?? (item.EVMVersion && item.EVMVersion !== 'Default' ? String(item.EVMVersion) : null),
    optimizer: {
      enabled: !!(std.settings.optimizer?.enabled ?? String(item.OptimizationUsed) === '1'),
      runs: Number(std.settings.optimizer?.runs ?? item.Runs ?? 200),
    },
    abi: parseAbi(item.ABI),
    constructorArgs: ctor ? (with0x(ctor) as Hex) : item.ConstructorArguments === '' ? ('0x' as Hex) : null,
    libraries: std.settings.libraries ?? {},
    creationTxHash: null,
    license: lic && lic !== 'Unknown' ? lic : spdxFromSources(std.sources),
    proxy: isProxy ? { isProxy: true, type: 'etherscan-flag', implementations: [implementation!] } : emptyProxy(),
    immutableReferences: {},
    matchType: null,
    provider: 'etherscan',
    attempts: [],
  };
}

export async function fetchEtherscan(chainId: number, address: Address, apiKey: string): Promise<VerifiedContract | null> {
  const url = `${ETHERSCAN_V2}?chainid=${chainId}&module=contract&action=getsourcecode&address=${address}&apikey=${encodeURIComponent(apiKey)}`;
  const res = await fetchJson<any>(url);
  if (!res) return null;
  if (res.status !== '1' || !Array.isArray(res.result) || !res.result[0]) {
    // rate-limit / plan messages come back in `result` as a string; never echo the key
    const msg = typeof res.result === 'string' ? res.result : res.message;
    throw new CmcError(`Etherscan: ${String(msg).replace(apiKey, '***')}`, 'NETWORK');
  }
  const item = res.result[0];
  if (!item.SourceCode) return null; // not verified
  return normaliseEtherscan(item, chainId, address);
}
