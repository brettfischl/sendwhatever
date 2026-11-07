// Runs the spike. Usage:
//   tsx spike/run.ts check                              fixtures and carry claims, no model calls
//   tsx spike/run.ts independent <label> <repeats> [scenario,...]
//   tsx spike/run.ts continuity <label> <repeats>
// Results are appended to spike/results/<label>.jsonl, one line per attempt.
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fingerprint, shapeOf } from '../src/fingerprint/index.js';
import { runGate } from '../src/adapters/gate.js';
import type { RegisteredColumns } from '../src/planner/registry.js';
import { evaluate, planFor, toSample, type Evaluation } from './evaluate.js';
import { callsLeft, callsUsed, complete, FireworksStop, MAX_TOKENS, REASONING_EFFORT, RESULTS_DIR, type Message } from './fireworks.js';
import { continuitySequence, HEADERS, scenarios, sponsorNoPath, type Scenario } from './fixtures.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SYSTEM_PROMPT = readFileSync(join(HERE, 'prompt.md'), 'utf8');
const MAX_ATTEMPTS = 3;

export function stripFences(text: string): string {
  const fenced = /```(?:[a-zA-Z]+)?\s*\n([\s\S]*?)```/.exec(text);
  return (fenced?.[1] ?? text).trim();
}

export function parseReply(text: string): { code: string; opaquePaths: string[]; opaqueParseError: boolean } {
  const code = stripFences(text);
  const declared = /^\s*\/\/\s*opaque_paths:\s*(\[.*\])\s*$/m.exec(code);
  if (!declared) return { code, opaquePaths: [], opaqueParseError: true };
  try {
    return { code, opaquePaths: JSON.parse(declared[1]!) as string[], opaqueParseError: false };
  } catch {
    return { code, opaquePaths: [], opaqueParseError: true };
  }
}

function schemaJson(registered: RegisteredColumns): Record<string, Record<string, string>> {
  return Object.fromEntries([...registered].map(([table, columns]) => [table, Object.fromEntries(columns)]));
}

function userMessage(scenario: Scenario, registered: RegisteredColumns): string {
  const { method, path, body } = scenario.sample;
  const input = {
    op: method === 'DELETE' ? 'delete' : 'write',
    registered_schema: schemaJson(registered),
    samples: [{ method, path, query: '', headers: HEADERS, body }],
    sample_shape: shapeOf(body),
    sibling_shapes: (scenario.siblings ?? []).map((sibling) => shapeOf(sibling)),
  };
  return `Write the adapter for this shape.\n<data>\n${JSON.stringify(input, null, 2)}\n</data>`;
}

function retryMessage(evaluation: Evaluation): string {
  const errors = evaluation.failures.map(({ code, detail }) => ({ code, detail }));
  return `That adapter failed validation. Return the complete corrected adapter.\n<data>\n${JSON.stringify({ errors }, null, 2)}\n</data>`;
}

interface Attempt {
  attempt: number;
  ok: boolean;
  code: string | null;
  opaquePaths: string[];
  evaluation: Evaluation | null;
}

interface RunContext {
  label: string;
  mode: 'independent' | 'continuity';
  repeat: number;
  step?: number;
}

function record(label: string, entry: object): void {
  mkdirSync(RESULTS_DIR, { recursive: true });
  appendFileSync(join(RESULTS_DIR, `${label}.jsonl`), `${JSON.stringify(entry)}\n`);
}

