// The Adapter Generator (PRD §12.1): a continuous process that turns quarantined shapes into live
// adapters with no human involved. Many can run at once, since claims are made in the database.
import { setTimeout as sleep } from 'node:timers/promises';
import pg from 'pg';
import type { Config } from '../config.js';
import { runAttempt } from './attempt.js';
import { createFireworksLlm, type Llm } from './llm.js';
import { claimNext } from './poll.js';
import { checkSettings, DEFAULT_GENERATOR_SETTINGS, type GeneratorContext, type GeneratorSettings } from './settings.js';

export { runAttempt } from './attempt.js';
export { createFireworksLlm, LlmUnavailableError } from './llm.js';
export type { Llm, LlmCompletion, LlmMessage } from './llm.js';
export { claimNext } from './poll.js';
export type { AttemptOutcome, Claim } from './poll.js';
export { DEFAULT_GENERATOR_SETTINGS } from './settings.js';
export type { GeneratorContext, GeneratorSettings } from './settings.js';

/** The Fireworks LLM from config. Throws if no key is set, so a process can fail with a clear error. */
export function fireworksFromConfig(
  config: Pick<Config, 'fireworksApiKey' | 'fireworksModel' | 'fireworksReasoningEffort'>,
  log: (message: string) => void = DEFAULT_GENERATOR_SETTINGS.log,
): Llm {
  if (!config.fireworksApiKey) throw new Error('FIREWORKS_API_KEY is not set, so the generator cannot call its LLM.');
  return createFireworksLlm({
    apiKey: config.fireworksApiKey,
    model: config.fireworksModel,
    reasoningEffort: config.fireworksReasoningEffort,
    log,
  });
}

/** Claims and runs everything ready now, and waits for it. For tests, and one-shot use. */
export async function pollOnce(context: GeneratorContext): Promise<number> {
  const running: Promise<unknown>[] = [];
  for (;;) {
    const claim = await claimNext(context.db, context.settings);
    if (!claim) break;
    running.push(runAttempt(context, claim));
  }
  await Promise.all(running);
  return running.length;
}

export interface GeneratorOptions extends Partial<GeneratorSettings> {
  /** The application database. */
  databaseUrl: string;
  llm: Llm;
}

export interface Generator {
  /** Stops claiming, ends running attempts, and closes connections. Safe to call twice. */
  stop(): Promise<void>;
}

export function startGenerator(options: GeneratorOptions): Generator {
  const { databaseUrl, llm, ...overrides } = options;
  const settings: GeneratorSettings = { ...DEFAULT_GENERATOR_SETTINGS, ...overrides };
  checkSettings(settings);

  const db = new pg.Pool({
    connectionString: databaseUrl,
    // An attempt uses few at once: a gate loads its samples and registries side by side.
    max: settings.concurrency * 3 + 2,
    keepAlive: true,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 45_000,
    query_timeout: 50_000,
  });
  // Without a listener, a dropped idle connection would crash the process.
  db.on('error', (error) => settings.log(`Lost an idle database connection: ${error.message}`));

  const stopping = new AbortController();
  const context: GeneratorContext = { db, llm, settings, signal: stopping.signal };
  const running = new Set<Promise<void>>();

  const run = async () => {
    while (!stopping.signal.aborted) {
      let claimed = false;
      if (running.size < settings.concurrency) {
        try {
          const claim = await claimNext(db, settings);
          if (claim) {
            claimed = true;
            const attempt: Promise<void> = runAttempt(context, claim)
              .then(
                () => {},
                (error: Error) => settings.log(`Could not record attempt ${claim.attemptId}: ${error.name}`),
              )
              .finally(() => running.delete(attempt));
            running.add(attempt);
          }
        } catch (error) {
          settings.log(`Could not poll for shapes: ${(error as Error).name}`);
        }
      }
      if (!claimed) await sleep(settings.pollMs, undefined, { signal: stopping.signal }).catch(() => {});
    }
  };
  const loop = run();

  let stopped: Promise<void> | undefined;
  return {
    stop() {
      stopped ??= (async () => {
        stopping.abort();
        await loop;
        await Promise.all(running);
        await db.end();
      })();
      return stopped;
    },
  };
}
