import type { IncomingMessage, Server, ServerResponse } from 'node:http';

/** Per-client limits the job manager enforces. */
export interface JobCaps { maxQueued: number; maxRewritesPerDay: number; maxActivePerClient: number }

/** What the browser is told about the deployment. */
export interface PublicConfig { badge: string; footerNote: string; authRequired: boolean }

/**
 * The access-control policy of one deployment. The default (and only shipped) policy is `LocalGuard`: a loopback-only app with a
 * per-launch token. `HostedGuard` (hosted/) is the old public-deployment policy and is off unless CMC_HOSTED=1.
 */
export interface Guard {
  /** called once with the server so a guard can learn the real (ephemeral) port */
  attach(server: Server): void;
  /** runs first on every request; resolves true when the request has been fully answered (rejected, redirected, handled) */
  preflight(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean>;
  /** runs at the start of every /api route; throws HttpError to refuse (rate limits, tokens) */
  apiGate(req: IncomingMessage, path: string): void;
  /** the key jobs are owned and limited by */
  clientOf(req: IncomingMessage): string;
  /** verified identity for the request log, if any */
  subjectOf(req: IncomingMessage): string | null;
  logIp(req: IncomingMessage): string;
  publicConfig(): PublicConfig;
  /** value of the Content-Security-Policy header */
  csp(base: string): string;
  hsts: boolean;
  caps: JobCaps;
  close(): void;
}