/** Generates with up to three attempts, sending gate errors back, as §12.1 describes. */
async function generate(scenario: Scenario, registered: RegisteredColumns, context: RunContext): Promise<Attempt | null> {
  const messages: Message[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userMessage(scenario, registered) },
  ];
  let last: Attempt | null = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const completion = await complete(messages);
    const base = {
      ...context,
      scenario: scenario.name,
      group: scenario.group,
      attempt,
      maxTokens: MAX_TOKENS,
      effort: REASONING_EFFORT ?? 'default',
      finishReason: completion.finishReason,
      ms: completion.ms,
      promptTokens: completion.promptTokens,
      completionTokens: completion.completionTokens,
      reasoningTokens: completion.reasoningTokens,
      // Kept only where it's the evidence, to keep the results small.
      ...(scenario.group === 'injection' || process.env.SPIKE_KEEP_REASONING ? { reasoning: completion.reasoning } : {}),
    };

    if (completion.finishReason === 'length' || !completion.content?.trim()) {
      record(context.label, { ...base, ok: false, generationFailure: completion.finishReason ?? 'empty', raw: completion.content });
      last = { attempt, ok: false, code: null, opaquePaths: [], evaluation: null };
      continue;
    }

    const { code, opaquePaths, opaqueParseError } = parseReply(completion.content);
    const evaluation = await evaluate(scenario, code, opaquePaths, registered);
    record(context.label, { ...base, ok: evaluation.gateOk, opaqueParseError, code, opaquePaths, evaluation });
    last = { attempt, ok: evaluation.gateOk, code, opaquePaths, evaluation };
    if (evaluation.gateOk) return last;

    messages.push({ role: 'assistant', content: completion.content }, { role: 'user', content: retryMessage(evaluation) });
  }
  return last;
}

function addToRegistry(registered: RegisteredColumns, attempt: Attempt): void {
  for (const { table, columns } of attempt.evaluation?.plan ?? []) {
    const known = registered.get(table) ?? new Map();
    registered.set(table, known);
    for (const [column, type] of Object.entries(columns)) {
      if (!known.has(column)) known.set(column, type as never);
    }
    // data_columns includes id as each table's existence marker.
    if (!known.has('id')) known.set('id', 'string' as never);
  }
}

const tablesHolding = (attempt: Attempt): Record<string, string[]> =>
  Object.fromEntries((attempt.evaluation?.plan ?? []).map(({ table, columns }) => [table, Object.keys(columns)]));

async function runIndependent(label: string, repeats: number, names: string[] | null): Promise<void> {
  const chosen = names ? scenarios.filter((scenario) => names.includes(scenario.name)) : scenarios;
  const jobs = chosen.flatMap((scenario) =>
    Array.from({ length: repeats }, (_, repeat) => generate(scenario, new Map(), { label, mode: 'independent', repeat })),
  );
  const results = await Promise.allSettled(jobs);
  throwIfStopped(results);
}

interface ActiveAdapter {
  scenario: string;
  source: string;
  op: 'write' | 'delete';
  code: string;
  opaquePaths: string[];
}

const sourceOf = (path: string) => path.split('/').filter(Boolean)[1] ?? '';

/**
 * §12.1 step 2: the platform runs active adapters for this (source, op) through the gate before calling
 * the LLM. The spike records which would pass and where the rows would land, and then calls the LLM anyway
 * so that every step produces data about the model.
 */
async function checkReuse(scenario: Scenario, active: ActiveAdapter[], registered: RegisteredColumns, label: string, repeat: number, step: number) {
  const op = scenario.sample.method === 'DELETE' ? 'delete' : 'write';
  const source = sourceOf(scenario.sample.path);
  const sample = toSample(scenario.sample);
  for (const adapter of active.filter((candidate) => candidate.source === source && candidate.op === op)) {
    const gate = await runGate({ adapter: { code: adapter.code, op, opaquePaths: adapter.opaquePaths }, samples: [sample], registries: new Map([['spike-store', registered]]) });
    const plan = gate.samples[0]?.output ? planFor(gate.samples[0].output, sample, adapter.opaquePaths) : null;
    record(label, {
      kind: 'reuse_check',
      repeat,
      step,
      scenario: scenario.name,
      candidate: adapter.scenario,
      wouldPassGate: gate.ok,
      failures: gate.failures.slice(0, 3),
      tables: plan?.tables.map(({ table, rows }) => ({ table, ids: rows.map((row) => row.id).slice(0, 3) })),
    });
  }
}

