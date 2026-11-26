import { createServer } from 'node:http';
import { afterAll, describe, expect, it } from 'vitest';
import { LocalModelClient, Semaphore } from '../src/llm/client.js';
import { parseFiles } from '../src/llm/files.js';

let active = 0, peak = 0;
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    const j = JSON.parse(body);
    active++; peak = Math.max(peak, active);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    send({ choices: [{ delta: { reasoning: 'thinking' } }] });
    setTimeout(() => {
      send({ choices: [{ delta: { content: `echo ${j.reasoning_effort} ${j.max_tokens} ${j.temperature}` } }] });
      send({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 7 } });
      res.end('data: [DONE]\n\n');
      active--;
    }, 60);
  });
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/chat/completions`;
afterAll(() => server.close());

describe('LocalModelClient', () => {
  it('streams with the documented parameters and counts usage', async () => {
    const c = new LocalModelClient({ url, model: 'local-test' });
    const r = await c.chat([{ role: 'user', content: 'hi' }]);
    expect(r.content).toBe('echo low 32000 0.2');
    expect(r).toMatchObject({ tokensIn: 5, tokensOut: 7, finish: 'stop' });
    expect(c.usage().requests).toBe(1);
  });
  it('limits concurrency (default 2, hard cap 4)', async () => {
    peak = 0;
    const c = new LocalModelClient({ url, model: 'local-test' });
    await Promise.all(Array.from({ length: 6 }, () => c.chat([{ role: 'user', content: 'x' }])));
    expect(peak).toBe(2);
    expect(new LocalModelClient({ url, model: 'm', concurrency: 99 }).opts.concurrency).toBe(4);
  });
  it('read timeout aborts a stalled stream', async () => {
    const stall = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': hi\n\n'); });
    await new Promise<void>((r) => stall.listen(0, '127.0.0.1', r));
    const u = `http://127.0.0.1:${(stall.address() as { port: number }).port}/`;
    const c = new LocalModelClient({ url: u, model: 'm', readTimeoutMs: 200, retries: 0 });
    await expect(c.chat([{ role: 'user', content: 'x' }])).rejects.toThrow(/read timeout|model call failed/);
    stall.closeAllConnections(); stall.close();
  });
  it('semaphore serialises', async () => {
    const s = new Semaphore(1); const order: number[] = [];
    await Promise.all([1, 2, 3].map((i) => s.run(async () => { order.push(i); await new Promise((r) => setTimeout(r, 5)); order.push(-i); })));
    expect(order).toEqual([1, -1, 2, -2, 3, -3]);
  });
});

describe('parseFiles', () => {
  it('parses strict blocks and rejects unsafe paths', () => {
    const f = parseFiles('note\n=== FILE: a/b.rs ===\nfn x() {}\n=== END FILE ===\n=== FILE: ../evil ===\nx\n=== END FILE ===\n=== FILE: /abs ===\ny\n=== END FILE ===\n');
    expect(Object.keys(f)).toEqual(['a/b.rs']);
    expect(f['a/b.rs']).toBe('fn x() {}\n');
  });
});
