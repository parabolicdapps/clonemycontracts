import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { checkLabel, writeProject, type ChainInfo, type CloneAnalysis, type ClonePlan, type SimulationReport, type VerifiedContract } from '@cmc/core';
import type { RecompileResult } from './backend.js';
import { HttpError, toHttpError } from './errors.js';
import { apiDeep, apiText } from './surface.js';
import { assertPlannable, slimAnalysis, slimPlan, summarise, type Service } from './service.js';
import { plainRewriteError, RewriteCancelled, SPEC_GATE_FAILED, sanitize, sanitizeDeep, type RewriteBackend, type RewriteRequest } from './rewrite.js';
import type { CloneRequest } from './validate.js';
import type { RewriteReport } from '@cmc/translate';

export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
export interface JobLine { seq: number; t: number; text: string }

export interface Job {
  id: string;
  kind: 'simulate' | 'project' | 'inspect' | 'rewrite';
  status: JobStatus;
  /** `to` is a chain id, or a rewrite target id (solana, cosmwasm, aptos, tezos) */
  params: { address: string; from: number; to: number | string; overrides: Record<string, string> };
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  lines: JobLine[];
  error?: { code: string; message: string };
  result?: {
    /** rewrite jobs */
    rewrite?: unknown;
    /** inspect jobs */
    summary?: unknown;
    analysis?: unknown;
    ok: boolean;
    checks: Check[];
    recompile: RecompileResult[];
    simulation: SimulationReport | null;
    plan: unknown;
    hasProject: boolean;
  };
}

const MAX_LINES = 1000;
const MAX_JOBS = 200;
const MAX_ACTIVE_PER_IP = 3;

/** One line of the simulation result. Structured fields come from the core's smoke checks. */
export interface Check {
  group: 'recompile' | 'deploy' | 'smoke' | 'skipped';
  kind: string;
  /** step id this check is about */
  subject: string;
  name: string;
  level: 'pass' | 'warn' | 'fail' | 'skipped';
  detail: string;
  cloneValue?: unknown;
  originalValue?: unknown;
  relation?: 'same' | 'differs-expected' | 'differs';
  reason?: string;
}

/** Recompile results are per contract; attach them to the plan step that clones that contract. */
function recompileSubject(r: RecompileResult, plan?: ClonePlan): string {
  const step = plan?.steps.find((s) => s.name === r.name && s.kind !== 'initialise' && s.kind !== 'admin');
  return step?.id ?? r.name;
}

/** Recompile results, deploy/call results and the core's structured smoke checks as one list. */
export function buildChecks(recompile: RecompileResult[], sim: SimulationReport | null, plan?: ClonePlan): Check[] {
  const checks: Check[] = [];
  for (const r of recompile) {
    checks.push({
      group: 'recompile', kind: 'recompile', subject: recompileSubject(r, plan), name: `Recompile with solc ${r.compiler}`,
      level: r.result === 'exact' || r.result === 'match' ? 'pass' : r.result === 'error' ? 'warn' : 'fail',
      detail: `${r.result}: ${r.detail}`,
    });
  }
  if (!sim) return checks;
  for (const r of sim.results) {
    const call = r.kind === 'call';
    checks.push({
      group: 'deploy', kind: call ? 'call' : 'deploy', subject: r.stepId,
      name: call ? `Call ${plan?.steps.find((s) => s.id === r.stepId)?.call?.signature ?? r.name}` : 'Deploy on the fork',
      // a call is not a deployment: there is no bytecode to compare
      level: !call && r.runtimeMatch.result === 'mismatch' ? 'fail' : 'pass',
      detail: call
        ? `sent to ${r.address}, gas ${r.gasUsed}`
        : `${r.address}, gas ${r.gasUsed}; runtime ${r.runtimeMatch.result} (${r.runtimeMatch.detail})${r.modifiedSource ? '. Source was patched on purpose (hard-coded addresses), so the bytecode differs from the original.' : ''}`,
    });
  }
  for (const c of sim.checks) {
    checks.push({
      group: c.kind === 'skipped-step' ? 'skipped' : 'smoke', kind: c.kind, subject: c.subject, name: c.name.replace(/^[^:]+: /, ''), level: c.level, detail: c.detail,
      ...(c.cloneValue !== undefined ? { cloneValue: c.cloneValue } : {}), ...(c.originalValue !== undefined ? { originalValue: c.originalValue } : {}),
      ...(c.relation ? { relation: c.relation } : {}), ...(c.reason ? { reason: c.reason } : {}),
    });
  }
  return checks;
}

