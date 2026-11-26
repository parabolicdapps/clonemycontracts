import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { compileWithAst, stdInputForSource, DEFAULT_SOLC } from '../src/spec/compile.js';
import { extractSpec } from '../src/spec/extract.js';

export const fixture = (name: string) => new URL(`./fixtures/${name}.sol`, import.meta.url).pathname;
export async function load(name: string) {
  const file = fixture(name);
  const c = await compileWithAst({ compilerVersion: DEFAULT_SOLC, stdJsonInput: stdInputForSource(`${name}.sol`, readFileSync(file, 'utf8')), contract: name });
  return { c, spec: extractSpec(c, { file: `${name}.sol` }) };
}
export const hasAnvil = existsSync(join(homedir(), '.foundry', 'bin', 'anvil')) || !!process.env.CMC_ANVIL;
