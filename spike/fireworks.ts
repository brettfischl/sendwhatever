// The Fireworks client for the spike, with the limits it was given: at most 150 calls in total across
// all runs, at most 4 at once, and a full stop on the first API error instead of retrying into it.
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const RESULTS_DIR = join(HERE, 'results');
const BUDGET_PATH = join(RESULTS_DIR, 'budget.json');
const ENDPOINT = 'https://api.fireworks.ai/inference/v1/chat/completions';

export const MODEL = 'accounts/fireworks/models/deepseek-v4p1-flash';
// Overridable per run, since finding a workable setting is part of the spike. Both go in the results.
export const MAX_TOKENS = Number(process.env.SPIKE_MAX_TOKENS ?? 8000);
export const REASONING_EFFORT = process.env.SPIKE_REASONING_EFFORT || undefined;
const MAX_CALLS = 150;
const MAX_CONCURRENT = 4;
const TIMEOUT_MS = 300_000;

export interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface Completion {
  content: string | null;
  reasoning: string | null;
  finishReason: string | null;
  ms: number;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number | null;
}

/** Fireworks returned an error, or couldn't be reached. Nothing else should be sent. */
export class FireworksStop extends Error {
  override name = 'FireworksStop';
}

function loadKey(): string {
  const env = readFileSync(join(HERE, '..', '.env'), 'utf8');
  const match = /^FIREWORKS_API_KEY=(.*)$/m.exec(env);
  if (!match?.[1]) throw new FireworksStop('FIREWORKS_API_KEY is missing from .env');
  return match[1].trim().replace(/^["']|["']$/g, '');
}

const apiKey = loadKey();

// The call counter and the concurrency cap are per process, so a second process would break both limits.
const LOCK_PATH = join(RESULTS_DIR, '.lock');
mkdirSync(RESULTS_DIR, { recursive: true });
try {
  closeSync(openSync(LOCK_PATH, 'wx'));
} catch {
  throw new FireworksStop(`Another spike run holds ${LOCK_PATH}`);
}
process.on('exit', () => rmSync(LOCK_PATH, { force: true }));

function readBudget(): number {
  try {
    return (JSON.parse(readFileSync(BUDGET_PATH, 'utf8')) as { calls: number }).calls;
  } catch {
    return 0;
  }
}

let calls = readBudget();
let stopped: string | null = null;
let running = 0;
const waiting: (() => void)[] = [];

export const callsUsed = () => calls;
export const callsLeft = () => MAX_CALLS - calls;

async function acquire(): Promise<void> {
  if (running < MAX_CONCURRENT) {
    running += 1;
    return;
  }
  await new Promise<void>((resolve) => waiting.push(resolve));
}

function release(): void {
  const next = waiting.shift();
  if (next) next();
  else running -= 1;
}

export async function complete(messages: Message[]): Promise<Completion> {
  await acquire();
  try {
    if (stopped) throw new FireworksStop(stopped);
    if (calls >= MAX_CALLS) throw new FireworksStop(`Call budget of ${MAX_CALLS} is used up`);
    calls += 1;
    mkdirSync(RESULTS_DIR, { recursive: true });
    writeFileSync(BUDGET_PATH, JSON.stringify({ calls }));

    const startedAt = Date.now();
    let response: Response;
    try {
      response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: MAX_TOKENS,
          messages,
          ...(REASONING_EFFORT ? { reasoning_effort: REASONING_EFFORT } : {}),
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      stopped = `Fireworks request failed: ${(error as Error).message}`;
      throw new FireworksStop(stopped);
    }
    const text = await response.text();
    if (!response.ok) {
      stopped = `Fireworks returned ${response.status}: ${text.slice(0, 300).replaceAll(apiKey, '[key]')}`;
      throw new FireworksStop(stopped);
    }

    const json = JSON.parse(text) as {
      choices: { message: { content: string | null; reasoning_content?: string | null }; finish_reason: string | null }[];
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        completion_tokens_details?: { reasoning_tokens?: number };
      };
    };
    const choice = json.choices[0];
    return {
      content: choice?.message.content ?? null,
      reasoning: choice?.message.reasoning_content ?? null,
      finishReason: choice?.finish_reason ?? null,
      ms: Date.now() - startedAt,
      promptTokens: json.usage?.prompt_tokens ?? 0,
      completionTokens: json.usage?.completion_tokens ?? 0,
      reasoningTokens: json.usage?.completion_tokens_details?.reasoning_tokens ?? null,
    };
  } finally {
    release();
  }
}