/** The rewrite report as the browser needs it: no raw scenario outcomes, but the documented differences and non-runnable scenarios. */
export interface RewriteJobResult {
  status: string;
  /** stable enum, see `verifiedOf` */
  verified: RewriteVerified;
  report: Omit<RewriteReport, 'outcomes'>;
  documented: { id: string; title: string; what: string; expected: unknown; actual: unknown; why: string }[];
  notRunnable: { id: string; title: string; why: string }[];
  /** present when the run did not finish by itself: why, and the last round that completed. The verdict and the project are from that point. */
  stopped?: { reason: 'timeout' | 'cancelled' | 'error'; afterRound: number; message: string };
}

/**
 * A stable reading of the rewrite verdict for API clients (`result.rewrite.verified`), so nobody has to parse status strings:
 * full | documented-differences | partial | failed-compile | failed-behaviour | unverified | none (a status this server does not know yet).
 */
export type RewriteVerified = 'full' | 'documented-differences' | 'partial' | 'failed-compile' | 'failed-behaviour' | 'unverified' | 'none';
export function verifiedOf(status: string): RewriteVerified {
  switch (status) {
    case 'PASSED': return 'full';
    case 'PASSED-WITH-DOCUMENTED-DIFFERENCES': return 'documented-differences';
    case 'PARTIALLY-VERIFIED': return 'partial';
    case 'FAILED-COMPILE': return 'failed-compile';
    case 'FAILED-BEHAVIOUR': return 'failed-behaviour';
    case 'UNVERIFIED': return 'unverified';
    default: return 'none';
  }
}

/** The early stop of the pipeline (spec failed its sanity gate): a report, but no generated project. */
export const producedNoProject = (r: RewriteReport) => r.status === 'UNVERIFIED' && r.behaviour?.fatal === SPEC_GATE_FAILED;

export function rewriteResult(report: RewriteReport): RewriteJobResult {
  const { outcomes, ...rest } = report;
  const documented = outcomes.filter((o) => o.status === 'documented-difference').flatMap((o) => o.mismatches.map((m) => ({ id: o.id, title: o.title, what: m.what, expected: m.expected, actual: m.actual, why: m.documented ?? '' })));
  const notRunnable = outcomes.filter((o) => o.status === 'not-runnable').map((o) => ({ id: o.id, title: o.title, why: o.notRunnable.slice(0, 2).join('; ') }));
  return sanitizeDeep({ status: report.status, verified: verifiedOf(report.status), report: rest, documented, notRunnable });
}

export class JobManager extends EventEmitter {
  private jobs = new Map<string, Job>();
  private queue: string[] = [];
  private running = 0;
  private owners = new Map<string, string>();
  private rwStarts = new Map<string, number[]>();
  private stopping = false;

  private rwQueue: string[] = [];
  private rwRunning = 0;
  private rwReq = new Map<string, RewriteRequest>();
  private rwAbort = new Map<string, { ctl: AbortController; timedOut: boolean }>();

  constructor(private service: Service, private dataDir: string, private maxConcurrent = 2, private rw: { backend: RewriteBackend; max: number; timeoutMs: number } | null = null, private caps: { maxQueued: number; maxRewritesPerDay: number } = { maxQueued: 20, maxRewritesPerDay: 20 }) {
    super();
    this.setMaxListeners(0);
  }

