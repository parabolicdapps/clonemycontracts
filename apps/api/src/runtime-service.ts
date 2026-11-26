import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { resolveAdapter, type PullProgress, type RuntimeStatus } from '@cmc/translate';
import { imageRef, invalidateHealth, TARGET_IDS } from './rewrite.js';

export interface ImageState { target: string; image: string; present: boolean }
export interface RuntimeSnapshot { status: RuntimeStatus; images: ImageState[] }

/** What the settings screen needs from the container runtime; tests inject a fake. */
export interface RuntimeService {
  snapshot(): Promise<RuntimeSnapshot>;
  pull(image: string, onProgress: (p: PullProgress) => void, signal?: AbortSignal): Promise<{ ok: boolean; message: string }>;
}

export const realRuntimeService: RuntimeService = {
  async snapshot() {
    const r = await resolveAdapter();
    const images = await Promise.all(TARGET_IDS.map(async (target) => ({ target, image: imageRef(target), present: r.adapter ? await r.adapter.imageExists(imageRef(target)) : false })));
    return { status: r.status, images };
  },
  async pull(image, onProgress, signal) {
    const r = await resolveAdapter();
    if (!r.adapter) return { ok: false, message: r.status.message };
    return r.adapter.pull(image, onProgress, signal);
  },
};

export interface PullTargetState { target: string; image: string; state: 'waiting' | 'pulling' | 'done' | 'failed'; layersDone: number; layersTotal: number; message: string }
export interface PullJob { id: string; status: 'running' | 'done' | 'failed'; targets: PullTargetState[]; lastLine: string }

/** First-run toolchain image download: one job at a time, progress streamed to the page. */
export class PullManager {
  private jobs = new Map<string, PullJob>();
  private ev = new EventEmitter();
  private current: PullJob | null = null;
  private ctl: AbortController | null = null;
  constructor(private svc: RuntimeService) { this.ev.setMaxListeners(50); }

  get(id: string) { return this.jobs.get(id); }
  on(id: string, f: (e: string, d: unknown) => void) { this.ev.on(id, f); }
  off(id: string, f: (e: string, d: unknown) => void) { this.ev.off(id, f); }

  async start(targets: string[]): Promise<PullJob> {
    if (this.current?.status === 'running') return this.current;
    const snap = await this.svc.snapshot();
    const todo = snap.images.filter((i) => targets.includes(i.target) && !i.present);
    const job: PullJob = { id: randomUUID(), status: 'running', lastLine: '', targets: todo.map((i) => ({ target: i.target, image: i.image, state: 'waiting', layersDone: 0, layersTotal: 0, message: '' })) };
    this.jobs.set(job.id, job); this.current = job;
    const emit = (e: string) => this.ev.emit(job.id, e, JSON.parse(JSON.stringify(job)));
    this.ctl = new AbortController();
    void (async () => {
      let failed = false;
      for (const t of job.targets) {
        t.state = 'pulling'; emit('progress');
        const r = await this.svc.pull(t.image, (p) => { t.layersDone = p.layersDone; t.layersTotal = p.layersTotal; job.lastLine = p.line.slice(0, 200); emit('progress'); }, this.ctl!.signal);
        t.state = r.ok ? 'done' : 'failed'; t.message = r.message; if (!r.ok) failed = true;
        emit('progress');
      }
      job.status = failed ? 'failed' : 'done';
      invalidateHealth();
      emit('done');
    })();
    return job;
  }

  /** abort a running download (shutdown) */
  close() { this.ctl?.abort(); }
}
