import type { IncomingMessage, ServerResponse } from 'node:http';
import { PROVIDER_IDS, type ProviderId } from '@cmc/translate';
import { HttpError } from './errors.js';
import { invalidateHealth, TARGET_IDS } from './rewrite.js';
import type { PullManager, RuntimeService } from './runtime-service.js';
import type { SettingsService } from './settings.js';
import { asObject } from './validate.js';

export interface SettingsRouteDeps {
  settings: SettingsService;
  runtime: RuntimeService;
  pulls: PullManager;
  send: (res: ServerResponse, status: number, body: unknown, headers?: Record<string, string>) => void;
  readJson: (req: IncomingMessage) => Promise<unknown>;
  sse: (req: IncomingMessage, res: ServerResponse, job: { id: string; snapshot: () => unknown; terminal: () => boolean }, pulls: PullManager) => void;
}

const provId = (v: unknown): ProviderId => {
  if (typeof v !== 'string' || !(PROVIDER_IDS as readonly string[]).includes(v)) throw new HttpError(400, 'INPUT', 'Unknown provider');
  return v as ProviderId;
};

/** /api/settings/* and /api/runtime/*. Returns false when the path is not one of ours. Keys are accepted here and never returned. */
export async function settingsRoutes(d: SettingsRouteDeps, req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
  const { settings, send } = d;
  if (req.method === 'GET' && path === '/api/settings') { send(res, 200, await settings.view()); return true; }
  if (req.method === 'GET' && path === '/api/runtime') { send(res, 200, await d.runtime.snapshot()); return true; }
  if (req.method === 'GET') {
    const m = /^\/api\/runtime\/pull\/([0-9a-f-]{36})\/events$/.exec(path);
    if (m) {
      const job = d.pulls.get(m[1]!);
      if (!job) throw new HttpError(404, 'NOT_FOUND', 'No such download');
      d.sse(req, res, { id: job.id, snapshot: () => d.pulls.get(job.id), terminal: () => d.pulls.get(job.id)!.status !== 'running' }, d.pulls);
      return true;
    }
    return false;
  }
  if (req.method !== 'POST') return false;
  if (!path.startsWith('/api/settings/') && !path.startsWith('/api/runtime/')) return false;
  const body = asObject(await d.readJson(req));
  let m: RegExpExecArray | null;
  if ((m = /^\/api\/settings\/provider\/([a-z-]+)$/.exec(path))) {
    await settings.saveProvider(provId(m[1]), body);
    invalidateHealth();
    send(res, 200, await settings.view()); return true;
  }
  if (path === '/api/settings/active') {
    settings.setActive(body.provider === null ? null : provId(body.provider));
    invalidateHealth();
    send(res, 200, await settings.view()); return true;
  }
  if (path === '/api/settings/claude-cli') { settings.setClaudeCli(body); invalidateHealth(); send(res, 200, await settings.view()); return true; }
  if (path === '/api/settings/ack') { settings.acknowledge(body.version); send(res, 200, await settings.view()); return true; }
  if ((m = /^\/api\/settings\/test\/([a-z-]+)$/.exec(path))) {
    send(res, 200, await settings.test(provId(m[1]), { config: body.config, key: body.key }, body.deep === true)); return true;
  }
  if (path === '/api/runtime/check') { invalidateHealth(); send(res, 200, await d.runtime.snapshot()); return true; }
  if (path === '/api/runtime/pull') {
    const targets = Array.isArray(body.targets) ? body.targets.filter((t): t is string => typeof t === 'string' && TARGET_IDS.includes(t)) : TARGET_IDS;
    const job = await d.pulls.start(targets);
    send(res, 202, { pullId: job.id, status: job.status, targets: job.targets }); return true;
  }
  return false;
}