  async load() {
    await mkdir(join(this.dataDir, 'jobs'), { recursive: true });
    await mkdir(join(this.dataDir, 'projects'), { recursive: true });
    const files = (await readdir(join(this.dataDir, 'jobs'))).filter((f) => f.endsWith('.json'));
    const loaded: Job[] = [];
    for (const f of files) {
      try { loaded.push(JSON.parse(await readFile(join(this.dataDir, 'jobs', f), 'utf8')) as Job); } catch { /* skip corrupt */ }
    }
    loaded.sort((a, b) => b.createdAt - a.createdAt);
    for (const j of loaded.slice(0, MAX_JOBS)) this.jobs.set(j.id, j);
    for (const j of loaded.slice(MAX_JOBS)) void this.remove(j.id);
  }

  get(id: string): Job | undefined { return this.jobs.get(id); }
  position(id: string): number { const i = this.queue.indexOf(id); if (i >= 0) return i + 1; const j = this.rwQueue.indexOf(id); return j < 0 ? 0 : j + 1; }
  projectDir(id: string) { return join(this.dataDir, 'projects', id); }

  /** a project exists only when its folder is really there (jobs outlive their files after pruning or a data-dir cleanup) */
  hasProject(job: Job): boolean {
    return !!job.result?.hasProject && existsSync(this.projectDir(job.id));
  }

  view(job: Job) {
    const result = job.result ? { ...job.result, hasProject: this.hasProject(job) } : undefined;
    return { ...job, ...(result ? { result } : {}), queuePosition: this.position(job.id), lines: job.lines.slice(-MAX_LINES), ip: undefined };
  }

  private activeFor(ip: string) {
    let n = 0;
    for (const [id, owner] of this.owners) if (owner === ip && ['queued', 'running'].includes(this.jobs.get(id)?.status ?? '')) n++;
    return n;
  }

  private create(kind: Job['kind'], req: { address: string; from: { chainId: number }; to: { chainId: number } | string; overrides: Record<string, string> }, ip: string): Job {
    if (this.stopping) throw new HttpError(503, 'UNAVAILABLE', 'The server is restarting. Try again in a minute.');
    if (this.queue.length + this.rwQueue.length >= this.caps.maxQueued) throw new HttpError(429, 'BUSY', 'The queue is full. Try again later.');
    if (this.activeFor(ip) >= MAX_ACTIVE_PER_IP) throw new HttpError(429, 'BUSY', `You already have ${MAX_ACTIVE_PER_IP} jobs waiting or running. Wait for one to finish.`);
    const job: Job = {
      id: randomUUID(), kind, status: 'queued',
      params: { address: req.address, from: req.from.chainId, to: typeof req.to === 'string' ? req.to : req.to.chainId, overrides: req.overrides },
      createdAt: Date.now(), lines: [],
    };
    this.jobs.set(job.id, job);
    this.owners.set(job.id, ip);
    this.prune();
    return job;
  }

  private prune() {
    if (this.jobs.size <= MAX_JOBS) return;
    for (const [id, j] of this.jobs) {
      if (this.jobs.size <= MAX_JOBS) break;
      if (j.status === 'done' || j.status === 'failed' || j.status === 'cancelled') void this.remove(id);
    }
  }

  private async remove(id: string) {
    this.jobs.delete(id);
    this.owners.delete(id);
    await rm(join(this.dataDir, 'jobs', `${id}.json`), { force: true });
    await rm(this.projectDir(id), { recursive: true, force: true });
  }

  private log(job: Job, text: string) {
    if (job.status === 'cancelled') return; // nothing is added to a cancelled job, even by work that is still winding down
    const line = { seq: job.lines.length ? job.lines[job.lines.length - 1]!.seq + 1 : 1, t: Date.now(), text };
    job.lines.push(line);
    if (job.lines.length > MAX_LINES * 2) job.lines.splice(0, job.lines.length - MAX_LINES);
    this.emit(job.id, 'line', line);
  }

