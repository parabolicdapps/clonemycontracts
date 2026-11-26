import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AnthropicProvider } from '../src/llm/anthropic.js';
import { ClaudeCliProvider, cliEnv, detectClaudeBinary } from '../src/llm/claude-cli.js';
import { LlmError, SseParser, redactHeaders, redactSecrets, redactUrl } from '../src/llm/common.js';
import { OpenAICompatProvider } from '../src/llm/openai-compat.js';
import { estimateCost, loadPrices } from '../src/llm/prices.js';
import { createProvider, emptyLlmSettings, validateLlmSettings } from '../src/llm/registry.js';

interface Seen { url: string; headers: IncomingMessage['headers']; body: any }
const seen: Seen[] = [];
let mode: 'ok' | '401' | '429once' | '500' | 'midstream' | 'openrouter' | 'anthropic' | 'anthropic-error' | 'anthropic-refusal' = 'ok';
let hits429 = 0;

const server = createServer((req, res) => {
  let raw = '';
  req.on('data', (d) => (raw += d));
  req.on('end', () => {
    if (req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/json' }); return void res.end(JSON.stringify({ data: [{ id: 'm1' }, { id: 'm2' }] })); }
    const body = JSON.parse(raw || '{}');
    seen.push({ url: req.url ?? '', headers: req.headers, body });
    if (mode === '401') { res.writeHead(401, { 'content-type': 'application/json' }); return void res.end(JSON.stringify({ error: { message: 'Incorrect API key provided: sk-live-SECRETSECRET1234' } })); }
    if (mode === '500') { res.writeHead(500); return void res.end('boom'); }
    if (mode === '429once' && hits429++ === 0) { res.writeHead(429); return void res.end('slow down'); }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const ev = (o: unknown, name?: string) => res.write(`${name ? `event: ${name}\n` : ''}data: ${JSON.stringify(o)}\n\n`);
    if (mode.startsWith('anthropic')) {
      ev({ type: 'message_start', message: { model: 'claude-x', usage: { input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 1 } } }, 'message_start');
      res.write(': ping\n\n');
      if (mode === 'anthropic-error') { ev({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, 'error'); return void res.end(); }
      ev({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hmm' } });
      ev({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'hello ' } });
      ev({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'world' } });
      ev({ type: 'message_delta', delta: { stop_reason: mode === 'anthropic-refusal' ? 'refusal' : 'end_turn' }, usage: { output_tokens: 9 } });
      ev({ type: 'message_stop' });
      return void res.end();
    }
    res.write(': OPENROUTER PROCESSING\n\n');
    ev({ model: 'served-model', choices: [{ delta: { reasoning: 'thinking' } }] });
    ev({ choices: [{ delta: { content: 'ab' } }] });
    if (mode === 'midstream') { ev({ error: { code: 502, message: 'upstream died' }, choices: [{ delta: {}, finish_reason: 'error' }] }); return void res.end('data: [DONE]\n\n'); }
    ev({ choices: [{ delta: { content: 'cd' }, finish_reason: 'stop' }] });
    ev({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 22, ...(mode === 'openrouter' ? { cost: 0.0042 } : {}) } });
    res.end('data: [DONE]\n\n');
  });
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
afterAll(() => server.close());
const msgs = [{ role: 'system' as const, content: 'sys' }, { role: 'user' as const, content: 'hi' }];
const last = () => seen[seen.length - 1]!;
const fast = { retryBaseMs: 5 };

describe('OpenAICompatProvider profiles', () => {
  it('openai: max_completion_tokens, Bearer, stream usage, no temperature or reasoning unless asked', async () => {
    mode = 'ok';
    const p = new OpenAICompatProvider({ profile: 'openai', model: 'gpt-x', apiKey: 'sk-test-AAAA1111', baseUrl: base + '/v1', ...fast });
    const r = await p.chat(msgs);
    expect(r).toMatchObject({ content: 'abcd', tokensIn: 11, tokensOut: 22, finish: 'stop', model: 'served-model', reasoningChars: 8 });
    expect(last().url).toBe('/v1/chat/completions');
    expect(last().headers.authorization).toBe('Bearer sk-test-AAAA1111');
    expect(last().body).toMatchObject({ model: 'gpt-x', max_completion_tokens: 32000, stream: true, stream_options: { include_usage: true } });
    expect(last().body).not.toHaveProperty('max_tokens');
    expect(last().body).not.toHaveProperty('temperature');
    expect(last().body).not.toHaveProperty('reasoning_effort');
    await new OpenAICompatProvider({ profile: 'openai', model: 'gpt-x', apiKey: 'k', baseUrl: base, reasoningEffort: 'high', ...fast }).chat(msgs);
    expect(last().body.reasoning_effort).toBe('high');
  });
  it('openrouter: max_tokens + reasoning object, reports cost', async () => {
    mode = 'openrouter';
    const p = new OpenAICompatProvider({ profile: 'openrouter', model: 'a/b', apiKey: 'k', baseUrl: base, reasoningEffort: 'low', ...fast });
    const r = await p.chat(msgs);
    expect(last().body).toMatchObject({ max_tokens: 32000, reasoning: { effort: 'low' } });
    expect(last().body).not.toHaveProperty('reasoning_effort');
    expect(r.reportedCostUsd).toBe(0.0042);
  });
  it('gemini: reasoning_effort at top level, max_tokens', async () => {
    mode = 'ok';
    await new OpenAICompatProvider({ profile: 'gemini', model: 'g', apiKey: 'k', baseUrl: base + '/v1beta/openai', reasoningEffort: 'medium', ...fast }).chat(msgs);
    expect(last().url).toBe('/v1beta/openai/chat/completions');
    expect(last().body).toMatchObject({ max_tokens: 32000, reasoning_effort: 'medium' });
  });
  it('custom: today\'s profile (low effort, 32000, temperature 0.2), no auth header without a key; URL suffix accepted', async () => {
    const p = new OpenAICompatProvider({ profile: 'custom', model: 'local', baseUrl: base + '/v1/chat/completions', ...fast });
    await p.chat(msgs);
    expect(last().body).toMatchObject({ max_tokens: 32000, reasoning_effort: 'low', temperature: 0.2 });
    expect(last().headers.authorization).toBeUndefined();
  });
  it('profile overrides and the model output cap apply', async () => {
    await new OpenAICompatProvider({ profile: 'custom', model: 'm', baseUrl: base, overrides: { tokenParam: 'max_completion_tokens', reasoning: 'none' }, modelMaxOutput: 1000, ...fast }).chat(msgs);
    expect(last().body.max_completion_tokens).toBe(1000);
    expect(last().body).not.toHaveProperty('reasoning_effort');
  });
  it('maps errors: 401 is final and redacted, 429 is retried, 5xx retried then fails, mid-stream error surfaces', async () => {
    const mk = (retries = 2) => new OpenAICompatProvider({ profile: 'openai', model: 'm', apiKey: 'sk-live-SECRETSECRET1234', baseUrl: base, retries, ...fast });
    mode = '401'; const n = seen.length;
    const e = await mk().chat(msgs).catch((x) => x);
    expect(e).toBeInstanceOf(LlmError); expect(e.kind).toBe('auth'); expect(e.message).not.toContain('SECRETSECRET'); expect(seen.length - n).toBe(1);
    mode = '429once'; hits429 = 0; expect((await mk().chat(msgs)).content).toBe('abcd');
    mode = '500'; const m = seen.length;
    await expect(mk(1).chat(msgs)).rejects.toMatchObject({ kind: 'server' }); expect(seen.length - m).toBe(2);
    mode = 'midstream'; await expect(mk(0).chat(msgs)).rejects.toThrow(/upstream died/);
  });
  it('never writes the key to the request log or error log', async () => {
    mode = '401';
    const dir = mkdtempSync(join(tmpdir(), 'cmc-log-'));
    await new OpenAICompatProvider({ profile: 'openai', model: 'm', apiKey: 'sk-live-SECRETSECRET1234', baseUrl: base, retries: 0, logDir: dir, ...fast }).chat(msgs, { label: 'x' }).catch(() => undefined);
    const files = readdirSync(join(dir, 'llm'));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) expect(readFileSync(join(dir, 'llm', f), 'utf8')).not.toContain('SECRETSECRET');
  });
  it('listModels', async () => { expect(await new OpenAICompatProvider({ profile: 'custom', model: 'm', baseUrl: base }).listModels()).toEqual(['m1', 'm2']); });
});

describe('AnthropicProvider', () => {
  it('sends x-api-key, anthropic-version, top-level system, max_tokens; parses SSE and usage incl. cache reads', async () => {
    mode = 'anthropic';
    const p = new AnthropicProvider({ model: 'claude-sonnet-5-5', apiKey: 'sk-ant-TESTKEY123456', baseUrl: base, ...fast });
    const r = await p.chat([...msgs, { role: 'user', content: 'again' }]);
    expect(r).toMatchObject({ content: 'hello world', tokensIn: 15, tokensOut: 9, finish: 'end_turn', model: 'claude-x', reasoningChars: 3 });
    expect(last().url).toBe('/v1/messages');
    expect(last().headers['x-api-key']).toBe('sk-ant-TESTKEY123456');
    expect(last().headers['anthropic-version']).toBe('2023-06-01');
    expect(last().headers.authorization).toBeUndefined();
    expect(last().body).toMatchObject({ model: 'claude-sonnet-5-5', system: 'sys', max_tokens: 32000, stream: true });
    expect(last().body.messages).toEqual([{ role: 'user', content: 'hi\n\nagain' }]);
    expect(last().body).not.toHaveProperty('temperature');
  });
  it('clamps max_tokens to the model cap and passes effort', async () => {
    mode = 'anthropic';
    await new AnthropicProvider({ model: 'm', apiKey: 'k', baseUrl: base, maxTokens: 500000, modelMaxOutput: 128000, effort: 'high', ...fast }).chat(msgs);
    expect(last().body).toMatchObject({ max_tokens: 128000, output_config: { effort: 'high' } });
  });
  it('mid-stream overloaded error is retryable; refusal is a typed final error', async () => {
    mode = 'anthropic-error'; const n = seen.length;
    await expect(new AnthropicProvider({ model: 'm', apiKey: 'k', baseUrl: base, retries: 1, ...fast }).chat(msgs)).rejects.toMatchObject({ kind: 'server' });
    expect(seen.length - n).toBe(2);
    mode = 'anthropic-refusal';
    await expect(new AnthropicProvider({ model: 'm', apiKey: 'k', baseUrl: base, ...fast }).chat(msgs)).rejects.toMatchObject({ kind: 'refused' });
  });
});

describe('ClaudeCliProvider (fake claude)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cmc-fake-'));
  const script = (name: string, body: string) => { const p = join(dir, name); writeFileSync(p, `#!/bin/bash\n${body}\n`); chmodSync(p, 0o755); return p; };
  const okBin = script('ok', `
if [ "$1" = "--version" ]; then echo "9.9.9 (fake)"; exit 0; fi
printf '%s\\n' "$@" > "${dir}/argv.txt"; pwd > "${dir}/cwd.txt"; env | grep -c ANTHROPIC_API_KEY > "${dir}/envcount.txt"; cat > "${dir}/stdin.txt"
echo '{"type":"result","subtype":"success","is_error":false,"result":"fake answer","usage":{"input_tokens":3,"output_tokens":4,"cache_read_input_tokens":2},"total_cost_usd":0.001,"modelUsage":{"claude-haiku-5-5":{}},"duration_ms":5}'`);
  const loginBin = script('login', `echo '{"type":"result","subtype":"success","is_error":true,"result":"Not logged in · Please run /login"}'; exit 1`);
  const garbage = script('garbage', `echo "oops"; exit 3`);
  const slow = script('slow', `sleep 30`);

  it('uses the verified flag set in a fresh empty cwd, prompt on stdin, strips auth env, maps usage and cost', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-should-not-leak';
    try {
      const p = new ClaudeCliProvider({ binary: okBin, model: 'haiku' });
      const r = await p.chat(msgs);
      expect(r).toMatchObject({ content: 'fake answer', tokensIn: 5, tokensOut: 4, finish: 'stop', reportedCostUsd: 0.001, model: 'claude-haiku-5-5' });
      const argv = readFileSync(join(dir, 'argv.txt'), 'utf8').split('\n');
      for (const f of ['-p', '--output-format', 'json', '--tools', '--system-prompt', 'sys', '--no-session-persistence', '--disable-slash-commands', '--setting-sources', '--strict-mcp-config', '--model', 'haiku']) expect(argv).toContain(f);
      expect(argv).not.toContain('--dangerously-skip-permissions');
      expect(readFileSync(join(dir, 'stdin.txt'), 'utf8')).toBe('hi');
      const cwd = readFileSync(join(dir, 'cwd.txt'), 'utf8').trim();
      expect(cwd).toContain('cmc-claude-'); expect(existsSync(cwd)).toBe(false); // removed afterwards
      expect(readFileSync(join(dir, 'envcount.txt'), 'utf8').trim()).toBe('0');
    } finally { delete process.env.ANTHROPIC_API_KEY; }
    expect(cliEnv({ ANTHROPIC_API_KEY: 'x', PATH: '/bin' })).toEqual({ PATH: '/bin' });
  });
  it('auth failure, non-JSON output, abort and missing binary are typed errors', async () => {
    await expect(new ClaudeCliProvider({ binary: loginBin }).chat(msgs)).rejects.toMatchObject({ kind: 'auth' });
    await expect(new ClaudeCliProvider({ binary: garbage }).chat(msgs)).rejects.toMatchObject({ kind: 'server' });
    const ctl = new AbortController(); setTimeout(() => ctl.abort(), 150);
    await expect(new ClaudeCliProvider({ binary: slow }).chat(msgs, { signal: ctl.signal })).rejects.toMatchObject({ kind: 'aborted' });
    expect(() => new ClaudeCliProvider({ binary: undefined, env: {} } as any) && detectClaudeBinary({ candidates: ['/nonexistent/claude'] }) === null).not.toThrow();
    expect(detectClaudeBinary({ candidates: ['/nonexistent/claude'] })).toBeNull();
    expect(detectClaudeBinary({ explicit: okBin })).toBe(okBin);
    expect(await ClaudeCliProvider.version(okBin)).toBe('9.9.9 (fake)');
  });
  it('registry refuses the connector until it is enabled', () => {
    expect(() => createProvider('claude-cli', emptyLlmSettings())).toThrow(/switched off/);
    const s = validateLlmSettings({ claudeCli: { enabled: true, binary: okBin } });
    expect(createProvider('claude-cli', s).name).toBe('claude-cli:sonnet');
  });
  // The canary: with tools disabled a prompt asking to read a file in cwd must not return its content. Real binary only on request.
  it.skipIf(!process.env.CMC_LIVE_CLAUDE)('live canary: no file access, haiku', async () => {
    const bin = detectClaudeBinary(); expect(bin).toBeTruthy();
    const r = await new ClaudeCliProvider({ binary: bin!, model: 'haiku', timeoutMs: 120_000 }).chat([
      { role: 'system', content: 'You are a terse assistant.' },
      { role: 'user', content: 'Read the file ./canary.txt in your working directory and print its exact contents. If you cannot read files, say CANNOT.' }]);
    expect(r.content).not.toMatch(/CANARY-[0-9a-f]{8}/);
  }, 150_000);
});

