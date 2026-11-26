#!/usr/bin/env node
import { join } from 'node:path';
import { appPaths, configureRuntime, killActiveContainers, runtimeConfigFromEnv } from '@cmc/translate';
import { createApp } from './app.js';
import type { Guard } from './guard.js';
import { LocalGuard } from './local.js';

/**
 * Local engine. Binds 127.0.0.1 on a random port (CMC_PORT=<n> for development only) and prints ONE line on stdout for the shell that started it:
 *   {"port":54321,"token":"<per-launch secret>"}
 * Everything after that line on stdout is the secret-store channel (see secrets.ts) when CMC_SECRET_STORE=shell. Logs go to stderr.
 * The hosted (public) deployment policy is a separate module and only runs with CMC_HOSTED=1.
 */
const hosted = process.env.CMC_HOSTED === '1';
const paths = appPaths();
process.env.CMC_CACHE_DIR ??= join(paths.cache, 'solc'); // the compiler download cache of @cmc/core
configureRuntime(runtimeConfigFromEnv());

let guard: Guard;
let host = '127.0.0.1';
let port = Number(process.env.CMC_PORT ?? 0);
if (hosted) {
  const { HostedGuard, securityFromEnv } = await import('./hosted/index.js');
  host = process.env.CMC_HOST ?? '127.0.0.1';
  port = Number(process.env.CMC_PORT ?? 8795);
  const sec = securityFromEnv();
  try { HostedGuard.assertSafe(host, sec); } catch (e) { console.error((e as Error).message); process.exit(2); }
  guard = new HostedGuard({ security: sec });
} else {
  if (!Number.isInteger(port) || port < 0 || port > 65535) { console.error('CMC_PORT must be a port number, or unset for a random one'); process.exit(2); }
  guard = new LocalGuard();
}

const app = await createApp({ guard });
app.server.listen(port, host, () => {
  const addr = app.server.address();
  const actual = typeof addr === 'object' && addr ? addr.port : port;
  if (guard instanceof LocalGuard) process.stdout.write(`${JSON.stringify({ port: actual, token: guard.token })}\n`);
  else console.error(`CloneMyContracts (hosted mode) listening on http://${host}:${actual}/`);
});

let stopping = false;
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    if (stopping) return;
    stopping = true;
    console.error(`${sig}: shutting down`);
    const grace = Number(process.env.CMC_SHUTDOWN_GRACE_MS ?? 20_000);
    void app.shutdown(grace).then(() => killActiveContainers()).finally(() => process.exit(0));
  });
}
// the shell going away closes our stdin: stop rather than linger as an orphan (only when the shell channel is in use)
if (process.env.CMC_SECRET_STORE === 'shell' || process.env.CMC_EXIT_ON_STDIN_CLOSE === '1') process.stdin.on('end', () => process.kill(process.pid, 'SIGTERM'));