  private setStatus(job: Job, status: JobStatus) {
    job.status = status;
    if (status === 'running') job.startedAt = Date.now();
    const terminal = status === 'done' || status === 'failed' || status === 'cancelled';
    if (terminal) job.finishedAt = Date.now();
    this.emit(job.id, 'status', { status, queuePosition: this.position(job.id) });
    if (terminal) {
      this.emit(job.id, 'done', { status, error: job.error });
      void writeFile(join(this.dataDir, 'jobs', `${job.id}.json`), JSON.stringify(job)).catch((e) => console.error('could not persist job', e));
    }
  }

  private announceQueue() {
    this.queue.forEach((id, i) => this.emit(id, 'status', { status: 'queued', queuePosition: i + 1 }));
    this.rwQueue.forEach((id, i) => this.emit(id, 'status', { status: 'queued', queuePosition: i + 1 }));
  }

  startSimulation(req: CloneRequest, ip: string): Job {
    const job = this.create('simulate', req, ip);
    this.queue.push(job.id);
    this.log(job, this.queue.length > 1 || this.running >= this.maxConcurrent ? `queued (position ${this.queue.length})` : 'queued');
    this.reqs.set(job.id, req);
    this.pump();
    return job;
  }

  private reqs = new Map<string, CloneRequest>();

  private pump() {
    while (this.running < this.maxConcurrent && this.queue.length) {
      const id = this.queue.shift()!;
      const job = this.jobs.get(id);
      const req = this.reqs.get(id);
      if (!job || !req) continue;
      this.running++;
      this.announceQueue();
      this.setStatus(job, 'running');
      void this.runSimulation(job, req).finally(() => { this.running--; this.reqs.delete(id); this.pump(); });
    }
  }

  private async prepare(job: Job, req: CloneRequest) {
    this.log(job, `fetching verified source for ${req.address} on ${req.from.name}`);
    const analysis = await this.service.analyse(req.address, req.from);
    this.log(job, `planning clone to ${req.to.name}`);
    const libs: VerifiedContract[] = [];
    const plan = await this.service.plan(analysis, req.to, req.overrides, (v) => libs.push(v));
    assertPlannable(plan);
    return { analysis, plan, libs };
  }

  private ctls = new Map<string, AbortController>();

  /**
   * Run the work of a simulate/project/inspect job so that it can be cancelled: the job ends the moment it is cancelled, the work gets
   * the abort signal (the simulation stops its anvil), and the returned promise settles only when the work has really stopped.
   */
  private async runTracked(job: Job, work: (signal: AbortSignal) => Promise<NonNullable<Job['result']>>): Promise<void> {
    const ctl = new AbortController();
    this.ctls.set(job.id, ctl);
    const aborted = new Promise<never>((_, rej) => ctl.signal.addEventListener('abort', () => rej(new RewriteCancelled()), { once: true }));
    aborted.catch(() => undefined);
    let settled: Promise<void> = Promise.resolve();
    try {
      const p = work(ctl.signal);
      settled = p.then(() => undefined, () => undefined);
      const result = await Promise.race([p, aborted]);
      if (ctl.signal.aborted) return;
      job.result = result;
      this.setStatus(job, 'done');
    } catch (e) {
      if (ctl.signal.aborted || job.status === 'cancelled') return;
      this.fail(job, e);
    } finally {
      this.ctls.delete(job.id);
      await settled;
    }
  }