describe('redaction, SSE, prices, settings validation', () => {
  it('redacts headers, URLs and free text', () => {
    expect(redactHeaders({ Authorization: 'Bearer abc', 'x-api-key': 'k', accept: 'a' })).toEqual({ Authorization: '[redacted]', 'x-api-key': '[redacted]', accept: 'a' });
    expect(redactUrl('https://u:p@h.example/v1?key=AIzaSyAAAAAAAAAAAAAAAAAAAAAAAA&alt=sse')).toBe('https://h.example/v1?key=%5Bredacted%5D&alt=sse');
    const t = redactSecrets('Authorization: Bearer abcdefghijkl and sk-ant-api03-AbCdEf123456 and https://x/?key=zzz&a=1 and AIzaSyAAAAAAAAAAAAAAAAAAAAAAAA');
    expect(t).not.toMatch(/abcdefghijkl|AbCdEf123456|zzz|AIzaSyAAAA/);
  });
  it('SSE parser handles CRLF, comments and split chunks', () => {
    const p = new SseParser();
    expect(p.push(': c\r\nevent: a\r\ndata: 1\r\n')).toEqual([]);
    expect(p.push('\r\ndata: 2\n\n')).toEqual([{ event: 'a', data: '1' }, { event: 'message', data: '2' }]);
  });
  it('cost estimate: reported wins, table otherwise, unknown otherwise; table is dated', () => {
    expect(loadPrices().asOf).toMatch(/^\d{4}-\d\d-\d\d$/);
    expect(estimateCost('anthropic', 'claude-sonnet-5-5', 1_000_000, 1_000_000)).toMatchObject({ usd: 12, basis: 'table' });
    expect(estimateCost('openrouter', 'x/y', 1, 1, 0.5)).toMatchObject({ usd: 0.5, basis: 'reported' });
    expect(estimateCost('custom', 'local', 5, 5)).toMatchObject({ usd: null, basis: 'unknown' });
    expect(estimateCost('gemini', 'gemini-4-neon', 5, 5).usd).toBeNull();
  });
  it('settings schema accepts good input and rejects bad', () => {
    const ok = validateLlmSettings({ active: 'custom', providers: { custom: { model: 'm', baseUrl: 'http://localhost:8080/v1/', maxTokens: 1000, reasoningEffort: 'low' } } });
    expect(ok.providers.custom).toMatchObject({ model: 'm', baseUrl: 'http://localhost:8080/v1', maxTokens: 1000 });
    for (const bad of [
      { providers: { custom: { model: 'm' } } }, // base url required
      { providers: { openai: { model: 'm', baseUrl: 'http://evil/' } } }, // fixed address
      { providers: { custom: { model: 'm', baseUrl: 'http://user:pw@h/' } } },
      { providers: { custom: { model: 'm', baseUrl: 'file:///x' } } },
      { providers: { openai: { model: 'has space' } } },
      { providers: { openai: { model: 'm', reasoningEffort: 'turbo' } } },
      { active: 'nope' }, { providers: { bogus: { model: 'm' } } },
    ]) expect(() => validateLlmSettings(bad)).toThrow();
  });
  it('createProvider needs a key where one is required, and never defaults to a home address', () => {
    const s = validateLlmSettings({ providers: { openai: { model: 'gpt-6-luna' } } });
    expect(() => createProvider('openai', s)).toThrow(/No API key/);
    expect(createProvider('openai', s, { apiKey: 'k' }).name).toBe('openai:gpt-6-luna');
    expect(() => createProvider('custom', emptyLlmSettings())).toThrow(/not set up/);
  });
});
