import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHAINS } from '@cmc/core';
import { coreBackend, type Backend } from './backend.js';
import { errorBody, HttpError, toHttpError } from './errors.js';
import { JobManager } from './jobs.js';
import { buildPayload } from './payload.js';
import { assertPlannable, slimAnalysis, slimPlan, summarise, supportError, Service } from './service.js';
import { apiDeep } from './surface.js';
import { parseRewrite, parseClone, parseCompleted, parseDeployed, parseDeployer, parseInspect, asObject } from './validate.js';
import { assertSupportedSource, UnsupportedSourceError } from '@cmc/translate';
import { createRewriteBackend, plainRewriteError, SpecMismatch, TARGET_IDS, type RewriteBackend } from './rewrite.js';
import { zipDirectory } from './zip.js';
import type { Guard } from './guard.js';
import { LocalGuard } from './local.js';
import { createSecretStore } from './secrets.js';
import { SettingsService, SettingsStore } from './settings.js';
import { PullManager, realRuntimeService, type RuntimeService } from './runtime-service.js';
import { settingsRoutes } from './settings-routes.js';
import { appPaths } from '@cmc/translate';

const here = dirname(fileURLToPath(import.meta.url));

export interface AppOptions {
  backend?: Backend;
  webDir?: string;
  dataDir?: string;
  maxSimulations?: number;
  bodyLimit?: number;
  /** the rewrite pipeline (default: the real one, driven by the settings); null disables rewrites */
  rewrite?: RewriteBackend | null;
  maxRewrites?: number;
  rewriteTimeoutMs?: number;
  /** ms a rewrite plan may take before the answer is 202 pending (the plan keeps computing and is cached) */
  rewritePlanWaitMs?: number;
  /** ms before a heavy request gets 408 */
  requestTimeout?: number;
  /** access-control policy; default: a LocalGuard (loopback, per-launch token). The hosted policy lives in ./hosted and is opt-in. */
  guard?: Guard;
  /** provider settings + keys; default: the app's config directory and the platform secret store */
  settings?: SettingsService;
  /** container runtime status / image downloads; default: the real runtime */
  runtime?: RuntimeService;
  /** one structured line per request; default: none (stderr JSON when CMC_ACCESS_LOG=1) */
  log?: ((line: string) => void) | null;
}

export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "require-trusted-types-for 'script'",
].join('; ');

const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy': CSP,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
};

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon', '.png': 'image/png', '.map': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json',
};

const HEAVY = new Set(['/api/rewrite', '/api/rewrite/plan', '/api/inspect', '/api/inspect-job', '/api/recompile', '/api/plan', '/api/simulate', '/api/project', '/api/deploy-payload']);

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const data = Buffer.from(JSON.stringify(apiDeep(body)));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': data.length, 'Cache-Control': 'no-store', ...headers });
  res.end(data);
}

async function readJson(req: IncomingMessage, limit: number): Promise<unknown> {
  const ct = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
  if (ct !== 'application/json') throw new HttpError(415, 'INPUT', 'Content-Type must be application/json');
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > limit) throw new HttpError(413, 'INPUT', `Request body is larger than ${limit} bytes`);
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > limit) throw new HttpError(413, 'INPUT', `Request body is larger than ${limit} bytes`);
    chunks.push(c as Buffer);
  }
  if (!n) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'INPUT', 'Request body is not valid JSON'); }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: NodeJS.Timeout;
  const timeout = new Promise<never>((_, rej) => { t = setTimeout(() => rej(new HttpError(408, 'TIMEOUT', 'The request took too long; try again')), ms); });
  return Promise.race([p, timeout]).finally(() => clearTimeout(t));
}

/** HTTP status of a rewrite pipeline error code: the caller's input or the contract is 422, an unreachable service is 424 (never 502/503/504: Cloudflare replaces those bodies), everything else is a 500. */
function rewriteStatus(code: string): number {
  if (code === 'INPUT' || code === 'UNVERIFIED' || code === 'UNSUPPORTED' || code === 'COMPILE') return 422;
  if (code === 'MODEL' || code === 'SANDBOX' || code === 'NETWORK' || code === 'RPC' || code === 'DEPLOY') return 424;
  return 500;
}

