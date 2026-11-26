// usage: node gen-aptos-api.mjs <dir with aptos-framework/sources aptos-stdlib/sources move-stdlib/sources ...> <out.json>
// Extracts the public function signatures of the vendored Aptos framework sources (tag aptos-cli-v9.6.0) so the pack never relies on memory.
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const files = [];
const walk = (d) => { for (const e of readdirSync(d)) { const p = join(d, e); statSync(p).isDirectory() ? walk(p) : p.endsWith('.move') && files.push(p); } };
walk(process.argv[2]);
const splitTop = (s) => { const out = []; let depth = 0, cur = ''; for (const ch of s) { if ('<(['.includes(ch)) depth++; if ('>)]'.includes(ch)) depth--; if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch; } if (cur.trim()) out.push(cur.trim()); return out; };
const KEEP = new Set(['std::signer', 'std::string', 'std::vector', 'std::option', 'std::error', 'std::bcs', 'std::debug', 'aptos_std::table', 'aptos_std::smart_table', 'aptos_std::string_utils', 'aptos_std::simple_map', 'aptos_std::math64', 'aptos_std::math128', 'aptos_framework::account', 'aptos_framework::aptos_account', 'aptos_framework::aptos_coin', 'aptos_framework::coin', 'aptos_framework::event', 'aptos_framework::fungible_asset', 'aptos_framework::object', 'aptos_framework::primary_fungible_store', 'aptos_framework::timestamp', 'aptos_token_objects::collection', 'aptos_token_objects::token', 'aptos_token_objects::royalty']);
const api = {};
for (const f of files) {
  if (/\/tests?\//.test(f)) continue;
  const src = readFileSync(f, 'utf8').replace(/\/\/[^\n]*/g, '');
  const mod = /module\s+(\w+)::(\w+)/.exec(src);
  if (!mod) continue;
  const name = `${mod[1]}::${mod[2]}`;
  if (!KEEP.has(name)) continue;
  const re = /((?:#\[[^\]]*\]\s*)*)\s*public(\((?:friend|package)\))?\s+((?:entry|native|inline)\s+)*fun\s+(\w+)\s*(<[^>(]*>)?\s*\(([^)]*)\)\s*(?::\s*([^{;]+?))?\s*(?:acquires[^{;]*)?\s*[{;]/gs;
  let m;
  while ((m = re.exec(src))) {
    if (m[2]) continue;
    const attrs = m[1] ?? '';
    const testOnly = /#\[(test_only|test)\b/.test(attrs);
    const params = splitTop(m[6].replace(/\s+/g, ' '));
    (api[name] ??= {})[m[4]] = { sig: `fun ${m[4]}${m[5] ?? ''}(${params.join(', ')})${m[7] ? `: ${m[7].replace(/\s+/g, ' ').trim()}` : ''}`, arity: params.length, entry: /entry/.test(m[3] ?? ''), view: /#\[view\]/.test(attrs), ...(testOnly ? { testOnly: true } : {}) };
  }
}
writeFileSync(process.argv[3], JSON.stringify(api, null, 1) + '\n');
console.log(`${Object.keys(api).length} modules, ${Object.values(api).reduce((a, m) => a + Object.keys(m).length, 0)} public functions`);
