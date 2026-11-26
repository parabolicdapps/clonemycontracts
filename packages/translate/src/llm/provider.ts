export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string }

export interface ChatResult {
  content: string;
  tokensIn: number;
  tokensOut: number;
  reasoningChars: number;
  finish: string | null;
  secs: number;
  /** model id the provider reports having served (when it says) */
  model?: string;
  /** cost the provider itself reported for this call, USD (OpenRouter `usage.cost`, Claude Code `total_cost_usd`); absent when it did not */
  reportedCostUsd?: number;
}

export interface ChatOptions {
  /** label used in the request log file name */
  label?: string;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  /** abort when no model token arrives for this long (per request; default: the client's 300 s) */
  readTimeoutMs?: number;
  /** hard cap on the whole request (a request that keeps reasoning for 20 minutes is not viable) */
  totalTimeoutMs?: number;
  /** retries after a failed attempt (default: the client's) */
  retries?: number;
}

export interface LlmUsage { requests: number; tokensIn: number; tokensOut: number; modelSecs: number }

/** A pluggable model provider. The pipeline only depends on this interface. */
export interface LlmProvider {
  readonly name: string;
  chat(messages: ChatMessage[], opts?: ChatOptions): Promise<ChatResult>;
  /** cumulative usage for the report */
  usage(): LlmUsage;
}
