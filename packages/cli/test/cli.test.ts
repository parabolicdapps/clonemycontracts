import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const run = (...args: string[]) => spawnSync('node', [new URL('../dist/main.js', import.meta.url).pathname, ...args], { encoding: 'utf8' });

describe('cmc cli (offline paths)', () => {
  it('lists chains', () => {
    const r = run('chains');
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/base-sepolia/);
    expect(JSON.parse(run('chains', '--json').stdout).length).toBeGreaterThan(11);
  });
  it('usage errors exit 2', () => {
    expect(run('inspect').status).toBe(2);
    expect(run('inspect', '0x6B175474E89094C44Da98b954EedeAC495271d0F').status).toBe(2);
    expect(run('inspect', '0x6B175474E89094C44Da98b954EedeAC495271d0F', '--from', 'nochain').status).toBe(2);
    expect(run('bogus').status).toBe(2);
  });
});
