/**
 * The core words its notes and errors for the command line (`--set name=value`, `cmc chains`). The HTTP API says which JSON field or
 * endpoint to use instead. Every human-readable string that leaves the API goes through here, so no response mentions a flag or a command.
 */
const BRACKET = (s: string) => s.replace(/^<(.*)>$/, '$1');

export function apiText(s: string): string {
  return s
    .replace(/Run `cmc chains` to list supported chains\./g, 'GET /api/chains lists the supported chains.')
    .replace(/\(--set <name>=deployer uses the deploying account\)/g, '("deployer" as the override value uses the deploying account)')
    .replace(/pass --set <name>=<value>; owner\/admin\/role addresses accept "deployer"/g, 'give it in "overrides" as {"<name>": "<value>"}; owner/admin/role addresses accept "deployer"')
    .replace(/--set <arg>=<address> or --set <arg>=deployer/g, '"overrides": {"<arg>": "<address>"} (or "deployer" as the value)')
    .replace(/pass --set <name>=deployer to use the deploying account/g, 'use "deployer" as the override value for the deploying account')
    .replace(/pass --set or --keep-unresolved/g, 'give a value in "overrides"')
    .replace(/ or --keep-unresolved/g, '')
    .replace(/--set ([\w.$:#\-]+)=(\S+?)(?=:?(?:[;,)]|\s|$))/g, (_m, k: string, v: string) => `"overrides" {"${k}": "${BRACKET(v)}"}`)
    .replace(/--set ([\w.$:#\-]+)/g, (_m, k: string) => `"overrides" key "${k}"`)
    .replace(/\bpass --set\b/g, 'pass "overrides"')
    .replace(/supplied with --set/g, 'supplied in "overrides"')
    .replace(/with --set\b/g, 'in "overrides"')
    .replace(/Use the cmc CLI\./g, 'Use the cmc command line tool.')
    .replace(/--create2\/--create3/g, 'CREATE2/CREATE3')
    .replace(/--create3/g, 'CREATE3')
    .replace(/--create2/g, 'CREATE2');
}

const SKIP_KEYS = new Set(['stdJsonInput', 'sources', 'content', 'abi', 'abiParam', 'original', 'value']);

/** `apiText` over the human-readable strings of a plan/analysis/summary (never over source code, ABI or values). */
export function apiDeep<T>(v: T): T {
  if (typeof v === 'string') return apiText(v) as unknown as T;
  if (Array.isArray(v)) return v.map((x) => apiDeep(x)) as unknown as T;
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = SKIP_KEYS.has(k) ? x : apiDeep(x);
    return out as T;
  }
  return v;
}