/** Limits of the rewrite pipeline beyond the general analysis (Vyper/Yul, Solidity before 0.4.12): the pipeline's own rule, as a typed error. */
function rewriteLimits(a: import('@cmc/core').CloneAnalysis): string[] {
  try { assertSupportedSource(a.contract.language, a.contract.compilerVersion); return []; } catch (e) {
    if (e instanceof UnsupportedSourceError) return [`${e.message} (cloning supports Solidity 0.4.11 and newer; rewriting needs 0.4.12 or newer)`];
    throw e;
  }
}

function noProjectMessage(job: import('./jobs.js').Job | undefined, fallback: string): string {
  if (job?.kind === 'rewrite' && job.status === 'done' && job.result && !job.result.hasProject) return 'This rewrite produced no project: the contract could not be analysed reliably (its extracted spec disagrees with its ABI), so nothing was generated.';
  return fallback;
}

export interface App {
  server: Server;
  jobs: JobManager;
  close(): Promise<void>;
  /** stop accepting connections, cancel queued jobs, abort running rewrites, wait up to graceMs for simulations, then close */
  shutdown(graceMs?: number): Promise<void>;
}

export async function createApp(opts: AppOptions = {}): Promise<App> {
  const paths = appPaths();
  const webDir = resolve(opts.webDir ?? process.env.CMC_WEB_DIR ?? join(here, '../../web/dist'));
  const dataDir = resolve(opts.dataDir ?? join(paths.data, 'jobs-store'));
  const bodyLimit = opts.bodyLimit ?? 64 * 1024;
  const timeout = opts.requestTimeout ?? 170_000;
  const planWaitMs = opts.rewritePlanWaitMs ?? Number(process.env.CMC_REWRITE_PLAN_WAIT_MS ?? 25_000);
  const guard: Guard = opts.guard ?? new LocalGuard();
  const logLine = opts.log !== undefined ? opts.log : process.env.CMC_ACCESS_LOG === '1' ? (l: string) => process.stderr.write(`${l}\n`) : null;
  const csp = guard.csp(CSP);
  const settings = opts.settings ?? new SettingsService(new SettingsStore(paths.config), createSecretStore({ configDir: paths.config }), paths);
  const runtime = opts.runtime ?? realRuntimeService;
  const pulls = new PullManager(runtime);
  const backend = opts.backend ?? coreBackend;
  const service = new Service(backend);
  const rewriteBackend = opts.rewrite === undefined ? createRewriteBackend({ settings }) : opts.rewrite;
  const jobs = new JobManager(service, dataDir, opts.maxSimulations ?? Number(process.env.CMC_MAX_SIM ?? 2),
    rewriteBackend ? { backend: rewriteBackend, max: opts.maxRewrites ?? Number(process.env.CMC_MAX_REWRITES ?? 1), timeoutMs: opts.rewriteTimeoutMs ?? Number(process.env.CMC_REWRITE_TIMEOUT_MS ?? 30 * 60_000) } : null,
    guard.caps);
  await jobs.load();
  const subjects = { get: (req: IncomingMessage) => guard.subjectOf(req) };

  const chains = CHAINS.map((c) => ({
    chainId: c.chainId, name: c.name, alias: c.alias, testnet: c.testnet, kind: c.kind, supported: c.kind === 'evm',
    nativeCurrency: c.nativeCurrency, rpcUrls: c.rpcUrls.slice(0, 3), explorer: c.explorer.url ? { name: c.explorer.name, url: c.explorer.url } : null,
  }));

  const sse = (req: IncomingMessage, res: ServerResponse, job: { id: string; snapshot: () => unknown; terminal: () => boolean }, mgr: PullManager) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const write = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(apiDeep(data))}\n\n`);
    write('progress', job.snapshot());
    if (job.terminal()) { write('done', job.snapshot()); return void res.end(); }
    const onEvent = (event: string, data: unknown) => { write(event, data); if (event === 'done') { cleanup(); res.end(); } };
    const hb = setInterval(() => res.write(': keep-alive\n\n'), 15_000);
    const cleanup = () => { clearInterval(hb); mgr.off(job.id, onEvent); };
    mgr.on(job.id, onEvent);
    req.on('close', cleanup);
  };

  async function api(req: IncomingMessage, res: ServerResponse, path: string, url: URL) {
    const ip = guard.clientOf(req);
    guard.apiGate(req, path);

    if (req.method === 'GET' && path === '/api/config') return send(res, 200, guard.publicConfig());
    if (await settingsRoutes({ settings, runtime, pulls, send, readJson: (r) => readJson(r, bodyLimit), sse }, req, res, path)) return;
    if (req.method === 'GET' && path === '/api/chains') return send(res, 200, { chains });
    if (req.method === 'GET' && path === '/api/targets') return send(res, 200, { targets: rewriteBackend ? rewriteBackend.targets() : [] });
    if (req.method === 'GET' && path === '/api/rewrite/health') {
      if (!rewriteBackend) return send(res, 200, { ok: false, model: { ok: false, message: 'Rewrites are not enabled on this server.' }, sandbox: { ok: false, message: '' }, images: {} });
      return send(res, 200, await withTimeout(rewriteBackend.health(), 20_000));
    }

    if (req.method === 'POST' || req.method === 'DELETE') {
      if (req.method === 'DELETE') {
        const dm = /^\/api\/jobs\/([0-9a-f-]{36})$/.exec(path);
        if (!dm) throw new HttpError(404, 'NOT_FOUND', 'No such route');
        const job = jobs.cancel(dm[1]!, ip);
        return send(res, 200, { job: jobs.view(job) });
      }
    }
    if (req.method === 'POST') {
      if (!HEAVY.has(path)) throw new HttpError(404, 'NOT_FOUND', 'No such route');
      const body = await readJson(req, bodyLimit);
      if (path === '/api/rewrite' || path === '/api/rewrite/plan') {
        if (!rewriteBackend) throw new HttpError(424, 'UNAVAILABLE', 'Rewrites are not enabled on this server.');
        const rr = parseRewrite(body, TARGET_IDS);
        const rq = { address: rr.address, from: rr.from.alias, to: rr.to };
        const planKey = `rwplan:${rr.address.toLowerCase()}:${rr.from.chainId}:${rr.to}`;
        const refuse = (e: SpecMismatch) => new HttpError(422, 'SPEC_MISMATCH', e.message, {}, undefined, { problems: e.problems });
        // one support rule for every rewrite endpoint, decided from the inspected contract (language, compiler version) before the pipeline is touched
        const checkSupport = async () => {
          const analysis = await withTimeout(service.analyse(rr.address, rr.from), timeout);
          const sum = summarise(analysis, rr.from);
          const limits = rewriteLimits(analysis);
          const reasons = [...sum.unsupported.filter((u) => !(limits.length && /predates the standard JSON/.test(u))), ...limits];
          if (reasons.length) throw supportError(reasons);
          return sum;
        };
        const planned = async () => {
          try {
            return await withTimeout(service.memo(planKey, () => rewriteBackend.plan(rq, rr.from.chainId)), timeout);
          } catch (e) {
            if (e instanceof HttpError) throw e;
            if (e instanceof SpecMismatch) throw refuse(e);
            const pe = plainRewriteError(e);
            // typed errors from the pipeline keep their meaning; anything unexpected is a clean 500 with the detail in the server log only
            if (pe.code === 'INTERNAL') console.error('rewrite planning failed:', e);
            throw new HttpError(rewriteStatus(pe.code), pe.code, pe.message);
          }
        };
        if (path === '/api/rewrite/plan') {
          // bounded answer: analysis + plan that take long (a large contract) keep computing in the background and are cached; the client repeats the same request
          const work = (async () => { await checkSupport(); return planned(); })();
          const pending = Symbol('pending');
          const first = await Promise.race([work, new Promise<symbol>((r) => setTimeout(() => r(pending), planWaitMs))]);
          if (first === pending) {
            work.catch(() => undefined);
            return send(res, 202, { status: 'pending', retryAfterSeconds: 5, message: 'The plan is still being prepared. Send the same request again in a few seconds; it is cached once ready.' }, { 'Retry-After': '5' });
          }
          return send(res, 200, { plan: first });
        }
        const sum = await checkSupport();
        const health = await withTimeout(rewriteBackend.health(), 20_000);
        if (!health.ok) throw new HttpError(424, 'UNAVAILABLE', `Rewrite service unavailable: ${[health.model, health.sandbox].filter((x) => !x.ok).map((x) => x.message).join(' ')}`);
        if (health.images[rr.to] === false) throw new HttpError(424, 'UNAVAILABLE', `The build image for ${rr.to} is not downloaded yet. Download it from the settings screen.`);
        if (sum.licenseGate && !rr.rights) throw new HttpError(400, 'LICENCE', 'Confirm that you hold the rights to rewrite this code (licence is restricted or missing).');
        // the same gate as the plan: a contract the pipeline would stop on is refused before a job exists
        try { await planned(); } catch (e) { if (e instanceof HttpError && (e.status === 422)) throw e; }
        const job = jobs.startRewrite(rq as never, rr.from, ip);
        return send(res, 202, { jobId: job.id, status: job.status, queuePosition: jobs.position(job.id) });
      }

      if (path === '/api/inspect') {
        const { address, from } = parseInspect(body);
        const analysis = await withTimeout(service.analyse(address, from), timeout);
        return send(res, 200, { summary: summarise(analysis, from), analysis: slimAnalysis(analysis) });
      }
      if (path === '/api/inspect-job') {
        const { address, from } = parseInspect(body);
        const job = jobs.startInspect(address, from, ip);
        return send(res, 202, { jobId: job.id, status: job.status });
      }
      if (path === '/api/recompile') {
        const { address, from } = parseInspect(body);
        return send(res, 200, { recompile: await withTimeout(service.recompile(address, from), timeout) });
      }
      const r = parseClone(body);
      if (path === '/api/plan') {
        const plan = await withTimeout(service.supportedPlan(r), timeout);
        return send(res, 200, { plan: url.searchParams.get('full') === '1' ? plan : slimPlan(plan), warnings: plan.warnings });
      }
      // one rule for every endpoint that goes on to build something: what cannot be cloned is a 422 UNSUPPORTED here, before a job exists
      if (path === '/api/simulate' || path === '/api/project') await withTimeout(service.supportedPlan(r), timeout);
      if (path === '/api/simulate') {
        const job = jobs.startSimulation(r, ip);
        return send(res, 202, { jobId: job.id, status: job.status, queuePosition: jobs.position(job.id) });
      }
      if (path === '/api/project') {
        const job = jobs.startProject(r, ip);
        return send(res, 202, { jobId: job.id, status: job.status });
      }
      if (path === '/api/deploy-payload') {
        const deployed = parseDeployed(asObject(body).deployed);
        const deployer = parseDeployer(asObject(body).deployer);
        const completed = parseCompleted(asObject(body).completed);
        const key = JSON.stringify([r.address.toLowerCase(), r.from.chainId, r.to.chainId, r.overrides, deployed, deployer, completed]);
        const { plan, steps } = await withTimeout(service.memo(key, async () => {
          const analysis = await service.analyse(r.address, r.from);
          const plan = await service.plan(analysis, r.to, r.overrides);
          return { plan, steps: await buildPayload(backend, plan, { deployed, deployer, completed }) };
        }), timeout);
        const to = r.to;
        return send(res, 200, {
          chain: { chainId: to.chainId, name: to.name, testnet: to.testnet, nativeCurrency: to.nativeCurrency, rpcUrls: to.rpcUrls.slice(0, 3), explorer: to.explorer.url },
          steps,
          warnings: plan.warnings,
        });
      }
    }

    const fm = /^\/api\/jobs\/([0-9a-f-]{36})\/(files|file)$/.exec(path);
    if (fm && req.method === 'GET') {
      const job = jobs.get(fm[1]!);
      if (!job || !jobs.hasProject(job)) throw new HttpError(404, 'NOT_FOUND', noProjectMessage(job, 'No project files for this job'));
      if (fm[2] === 'files') return send(res, 200, { files: await jobs.listFiles(job.id) });
      return send(res, 200, await jobs.readProjectFile(job.id, url.searchParams.get('path') ?? ''));
    }
    const m = /^\/api\/jobs\/([0-9a-f-]{36})(\/events|\/project\.zip)?$/.exec(path);
    if (m && req.method === 'GET') {
      const job = jobs.get(m[1]!);
      if (!job) throw new HttpError(404, 'NOT_FOUND', 'No such job (jobs are kept for a limited time)');
      if (!m[2]) return send(res, 200, { job: jobs.view(job) });
      if (m[2] === '/project.zip') {
        if (!jobs.hasProject(job)) throw new HttpError(404, 'NOT_FOUND', noProjectMessage(job, 'This job has no project to download (yet)'));
        const zip = await zipDirectory(jobs.projectDir(job.id), `${job.kind === 'rewrite' ? 'rewrite' : 'clone'}-${job.params.address.slice(0, 8)}-${job.params.from}-to-${job.params.to}`, job.kind === 'rewrite' ? ['llm'] : []);
        res.writeHead(200, {
          'Content-Type': 'application/zip', 'Content-Length': zip.length, 'Cache-Control': 'no-store',
          'Content-Disposition': `attachment; filename="cmc-${job.params.address.slice(2, 10)}-${job.params.from}-to-${job.params.to}.zip"`,
        });
        return void res.end(zip);
      }
      // SSE: replay the lines so far, then stream
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      const write = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(apiDeep(data))}\n\n`);
      const terminal = () => job.status === 'done' || job.status === 'failed' || job.status === 'cancelled';
      write('status', { status: job.status, queuePosition: jobs.position(job.id) });
      for (const l of job.lines) write('line', l);
      if (terminal()) { write('done', { status: job.status, error: job.error }); return void res.end(); }
      const onEvent = (event: string, data: unknown) => {
        write(event, data);
        if (event === 'done') { cleanup(); res.end(); }
      };
      const hb = setInterval(() => res.write(': keep-alive\n\n'), 15_000);
      const cleanup = () => { clearInterval(hb); jobs.off(job.id, onEvent); };
      jobs.on(job.id, onEvent);
      req.on('close', cleanup);
      return;
    }
    throw new HttpError(404, 'NOT_FOUND', 'No such route');
  }

  async function serveStatic(req: IncomingMessage, res: ServerResponse, path: string) {
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'METHOD', 'Method not allowed');
    let rel: string;
    try { rel = decodeURIComponent(path); } catch { throw new HttpError(400, 'INPUT', 'Bad path'); }
    if (rel.includes('\0')) throw new HttpError(400, 'INPUT', 'Bad path');
    if (rel.endsWith('/')) rel += 'index.html';
    const file = normalize(join(webDir, rel));
    if (file !== webDir && !file.startsWith(webDir + sep)) throw new HttpError(404, 'NOT_FOUND', 'Not found');
    let st;
    try { st = await stat(file); } catch { throw new HttpError(404, 'NOT_FOUND', 'Not found'); }
    if (!st.isFile()) throw new HttpError(404, 'NOT_FOUND', 'Not found');
    const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
    const headers: Record<string, string> = {
      'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream', 'ETag': etag, 'Cache-Control': 'no-cache',
    };
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); return void res.end(); }
    const data = await readFile(file);
    res.writeHead(200, { ...headers, 'Content-Length': data.length });
    res.end(req.method === 'HEAD' ? undefined : data);
  }

  const server = createServer(async (req, res) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    res.setHeader('Content-Security-Policy', csp);
    if (guard.hsts) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    const started = Date.now();
    let path = '/';
    if (logLine) {
      // one line per request: no query string, headers, tokens or bodies; registered up front so no response can finish unlogged
      res.once('close', () => logLine(JSON.stringify({ t: new Date(started).toISOString(), sub: subjects.get(req), ip: guard.logIp(req), m: req.method, p: path, s: res.statusCode, ms: Date.now() - started })));
    }
    try {
      const url = new URL(req.url ?? '/', 'http://local');
      path = url.pathname;
      if (await guard.preflight(req, res, url)) return;
      if (path === '/healthz' && (req.method === 'GET' || req.method === 'HEAD')) {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': 2, 'Cache-Control': 'no-store' });
        return void res.end(req.method === 'HEAD' ? undefined : 'ok');
      }
      if (path.startsWith('/api/')) await api(req, res, path, url);
      else await serveStatic(req, res, path);
    } catch (e) {
      const he = toHttpError(e);
      if (res.headersSent) { res.end(); return; }
      const wantsHtml = !path.startsWith('/api/') && (req.headers.accept ?? '').includes('text/html');
      if (wantsHtml) {
        res.writeHead(he.status, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(`${he.status} ${he.message}`);
      } else send(res, he.status, errorBody(he), he.headers);
    }
  });
  guard.attach(server);
  server.requestTimeout = 300_000;
  server.headersTimeout = 20_000;
  server.keepAliveTimeout = 5_000;

  let closed = false;
  const close = () => new Promise<void>((r) => {
    if (closed) return r();
    closed = true;
    guard.close(); pulls.close(); server.closeAllConnections(); server.close(() => r());
  });
  return {
    server, jobs, close,
    async shutdown(graceMs = 20_000) {
      server.close(); // no new connections; open ones are cut in close()
      await jobs.shutdown(graceMs);
      await close();
    },
  };
}
