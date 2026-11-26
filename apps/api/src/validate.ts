import { CmcError, getChain, unsupportedChainMessage, type ChainInfo, type Overrides } from '@cmc/core';
import { isAddress, getAddress } from 'viem';
import { HttpError, type FieldError } from './errors.js';

const bad = (message: string) => new HttpError(400, 'INPUT', message);

/** Run the field parsers in order, collect every failure and throw ONE 400 listing all of them: `{error:{code,message,fields:[{field,message}]}}`. */
function collect<T extends Record<string, unknown>>(steps: { [K in keyof T]: () => T[K] }): T {
  const out: Partial<T> = {};
  const fields: FieldError[] = [];
  for (const [field, run] of Object.entries(steps) as [keyof T & string, () => unknown][]) {
    try { (out as Record<string, unknown>)[field] = run(); } catch (e) {
      if (e instanceof HttpError && e.status === 400) fields.push({ field, message: e.message });
      else throw e;
    }
  }
  if (fields.length) throw new HttpError(400, 'INPUT', fields.map((f) => f.message).join('; '), {}, fields);
  return out as T;
}

export function asObject(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad('Request body must be a JSON object');
  return body as Record<string, unknown>;
}

/** Lower-case or correctly checksummed 0x address; a wrong mixed-case checksum is rejected. */
export function parseAddress(v: unknown, field = 'address'): `0x${string}` {
  if (typeof v !== 'string') throw bad(`${field} is required`);
  const s = v.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(s)) throw bad(`${field} must be a 0x address with 40 hex characters`);
  if (!isAddress(s, { strict: true })) throw bad(`${field} has an invalid checksum (mixed upper/lower case that does not match)`);
  return getAddress(s);
}

export function parseChain(v: unknown, field: string): ChainInfo {
  if (typeof v !== 'string' && typeof v !== 'number') throw bad(`${field} chain is required`);
  const s = String(v).trim();
  if (!/^[\w .-]{1,40}$/.test(s)) throw bad(`${field} is not a valid chain alias or id`);
  try {
    return getChain(s);
  } catch (e) {
    if (e instanceof CmcError) throw bad(`${field}: unknown chain "${s.slice(0, 40)}"; use a chain id or alias from GET /api/chains`);
    throw e;
  }
}

const MAX_OVERRIDES = 64;

/** Override keys: `argName`, `stepId.argName`, `0xADDRESS`, `evmVersion`. Values are strings (JSON text for compound types). */
export function parseOverrides(v: unknown): Overrides {
  if (v === undefined || v === null) return {};
  if (typeof v !== 'object' || Array.isArray(v)) throw bad('overrides must be an object of string values');
  const entries = Object.entries(v as Record<string, unknown>);
  if (entries.length > MAX_OVERRIDES) throw bad(`at most ${MAX_OVERRIDES} overrides`);
  const out: Overrides = {};
  for (const [k, val] of entries) {
    if (!/^[\w.$:\-]{1,120}$/.test(k)) throw bad(`override key "${k.slice(0, 40)}" is not valid`);
    if (typeof val !== 'string' || val.length > 4000) throw bad(`override "${k}" must be a string of at most 4000 characters`);
    if (/^0x[0-9a-fA-F]{40}$/.test(k) && !isAddress(k, { strict: true })) throw bad(`override key ${k} has an invalid address checksum`);
    out[k] = val;
  }
  return out;
}

export function parseDeployed(v: unknown): Record<string, `0x${string}`> {
  if (v === undefined || v === null) return {};
  if (typeof v !== 'object' || Array.isArray(v)) throw bad('deployed must be an object of step id to address');
  const out: Record<string, `0x${string}`> = {};
  const entries = Object.entries(v as Record<string, unknown>);
  if (entries.length > 64) throw bad('too many deployed entries');
  for (const [k, a] of entries) {
    if (!/^[\w.:$\-]{1,120}$/.test(k)) throw bad('deployed step id is not valid');
    out[k] = parseAddress(a, `deployed.${k}`);
  }
  return out;
}

/** Step ids of call steps (admin/initialise) the browser has already sent; later steps may depend on them. */
export function parseCompleted(v: unknown): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > 64) throw bad('completed must be a list of step ids');
  return v.map((x) => {
    if (typeof x !== 'string' || !/^[\w.:$\-]{1,120}$/.test(x)) throw bad('completed step id is not valid');
    return x;
  });
}

export const parseDeployer = (v: unknown): `0x${string}` | undefined => (v === undefined || v === null || v === '' ? undefined : parseAddress(v, 'deployer'));

export interface CloneRequest {
  address: `0x${string}`;
  from: ChainInfo;
  to: ChainInfo;
  overrides: Overrides;
}

export function parseInspect(body: unknown): { address: `0x${string}`; from: ChainInfo } {
  const b = asObject(body);
  const r = collect({ address: () => parseAddress(b.address), from: () => parseChain(b.from, 'from') });
  assertChainSupported(r.from);
  return r;
}

/** The one rule for chains that cannot be used: the same 422 UNSUPPORTED and message on every endpoint. */
export function assertChainSupported(chain: ChainInfo): void {
  if (chain.kind !== 'evm') throw new CmcError(unsupportedChainMessage(chain), 'UNSUPPORTED');
}

export function parseClone(body: unknown): CloneRequest {
  const b = asObject(body);
  const r = collect({
    address: () => parseAddress(b.address),
    from: () => parseChain(b.from, 'from'),
    to: () => parseChain(b.to, 'to'),
    overrides: () => parseOverrides(b.overrides),
  });
  if (r.from.chainId === r.to.chainId) throw new HttpError(400, 'INPUT', 'from and to must be different chains (a clone needs another chain to land on)', {}, [{ field: 'to', message: 'from and to must be different chains' }]);
  assertChainSupported(r.from);
  assertChainSupported(r.to);
  return r;
}

export function parseRewrite(body: unknown, targetIds: string[]): { address: `0x${string}`; from: ChainInfo; to: string; rights: boolean } {
  const b = asObject(body);
  const r = collect({
    address: () => parseAddress(b.address),
    from: () => parseChain(b.from, 'from'),
    to: () => {
      const to = typeof b.to === 'string' ? b.to.trim().toLowerCase() : '';
      if (!to) throw bad(`to is required: one of ${targetIds.join(', ')}`);
      if (!targetIds.includes(to)) throw bad(`to must be one of: ${targetIds.join(', ')}`);
      return to;
    },
  });
  assertChainSupported(r.from);
  return { ...r, rights: b.rights === true };
}
