import { CmcError } from '@cmc/core';
import { apiText } from './surface.js';

export interface FieldError { field: string; message: string }

export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string, public headers: Record<string, string> = {}, public fields?: FieldError[], public extra?: Record<string, unknown>) {
    super(message);
  }
}

const CMC_STATUS: Record<CmcError['code'], number> = {
  INPUT: 400,
  UNVERIFIED: 422,
  UNSUPPORTED: 422,
  COMPILE: 422,
  DEPLOY: 422,
  // an upstream we depend on failed: 424, not 502/503/504, because Cloudflare replaces the body of those and clients lose the JSON error
  RPC: 424,
  NETWORK: 424,
  INTERNAL: 500,
};

export interface ErrorBody { error: { code: string; message: string; fields?: FieldError[] }; [k: string]: unknown }

/** Map anything thrown into an HTTP status and the `{error:{code,message}}` body. */
export function toHttpError(e: unknown): HttpError {
  if (e instanceof HttpError) return e;
  if (e instanceof CmcError) return new HttpError(CMC_STATUS[e.code] ?? 500, e.code, apiText(e.message));
  // do not leak stack traces or internals
  console.error('internal error:', e);
  return new HttpError(500, 'INTERNAL', 'Internal error');
}

export const errorBody = (e: HttpError): ErrorBody => ({ error: { code: e.code, message: e.message, ...(e.fields ? { fields: e.fields } : {}) }, ...(e.extra ?? {}) });