  private runSimulation(job: Job, req: CloneRequest) {
    return this.runTracked(job, async (signal) => {
      const { analysis, plan, libs } = await this.prepare(job, req);
      const recompile: RecompileResult[] = [];
      for (const vc of [analysis.implementation?.contract, analysis.contract, ...libs].filter((x): x is VerifiedContract => !!x)) {
        if (signal.aborted) throw new RewriteCancelled();
        this.log(job, `recompiling ${vc.name} with solc ${vc.compilerVersion} to compare with on-chain code`);
        const r = await this.service.backend.recompile(vc);
        recompile.push(r);
        this.log(job, `  ${r.name}: ${r.result.toUpperCase()} - ${r.detail}`);
      }
      if (signal.aborted) throw new RewriteCancelled();
      this.log(job, `simulating on a fork of ${req.to.name}`);
      const sim = await this.service.backend.simulate(plan, (m) => this.log(job, `  ... ${m}`), signal);
      for (const r of sim.results) this.log(job, r.kind === 'call' ? `  called ${r.name} on ${r.address} (tx ${r.txHash})` : `  deployed ${r.name} at ${r.address}  runtime vs recompile: ${r.runtimeMatch.result}`);
      const checks = buildChecks(recompile, sim, plan);
      for (const c of sim.checks) this.log(job, `  ${checkLabel(c.level)} ${c.name}: ${c.detail}`);
      const ok = sim.ok && !checks.some((c) => c.level === 'fail');
      this.log(job, `Simulation: ${ok ? 'PASS' : 'FAIL'}`);
      const hasProject = await this.saveProject(job, { analysis, plan, recompile, simulation: sim });
      return { ok, checks, recompile, simulation: sim, plan: slimPlan(plan), hasProject };
    });
  }

  // ---- rewrites (one at a time: the model cluster and the build sandbox are shared) -------------------------------

  startRewrite(req: RewriteRequest, from: ChainInfo, ip: string): Job {
    if (!this.rw) throw new HttpError(503, 'UNAVAILABLE', 'Rewrites are not enabled on this server.');
    for (const [id, owner] of this.owners) {
      const j = this.jobs.get(id);
      if (owner === ip && j?.kind === 'rewrite' && (j.status === 'queued' || j.status === 'running')) throw new HttpError(429, 'BUSY', 'You already have a rewrite waiting or running. Wait for it or cancel it first.');
    }
    const dayAgo = Date.now() - 24 * 3600_000;
    const starts = (this.rwStarts.get(ip) ?? []).filter((t) => t > dayAgo);
    if (this.caps.maxRewritesPerDay > 0 && starts.length >= this.caps.maxRewritesPerDay) throw new HttpError(429, 'DAILY_LIMIT', `Daily limit of ${this.caps.maxRewritesPerDay} rewrites reached. Try again tomorrow.`);
    const job = this.create('rewrite', { address: req.address, from, to: req.to, overrides: {} }, ip);
    starts.push(Date.now());
    this.rwStarts.set(ip, starts);
    this.rwReq.set(job.id, req);
    this.rwQueue.push(job.id);
    this.log(job, this.rwQueue.length > 1 || this.rwRunning >= this.rw.max ? `[queue] waiting, position ${this.rwQueue.length}` : '[queue] starting');
    this.pumpRewrite();
    return job;
  }

  /**
   * Cancel a job of this client. Queued jobs leave the queue; a running rewrite is aborted at its next stage; a running simulation stops its anvil
   * and frees its slot; inspect/project jobs end at once. Cancelling a cancelled job is a no-op (200); a job that already finished is a 409.
   */
  cancel(id: string, ip: string): Job {
    const job = this.jobs.get(id);
    if (!job) throw new HttpError(404, 'NOT_FOUND', 'No such job');
    if (this.owners.get(id) !== ip) throw new HttpError(403, 'FORBIDDEN', 'This job belongs to another client');
    if (job.status === 'cancelled') return job;
    if (job.status === 'done' || job.status === 'failed') {
      throw new HttpError(409, 'FINISHED', `This job has already finished (${job.status}), so there is nothing to cancel`, {}, undefined, { status: job.status, job: this.view(job) });
    }
    if (job.kind === 'rewrite') {
      const i = this.rwQueue.indexOf(id);
      if (i >= 0) { this.rwQueue.splice(i, 1); this.rwReq.delete(id); this.log(job, '[queue] cancelled'); this.setStatus(job, 'cancelled'); this.announceQueue(); return job; }
      this.rwAbort.get(id)?.ctl.abort();
      return job;
    }
    const qi = this.queue.indexOf(id);
    if (qi >= 0) { this.queue.splice(qi, 1); this.reqs.delete(id); this.log(job, 'cancelled while queued'); this.setStatus(job, 'cancelled'); this.announceQueue(); return job; }
    // running: the job ends now, the work is told to stop (the simulation kills its anvil) and the slot is freed once it really has
    this.log(job, 'cancelled');
    this.setStatus(job, 'cancelled');
    this.ctls.get(id)?.abort();
    return job;
  }

