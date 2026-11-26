/** Strict `=== FILE: path ===` ... `=== END FILE ===` output format shared by all targets. */
export const FILE_FORMAT = `Output format (strict). Emit every project file as a block, nothing else outside the blocks except brief notes before the first block:

=== FILE: relative/path/file.ext ===
<complete file content, no markdown fences>
=== END FILE ===

Rules: paths are relative to the project root; no absolute paths, no '..'. Do not wrap file content in \`\`\` fences.`;

const FILE_RE = /^=== FILE: (.+?) ===[ \t]*\n([\s\S]*?)\n=== END FILE ===[ \t]*$/gm;

export function parseFiles(text: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const m of text.matchAll(FILE_RE)) {
    const p = m[1]!.trim().replace(/^`|`$/g, '');
    let body = m[2]!;
    body = body.replace(/^```[a-zA-Z0-9]*\n/, '').replace(/\n```\s*$/, '');
    if (!p || p.startsWith('/') || p.split('/').includes('..')) continue;
    files[p] = body + '\n';
  }
  return files;
}

/** Notes the model wrote outside the file blocks (e.g. the fidelity notes). */
export function textOutsideFiles(text: string): string {
  return text.replace(FILE_RE, '').trim();
}
