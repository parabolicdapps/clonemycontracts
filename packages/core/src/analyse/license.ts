import type { CloneAnalysis, LicenseClass } from '../types.js';

const word = (s: string, ...xs: string[]) => xs.some((x) => new RegExp(`(^|[^a-z0-9])${x}([^a-z0-9]|$)`).test(s));

/** Class of one licence name or SPDX expression. `A OR B` is the licensee's choice (least restrictive), `A AND B` binds to both (most restrictive). */
export function classifyLicense(raw: string | null): { id: string | null; class: LicenseClass } {
  if (!raw) return { id: null, class: 'none-or-unknown' };
  const id = raw.trim();
  if (!id) return { id: null, class: 'none-or-unknown' };
  const expr = id.replace(/[()]/g, ' ');
  if (/\s(OR|AND)\s/.test(expr)) {
    const isOr = /\sOR\s/.test(expr) && !/\sAND\s/.test(expr);
    const parts = expr.split(/\s+(?:OR|AND)\s+/).map((p) => classifySingle(p.trim()));
    const pick = isOr ? [...parts].sort((a, b) => RANK[a] - RANK[b])[0]! : [...parts].sort((a, b) => RANK[b] - RANK[a])[0]!;
    return { id, class: pick };
  }
  return { id, class: classifySingle(id) };
}

function classifySingle(id: string): LicenseClass {
  const s = id.toLowerCase();
  const has = (...xs: string[]) => xs.some((x) => s.includes(x));
  if (has('busl', 'business source', 'bsl', 'proprietary', 'see license in', 'all rights reserved', 'commercial', 'sspl', 'polyform', 'cc-by-nc', 'prosperity')) return 'restricted';
  if (s === 'none' || has('unlicensed', 'no license')) return 'none-or-unknown';
  if (has('gpl', 'agpl', 'lgpl', 'gnu', 'mpl', 'mozilla', 'epl', 'eclipse', 'eupl', 'cc-by-sa', 'osl', 'cddl')) return 'copyleft';
  if ((word(s, 'mit') || has('apache', 'bsd', 'unlicense', 'cc0', 'zlib', 'public domain') || word(s, 'isc')) && !has('unlicensed')) return 'permissive';
  return 'none-or-unknown';
}

/** Higher = more restrictive. An explicit "no licence" (UNLICENSED) is stricter than copyleft; a source-available licence (BUSL) is stricter still. */
export const RANK: Record<LicenseClass, number> = { permissive: 0, copyleft: 1, 'none-or-unknown': 2, restricted: 3 };

export interface LicenseEntry { id: string; class: LicenseClass }

/** The most restrictive of several licences (ties: the first). */
export function mostRestrictive(entries: LicenseEntry[]): LicenseEntry | null {
  let best: LicenseEntry | null = null;
  for (const e of entries) if (!best || RANK[e.class] > RANK[best.class]) best = e;
  return best;
}

/** `MIT License (MIT)` / `GNU GPLv3 (GPL-3.0)` (Etherscan) -> the SPDX id in brackets; `No License (None)` -> null. */
export function normaliseProviderLicense(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const t = raw.trim();
  if (!t || /^(unknown|none|n\/a)$/i.test(t) || /no license \(none\)/i.test(t)) return null;
  const m = /\(([A-Za-z0-9][A-Za-z0-9.+\-]*)\)\s*$/.exec(t);
  if (m && /[A-Za-z]/.test(m[1]!) && !/^none$/i.test(m[1]!)) return m[1]!;
  return t;
}