  private pumpRewrite() {
    if (!this.rw) return;
    while (this.rwRunning < this.rw.max && this.rwQueue.length) {
      const id = this.rwQueue.shift()!;
      const job = this.jobs.get(id);
      const req = this.rwReq.get(id);
      if (!job || !req) continue;
      this.rwRunning++;
      this.announceQueue();
      this.setStatus(job, 'running');
      void this.runRewrite(job, req).finally(() => { this.rwReq.delete(id); this.pumpRewrite(); });
    }
  }

  private async runRewrite(job: Job, req: RewriteRequest) {
    const rw = this.rw!;
    const ctl = new AbortController();
    const state = { ctl, timedOut: false };
    this.rwAbort.set(job.id, state);
    const timer = setTimeout(() => { state.timedOut = true; ctl.abort(); }, rw.timeoutMs);
    const outDir = this.projectDir(job.id);
    const aborted = new Promise<never>((_, rej) => ctl.signal.addEventListener('abort', () => rej(new RewriteCancelled()), { once: true }));
    aborted.catch(() => undefined);
    let settled: Promise<void> = Promise.resolve();
    const partial: { report?: RewriteReport } = {};
    try {
      await mkdir(outDir, { recursive: true });
      if (ctl.signal.aborted) throw new RewriteCancelled(); // cancelled before the pipeline started
      // the pipeline gets a time budget below the hard cap, so it normally stops itself first and returns what it has
      const work = rw.backend.run(req, { outDir, signal: ctl.signal, onProgress: (l) => this.log(job, sanitize(l)), budgetMs: Math.max(60_000, rw.timeoutMs - 180_000), onCheckpoint: (r) => { partial.report = r; } });
      // the slot is only freed when the pipeline really stopped (a sandbox call in flight finishes first),
      // but the job itself ends as soon as it is cancelled
      settled = work.then(() => undefined, () => undefined);
      const out = await Promise.race([work, aborted]);
      const rewrite = rewriteResult(out.report);
      // the pipeline returns its last checkpoint (reason appended) after a late failure or an exhausted budget
      const late = out.report.statusReasons?.find((x) => /stopped early after the last checkpoint/.test(x));
      const budget = out.report.statusReasons?.find((x) => /time budget exhausted/.test(x));
      if (late || budget) rewrite.stopped = { reason: late ? 'error' : 'timeout', afterRound: Math.max(0, ...[...(out.report.compile?.rounds ?? []), ...(out.report.behaviour?.rounds ?? [])].map((r) => r.round)), message: sanitize(late ?? budget!) };
      const ok = out.status === 'PASSED' || out.status === 'PASSED-WITH-DOCUMENTED-DIFFERENCES';
      job.result = { ok, checks: [], recompile: [], simulation: null, plan: null, hasProject: !producedNoProject(out.report), rewrite };
      this.log(job, `[report] ${out.status}`);
      this.setStatus(job, 'done');
    } catch (e) {
      const reason: 'timeout' | 'cancelled' | 'error' = ctl.signal.aborted ? (state.timedOut ? 'timeout' : 'cancelled') : 'error';
      const pe = reason === 'error' ? plainRewriteError(e) : null;
      const message = reason === 'timeout' ? `The rewrite reached its time limit of ${rw.timeoutMs >= 120_000 ? `${Math.round(rw.timeoutMs / 60000)} minutes` : `${Math.round(rw.timeoutMs / 1000)} seconds`} and was stopped.` : reason === 'cancelled' ? 'The rewrite was cancelled.' : pe!.message;
      // whatever the run had produced is kept: the last completed round's project and an honest verdict
      const kept = await this.salvage(job, req, outDir, reason, message, partial.report);
      if (kept) {
        this.log(job, `[report] stopped after round ${kept}: ${message} The results are from the last completed round.`);
        this.setStatus(job, reason === 'cancelled' ? 'cancelled' : 'done');
      } else if (reason === 'timeout') { job.error = { code: 'TIMEOUT', message }; this.log(job, `[report] stopped: time limit`); this.setStatus(job, 'failed'); }
      else if (reason === 'cancelled') { this.log(job, '[report] cancelled'); this.setStatus(job, 'cancelled'); }
      else { job.error = pe!; this.log(job, `[report] failed: ${message}`); this.setStatus(job, 'failed'); }
    } finally {
      clearTimeout(timer);
      this.rwAbort.delete(job.id);
      await settled;
      this.rwRunning--;
    }
  }

