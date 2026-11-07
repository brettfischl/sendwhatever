import type pg from 'pg';
import type { Llm } from './llm.js';

export interface GeneratorSettings {
  /** How long to wait after finding nothing to claim. */
  pollMs: number;
  /** Attempts at once in this process. Each runs the sandbox, so this also limits child processes. */
  concurrency: number;
  /** Attempts at once per account, across all processes (§12.1). */
  accountConcurrency: number;
  /** Adapters that may pass validation and then fail in replay before a shape waits for an operator. */
  generationCap: number;
  /** LLM requests one attempt may make for an adapter, retrying with gate errors. */
  llmTries: number;
  /** The wait between tries, which then doubles. */
  tryBackoffBaseMs: number;
  tryBackoffMaxMs: number;
  /** The wait after a shape's first failed attempt, which then doubles until one succeeds. */
  attemptBackoffBaseMs: number;
  attemptBackoffMaxMs: number;
  /** One LLM request's limit. */
  llmTimeoutMs: number;
  /** Same-kind-of-record checks one attempt may make before it generates instead. */
  sameKindChecks: number;
  /** How long an attempt may stay `running`. Must exceed everything it can wait on, which start checks. */
  staleAttemptMs: number;
  /** Only work on this account's shapes. */
  accountId?: string | undefined;
  log: (message: string) => void;
}

export const DEFAULT_GENERATOR_SETTINGS: GeneratorSettings = {
  pollMs: 1_000,
  concurrency: 4,
  accountConcurrency: 2,
  generationCap: 3,
  llmTries: 3,
  tryBackoffBaseMs: 2_000,
  tryBackoffMaxMs: 30_000,
  attemptBackoffBaseMs: 30_000,
  attemptBackoffMaxMs: 60 * 60 * 1000,
  llmTimeoutMs: 120_000,
  sameKindChecks: 3,
  staleAttemptMs: 30 * 60 * 1000,
  log: (message) => console.error(`[generator] ${message}`),
};

export interface GeneratorContext {
  db: pg.Pool;
  llm: Llm;
  settings: GeneratorSettings;
  /** Aborts when the generator stops. */
  signal: AbortSignal;
}

/** Throws if a live attempt could be mistaken for a stale one and have its shape taken over. */
export function checkSettings(settings: GeneratorSettings): void {
  const llmWait = (settings.llmTries + settings.sameKindChecks) * settings.llmTimeoutMs;
  const backoff = settings.llmTries * settings.tryBackoffMaxMs;
  if (settings.staleAttemptMs <= llmWait + backoff) {
    throw new Error(`staleAttemptMs must be over ${llmWait + backoff}, the longest an attempt can wait on the LLM`);
  }
}