/** The SPDX tag in a source file: any comment line, anywhere in the file (large files often carry the tag after a long copyright block). */
export function spdxInSource(content: string): string | null {
  const m = /^[ \t]*(?:\/\/+|\/\*+|\*|#)[ \t]*SPDX-License-Identifier:[ \t]*([^\r\n]*)/im.exec(content);
  if (!m) return null;
  const id = m[1]!.replace(/\*\/.*$/, '').replace(/[ \t*]+$/, '').trim();
  return id || null;
}

const HEADER_TEXTS: [RegExp, string][] = [
  [/Business Source License|\bLicensed Work\b/i, 'BUSL-1.1'],
  [/GNU Affero General Public License/i, 'AGPL-3.0'],
  [/GNU Lesser General Public License/i, 'LGPL-3.0'],
  [/GNU General Public License/i, 'GPL-3.0'],
  [/Mozilla Public License/i, 'MPL-2.0'],
  [/Apache License,?\s*(?:Version|v\.?)\s*2\.0|Licensed under the Apache License/i, 'Apache-2.0'],
  [/Permission is hereby granted, free of charge/i, 'MIT'],
  [/Redistribution and use in source and binary forms/i, 'BSD-3-Clause'],
  [/This is free and unencumbered software released into the public domain/i, 'Unlicense'],
];

/** A well-known licence notice in the file header, for files that carry no SPDX tag. Looks at the first ~8 kB only. */
export function licenseFromHeaderText(content: string): string | null {
  const head = content.slice(0, 8000);
  for (const [re, id] of HEADER_TEXTS) {
    if (!re.test(head)) continue;
    if (id === 'GPL-3.0' || id === 'AGPL-3.0' || id === 'LGPL-3.0') {
      const v = /version\s+([23])\b/i.exec(head.slice(Math.max(0, head.search(re)), head.search(re) + 400));
      if (v?.[1] === '2') return id.replace('-3.0', '-2.0');
    }
    return id;
  }
  if (/all rights reserved/i.test(head)) return 'All rights reserved';
  return null;
}

export interface DetectedLicenses {
  /** distinct licence ids in order of first appearance, the preferred (main) file first */
  ids: string[];
  /** file -> id for every file that declares one */
  byFile: Record<string, string>;
}

/** SPDX tags and well-known header texts of every source file. Files with no licence information are ignored. */
export function detectSourceLicenses(sources: Record<string, { content: string }>, preferFile?: string | null): DetectedLicenses {
  const order = preferFile && sources[preferFile] ? [preferFile, ...Object.keys(sources).filter((f) => f !== preferFile)] : Object.keys(sources);
  const byFile: Record<string, string> = {};
  const ids: string[] = [];
  for (const f of order) {
    const content = sources[f]?.content ?? '';
    const id = spdxInSource(content) ?? licenseFromHeaderText(content);
    if (!id) continue;
    byFile[f] = id;
    if (!ids.includes(id)) ids.push(id);
  }
  return { ids, byFile };
}

/** Every licence a verified contract declares: the provider's field and the files' own tags/headers. */
export function contractLicenseIds(vc: { license: string | null; stdJsonInput: { sources: Record<string, { content: string }> }; fullyQualifiedName?: string | null }): string[] {
  const main = vc.fullyQualifiedName ? vc.fullyQualifiedName.split(':')[0] : null;
  const ids = detectSourceLicenses(vc.stdJsonInput.sources ?? {}, main).ids;
  const prov = normaliseProviderLicense(vc.license);
  if (prov && !ids.some((i) => i.toLowerCase() === prov.toLowerCase())) ids.push(prov);
  return ids;
}

/** One licence verdict for a set of ids: the most restrictive wins (`id`); `ids` lists every distinct licence. */
export function summariseLicenseIds(ids: string[]): { id: string | null; class: LicenseClass; ids: string[] } {
  if (!ids.length) return { id: null, class: 'none-or-unknown', ids: [] };
  const entries = ids.map((id) => ({ id, class: classifyLicense(id).class }));
  const worst = mostRestrictive(entries)!;
  return { id: worst.id, class: worst.class, ids };
}

export function licenseWarning(c: LicenseClass, id: string | null): string | null {
  switch (c) {
    case 'copyleft': return `Source is ${id} (copyleft): redeploying/modifying may oblige you to publish your source under the same licence.`;
    case 'restricted': return `Source is ${id}: a restricted/source-available licence. You need the rights holder's permission to deploy a clone (e.g. BUSL usually forbids production use).`;
    case 'none-or-unknown': return `No usable licence found${id ? ` (${id})` : ''}: all rights are reserved by default. Confirm you may deploy this code.`;
    default: return null;
  }
}

export const isLicenseWarning = (w: string) => /^(?:[^:]+: )?(?:Source is .+ \((?:copyleft)\)|Source is .+ a restricted\/source-available licence|No usable licence found)/.test(w);

export type LicenseRole = 'contract' | 'proxy' | 'implementation' | 'beacon' | 'library';
export interface ContractLicense { role: LicenseRole; name: string; address: string; id: string | null; ids: string[]; class: LicenseClass }
export interface LicenseReport {
  /** the most restrictive declared licence of the whole plan */
  overall: { id: string | null; class: LicenseClass; ids: string[] };
  contracts: ContractLicense[];
}

/** A licence per contract of the clone (proxy, implementation, beacon, libraries) and the most restrictive one overall. */
export function licenseReport(a: CloneAnalysis): LicenseReport {
  const contracts: ContractLicense[] = [];
  const seen = new Set<string>();
  const add = (role: LicenseRole, an: CloneAnalysis) => {
    const k = `${role}:${an.contract.address.toLowerCase()}`;
    if (seen.has(k)) return;
    seen.add(k);
    const ids = an.license.ids ?? (an.license.id ? [an.license.id] : []);
    contracts.push({ role, name: an.contract.name, address: an.contract.address, id: an.license.id, ids, class: an.license.class });
  };
  const addLibs = (an: CloneAnalysis) => {
    for (const l of an.libraryLicenses ?? []) {
      const k = `library:${l.address.toLowerCase()}`;
      if (seen.has(k)) continue;
      seen.add(k);
      contracts.push({ role: 'library', name: l.name, address: l.address, id: l.id, ids: l.ids, class: l.class });
    }
  };
  add(a.implementation ? 'proxy' : 'contract', a);
  addLibs(a);
  if (a.implementation) { add('implementation', a.implementation); addLibs(a.implementation); }
  if (a.beacon) { add('beacon', a.beacon); addLibs(a.beacon); }
  return { overall: overallOf(contracts), contracts };
}

/** Contracts that declare no licence at all do not decide the verdict when another contract of the plan declares one (a bare proxy shell next to a licensed implementation). */
export function overallOf(contracts: { id: string | null; ids: string[]; class: LicenseClass }[]): LicenseReport['overall'] {
  const declared = contracts.filter((c) => c.ids.length);
  if (!declared.length) return { id: null, class: 'none-or-unknown', ids: [] };
  const worst = mostRestrictive(declared.map((c) => ({ id: c.id!, class: c.class })))!;
  const ids = [...new Set(declared.flatMap((c) => c.ids))];
  return { id: worst.id, class: worst.class, ids };
}

/** One warning per contract whose licence is not plainly permissive; undeclared contracts are only mentioned when nothing declares a licence. */
export function licenseWarnings(report: LicenseReport): string[] {
  const out: string[] = [];
  const anyDeclared = report.contracts.some((c) => c.ids.length);
  for (const c of report.contracts) {
    if (!c.ids.length && anyDeclared) continue;
    const w = licenseWarning(c.class, c.id);
    if (w) out.push(report.contracts.length > 1 ? `${c.name} (${c.role}): ${w}` : w);
  }
  return out;
}