  /** Round numbers seen in a rewrite's progress lines (`[compile] round 2`, `[behaviour] round 1`). */
  private lastRound(job: Job): number {
    let n = 0;
    for (const l of job.lines) { const m = /\bround (\d+)/i.exec(l.text); if (m) n = Math.max(n, Number(m[1])); }
    return n;
  }

  /**
   * A run that stopped early (time budget, cancel, error) keeps its last good project: the result carries the report the pipeline
   * persisted (or a report that says nothing was verified), `stopped`, and `hasProject` only when files really exist. Returns the round, or 0 when there is nothing to keep.
   */
  private async salvage(job: Job, req: RewriteRequest, outDir: string, reason: 'timeout' | 'cancelled' | 'error', message: string, inMemory?: RewriteReport): Promise<number> {
    let files: { path: string }[] = [];
    try { files = await this.listFiles(job.id); } catch { return 0; }
    if (!files.length) return 0;
    let report = inMemory;
    if (!report) { try { report = JSON.parse(await readFile(join(outDir, 'report.json'), 'utf8')) as RewriteReport; } catch { /* no report written yet */ } }
    const rounds = report ? Math.max(0, ...[...(report.compile?.rounds ?? []), ...(report.behaviour?.rounds ?? [])].map((r) => r.round)) : 0;
    const afterRound = Math.max(rounds, this.lastRound(job));
    if (!report) {
      report = {
        version: 1, contract: req.address, source: { address: req.address } as never, target: req.to, path: 'model', status: 'UNVERIFIED',
        statusReasons: [`the run stopped before a verdict (${message}); the files below are from the last completed step and were not behaviour-checked`],
        coverage: { functionsTotal: 0, functionsVerified: 0, functionsUnverified: [], uncheckedFunctions: [], trivialOnlyFunctions: [], notTranslatedFunctions: [], uncomparedReturns: [], notRunnableScenarios: [], getters: { checked: 0, mismatched: 0 }, summary: 'not measured: the run was stopped' },
        compile: { ok: false, round: null, rounds: [] }, behaviour: { ran: false, passed: 0, failed: 0, notRunnable: 0, documented: 0, total: 0, rounds: [], conformance: [] },
        functions: [], nonPortable: [], notTranslated: [], designNotes: [], deploy: [], usage: { requests: 0, tokensIn: 0, tokensOut: 0, modelSecs: 0 }, wallSecs: (Date.now() - (job.startedAt ?? job.createdAt)) / 1000, outcomes: [], scenarioCount: 0,
      } as unknown as RewriteReport;
    }
    job.result = { ok: false, checks: [], recompile: [], simulation: null, plan: null, hasProject: true, rewrite: { ...rewriteResult(report), stopped: { reason, afterRound, message: sanitize(message) } } };
    return Math.max(1, afterRound);
  }

