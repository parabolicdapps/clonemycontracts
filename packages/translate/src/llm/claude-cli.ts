import { spawn } from 'node:child_process';
import { accessSync, constants, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { BaseProvider, LlmError, redactSecrets, type Attempt, type BaseOptions } from './common.js';
import type { ChatMessage, ChatOptions } from './provider.js';

/**
 * EXPERIMENTAL, OFF BY DEFAULT. Runs the user's own, unmodified `claude` binary under the user's own login.
 * This code never reads, copies or stores Claude Code's credentials; it only starts the program and reads its stdout.
 * Whether this use is allowed is governed by Anthropic's terms, which the user has to check.
 */
export const CLAUDE_CANDIDATES = (home = homedir()) => [
  join(home, '.local', 'bin', 'claude'), join(home, '.claude', 'local', 'claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude',
];

const isExecutable = (p: string) => { try { accessSync(p, constants.X_OK); return true; } catch { return false; } };

/** GUI apps have no shell PATH, so look at the usual absolute install paths. `explicit` (a user setting) wins. */
export function detectClaudeBinary(o: { explicit?: string; candidates?: string[] } = {}): string | null {
  if (o.explicit) return isExecutable(o.explicit) ? o.explicit : null;
  for (const c of o.candidates ?? CLAUDE_CANDIDATES()) if (isExecutable(c)) return c;
  return null;
}

/** Fresh empty directory outside any CLAUDE.md ancestry: tmpdir() is under /var/folders or /tmp, never under a project. */
const freshDir = () => mkdtempSync(join(tmpdir(), 'cmc-claude-'));

const STRIP_ENV = /^(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_BASE_URL|CLAUDE_CODE_OAUTH_TOKEN|CLAUDECODE|CLAUDE_CODE_ENTRYPOINT|CLAUDE_CONFIG_DIR)$/;

/** the child inherits the environment except variables that would redirect it to another account or endpoint */
export function cliEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !STRIP_ENV.test(k)));
}

export function claudeArgs(model: string, system: string): string[] {
  return ['-p', '--output-format', 'json', '--tools', '', '--system-prompt', system, '--no-session-persistence', '--disable-slash-commands',
    '--setting-sources', '', '--strict-mcp-config', '--model', model];
}

/** Flattens a chat into one prompt: a single user message goes through unchanged, longer chats become a labelled transcript. */
export function renderPrompt(messages: ChatMessage[]): { system: string; prompt: string } {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const rest = messages.filter((m) => m.role !== 'system');
  const prompt = rest.length === 1 && rest[0]!.role === 'user' ? rest[0]!.content : rest.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}:\n${m.content}`).join('\n\n') + '\n\nAssistant:';
  return { system, prompt };
}

export interface ClaudeCliOptions extends BaseOptions {
  /** absolute path; default: detected */
  binary?: string;
  /** model alias, e.g. haiku | sonnet | opus (default: sonnet) */
  model?: string;
  /** hard cap per call (default 20 min) */
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export interface CliJson { result?: string; is_error?: boolean; subtype?: string; usage?: Record<string, number>; total_cost_usd?: number; modelUsage?: Record<string, unknown>; duration_ms?: number }

export class ClaudeCliProvider extends BaseProvider {
  readonly name: string;
  readonly binary: string;
  private model: string;
  private timeoutMs: number;
  private env: NodeJS.ProcessEnv;
  constructor(o: ClaudeCliOptions = {}) {
    super({ concurrency: 1, retries: 0, ...o });
    const bin = o.binary ?? detectClaudeBinary();
    if (!bin) throw new LlmError('unavailable', 'Claude Code was not found. Install it, or set its path in the settings.');
    this.binary = bin;
    this.model = o.model ?? 'sonnet';
    this.timeoutMs = o.timeoutMs ?? 20 * 60_000;
    this.env = cliEnv(o.env);
    this.name = `claude-cli:${this.model}`;
  }

  protected logBody(messages: ChatMessage[]) { const r = renderPrompt(messages); return { model: this.model, system: r.system, prompt: r.prompt }; }

  protected attempt(messages: ChatMessage[], co: ChatOptions, signal: AbortSignal | undefined): Promise<Attempt> {
    const { system, prompt } = renderPrompt(messages);
    const cwd = freshDir();
    return new Promise<Attempt>((resolve, reject) => {
      const child = spawn(this.binary, claudeArgs(this.model, system), { cwd, env: this.env, stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '', err = '', done = false;
      const finish = (f: () => void) => { if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort); rmSync(cwd, { recursive: true, force: true }); f(); };
      const kill = () => { child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 3000).unref(); };
      const timer = setTimeout(() => { kill(); finish(() => reject(new LlmError('timeout', `Claude Code did not finish within ${Math.round(this.timeoutMs / 1000)} s`))); }, this.timeoutMs);
      const onAbort = () => { kill(); finish(() => reject(new LlmError('aborted', 'aborted'))); };
      signal?.addEventListener('abort', onAbort);
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (err += d));
      child.on('error', (e) => finish(() => reject(new LlmError('unavailable', `could not start Claude Code: ${e.message}`))));
      child.on('close', (code) => finish(() => {
        let j: CliJson | null = null;
        try { j = JSON.parse(out); } catch { /* handled below */ }
        const text = typeof j?.result === 'string' ? j.result : '';
        if (j?.is_error || (code !== 0 && !j)) {
          if (/not logged in|\/login/i.test(text + err)) return reject(new LlmError('auth', 'Claude Code is not logged in. Run `claude` once in a terminal and use /login.'));
          return reject(new LlmError('server', `Claude Code failed${j?.subtype ? ` (${j.subtype})` : ''}: ${redactSecrets((text || err).slice(0, 300))}`));
        }
        if (!j) return reject(new LlmError('server', `Claude Code returned output that is not JSON (exit ${code})`));
        const u = j.usage ?? {};
        const tokensIn = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
        resolve({ content: text, reasoningChars: 0, finish: j.subtype === 'success' || !j.subtype ? 'stop' : j.subtype, tokensIn, tokensOut: u.output_tokens ?? 0, model: Object.keys(j.modelUsage ?? {})[0], ...(typeof j.total_cost_usd === 'number' ? { reportedCostUsd: j.total_cost_usd } : {}) });
      }));
      child.stdin.on('error', () => { /* the child may exit before reading */ });
      child.stdin.end(prompt);
    });
  }

  /** `claude --version` from a fresh directory. */
  static version(binary: string): Promise<string | null> {
    return new Promise((resolve) => {
      const cwd = freshDir();
      const c = spawn(binary, ['--version'], { cwd, env: cliEnv(), stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      const t = setTimeout(() => c.kill('SIGKILL'), 10_000);
      c.stdout.on('data', (d) => (out += d));
      const end = (v: string | null) => { clearTimeout(t); rmSync(cwd, { recursive: true, force: true }); resolve(v); };
      c.on('error', () => end(null));
      c.on('close', () => end(out.trim() || null));
    });
  }
}