async function runContinuity(label: string, repeats: number): Promise<void> {
  const one = async (repeat: number) => {
    const registered: RegisteredColumns = new Map();
    const active: ActiveAdapter[] = [];
    for (const [step, scenario] of continuitySequence.entries()) {
      await checkReuse(scenario, active, registered, label, repeat, step);
      const before = schemaJson(registered);
      const attempt = await generate(scenario, registered, { label, mode: 'continuity', repeat, step });
      record(label, {
        kind: 'continuity_step',
        repeat,
        step,
        scenario: scenario.name,
        ok: attempt?.ok ?? false,
        attempts: attempt?.attempt ?? 0,
        tablesBefore: Object.keys(before),
        tablesWritten: attempt ? tablesHolding(attempt) : {},
      });
      if (attempt?.ok && attempt.code) {
        addToRegistry(registered, attempt);
        active.push({
          scenario: scenario.name,
          source: sourceOf(scenario.sample.path),
          op: scenario.sample.method === 'DELETE' ? 'delete' : 'write',
          code: attempt.code,
          opaquePaths: attempt.opaquePaths,
        });
      }
    }
    // A no-path sponsor has the speaker's exact (source, op, fingerprint), so no LLM call happens at all.
    const speaker = active.find((adapter) => adapter.scenario === 'speaker_no_path');
    if (speaker) {
      const sample = toSample(sponsorNoPath.sample);
      const gate = await runGate({ adapter: { code: speaker.code, op: 'write', opaquePaths: speaker.opaquePaths }, samples: [sample], registries: new Map([['spike-store', registered]]) });
      const plan = gate.samples[0]?.output ? planFor(gate.samples[0].output, sample, speaker.opaquePaths) : null;
      record(label, { kind: 'lookalike_collision', repeat, wouldPassGate: gate.ok, tables: plan?.tables.map(({ table, rows }) => ({ table, ids: rows.map((row) => row.id) })) });
    }
    record(label, { kind: 'continuity_end', repeat, schema: schemaJson(registered) });
  };
  const results = await Promise.allSettled(Array.from({ length: repeats }, (_, repeat) => one(repeat)));
  throwIfStopped(results);
}

function throwIfStopped(results: PromiseSettledResult<unknown>[]): void {
  const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failure) throw failure.reason;
}

function checkFixtures(): void {
  let bad = 0;
  for (const scenario of [...scenarios, ...continuitySequence]) {
    const options = { opaquePaths: scenario.holdoutOpaque ?? [] };
    const same = fingerprint(scenario.sample.body, options) === fingerprint(scenario.holdout.body, options);
    if (!same) {
      bad += 1;
      console.log(`SHAPE MISMATCH ${scenario.name}\n  ${shapeOf(scenario.sample.body, options)}\n  ${shapeOf(scenario.holdout.body, options)}`);
    }
  }
  console.log(bad === 0 ? 'Every holdout has its sample\'s fingerprint.' : `${bad} fixtures are wrong.`);
  if (fingerprint(scenarios.find((s) => s.name === 'speaker_no_path')!.sample.body) !== fingerprint(sponsorNoPath.sample.body)) {
    console.log('Lookalikes should share a fingerprint, and do not.');
  }
}

const [command, label, repeats, names] = process.argv.slice(2);
try {
  if (command === 'check') checkFixtures();
  else if (command === 'independent') await runIndependent(label!, Number(repeats), names ? names.split(',') : null);
  else if (command === 'continuity') await runContinuity(label!, Number(repeats));
  else throw new Error('Unknown command');
  console.log(`Done. Calls used so far: ${callsUsed()}, left: ${callsLeft()}.`);
} catch (error) {
  if (error instanceof FireworksStop) {
    console.error(`STOPPED: ${error.message}. Calls used so far: ${callsUsed()}.`);
    process.exit(2);
  }
  throw error;
}