  /** Stop for a restart: no new jobs, queued ones are cancelled, running rewrites are aborted, simulations get `graceMs` to finish. */
  async shutdown(graceMs: number) {
    this.stopping = true;
    for (const id of [...this.queue, ...this.rwQueue]) {
      const job = this.jobs.get(id);
      if (!job) continue;
      this.log(job, '[queue] cancelled: the server is shutting down');
      this.setStatus(job, 'cancelled');
    }
    this.queue = []; this.rwQueue = []; this.rwReq.clear(); this.reqs.clear();
    for (const a of this.rwAbort.values()) a.ctl.abort();
    const end = Date.now() + graceMs;
    while ((this.running > 0 || this.rwRunning > 0) && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
  }

  /** Text files of a finished rewrite (the project folder, reports, specs), without the raw model logs. */
  async listFiles(id: string): Promise<{ path: string; size: number }[]> {
    const dir = this.projectDir(id);
    const out: { path: string; size: number }[] = [];
    const walk = async (d: string, rel: string) => {
      for (const e of await readdir(d, { withFileTypes: true })) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) { if (!rel && e.name === 'llm') continue; await walk(join(d, e.name), r); }
        else out.push({ path: r, size: (await stat(join(d, e.name))).size });
      }
    };
    await walk(dir, '');
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  async readProjectFile(id: string, rel: string, limit = 200_000): Promise<{ path: string; content: string; truncated: boolean; binary: boolean }> {
    const parts = rel.split('/');
    if (!rel || rel.includes('\0') || parts.some((p) => p === '' || p === '.' || p === '..') || parts[0] === 'llm') throw new HttpError(400, 'INPUT', 'Bad file path');
    const file = join(this.projectDir(id), ...parts);
    let st;
    try { st = await stat(file); } catch { throw new HttpError(404, 'NOT_FOUND', 'No such file'); }
    if (!st.isFile()) throw new HttpError(404, 'NOT_FOUND', 'No such file');
    const buf = await readFile(file);
    const slice = buf.subarray(0, limit);
    if (slice.includes(0)) return { path: rel, content: '', truncated: false, binary: true };
    return { path: rel, content: sanitize(slice.toString('utf8')), truncated: buf.length > limit, binary: false };
  }

  /** Inspect with real progress lines (source fetch, implementation, history scan) over SSE. Not queued: it only reads. */
  startInspect(address: `0x${string}`, from: ChainInfo, ip: string): Job {
    const job = this.create('inspect', { address, from, to: from, overrides: {} }, ip);
    this.setStatus(job, 'running');
    void this.runTracked(job, async () => {
      const analysis = await this.service.analyse(address, from, (t) => this.log(job, t));
      return { ok: true, checks: [], recompile: [], simulation: null, plan: null, hasProject: false, summary: summarise(analysis, from), analysis: slimAnalysis(analysis) };
    });
    return job;
  }

  /** A project download without a simulation: instantly-done job. */
  startProject(req: CloneRequest, ip: string): Job {
    const job = this.create('project', req, ip);
    this.setStatus(job, 'running');
    void this.runTracked(job, async () => {
      const { analysis, plan } = await this.prepare(job, req);
      const hasProject = await this.saveProject(job, { analysis, plan });
      return { ok: true, checks: [], recompile: [], simulation: null, plan: slimPlan(plan), hasProject };
    });
    return job;
  }

  private async saveProject(job: Job, input: { analysis: CloneAnalysis; plan: ClonePlan; recompile?: RecompileResult[]; simulation?: SimulationReport | null }) {
    try {
      await writeProject(this.projectDir(job.id), { ...input, surface: { text: apiText, deep: apiDeep } });
      return true;
    } catch (e) {
      console.error('could not write project', e);
      return false;
    }
  }

  private fail(job: Job, e: unknown) {
    const he = toHttpError(e);
    job.error = { code: he.code, message: he.message };
    this.log(job, `error: ${he.message}`);
    this.setStatus(job, 'failed');
  }
}
