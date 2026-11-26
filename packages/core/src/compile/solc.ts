import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fetchBuffer, fetchJson } from '../util/http.js';
import { CmcError } from '../types.js';

const require = createRequire(import.meta.url);
const BASE = 'https://binaries.soliditylang.org/bin';

export function cacheDir(): string {
  return process.env.CMC_CACHE_DIR ?? join(homedir(), '.cache', 'clonemycontracts', 'solc');
}

interface Build { path: string; version: string; longVersion: string; sha256: string }

async function loadList(dir: string): Promise<Build[]> {
  const f = join(dir, 'list.json');
  // refresh daily; fall back to a stale copy if offline
  try {
    if (existsSync(f)) {
      const age = Date.now() - (await import('node:fs')).statSync(f).mtimeMs;
      if (age < 86_400_000) return JSON.parse(await readFile(f, 'utf8')).builds;
    }
    const list = await fetchJson<{ builds: Build[] }>(`${BASE}/list.json`, { timeoutMs: 120_000 });
    if (list) {
      await writeFile(f, JSON.stringify(list));
      return list.builds;
    }
  } catch (e) {
    if (existsSync(f)) return JSON.parse(await readFile(f, 'utf8')).builds;
    throw e;
  }
  throw new CmcError('Could not load the solc release list', 'NETWORK');
}

/** Path of a verified soljson build for `0.8.20+commit.a1b79de6`, downloading + sha256-checking if needed. */
export async function ensureSolcBinary(longVersion: string): Promise<string> {
  const dir = cacheDir();
  await mkdir(dir, { recursive: true });
  const lv = longVersion.replace(/^v/, '');
  const builds = await loadList(dir);
  const b = builds.find((x) => x.longVersion === lv) ?? builds.find((x) => x.version === lv.split('+')[0] && lv.includes('+') === false);
  if (!b) throw new CmcError(`solc ${lv} is not in the official release list (nightly/unknown build) - unsupported`, 'UNSUPPORTED');
  const file = join(dir, b.path);
  const expected = b.sha256.replace(/^0x/, '').toLowerCase();
  if (existsSync(file)) {
    const have = createHash('sha256').update(await readFile(file)).digest('hex');
    if (have === expected) return file;
  }
  const buf = await fetchBuffer(`${BASE}/${b.path}`);
  const got = createHash('sha256').update(buf).digest('hex');
  if (got !== expected) throw new CmcError(`sha256 mismatch for ${b.path}: expected ${expected}, got ${got}`, 'COMPILE');
  const tmp = `${file}.tmp`;
  await writeFile(tmp, buf);
  await rename(tmp, file);
  return file;
}

const compilers = new Map<string, any>();

export async function loadSolc(longVersion: string): Promise<{ compile(input: string): string }> {
  const cached = compilers.get(longVersion);
  if (cached) return cached;
  const file = await ensureSolcBinary(longVersion);
  const wrapper = require('solc/wrapper');
  const soljson = require(file);
  const solc = wrapper(soljson);
  compilers.set(longVersion, solc);
  return solc;
}
