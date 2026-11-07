// One attempt at a claimed shape (PRD §12.1 steps 2 to 5): finish what's already there, reuse an adapter
// if one fits, and only then ask the LLM for a new one. Never logs or records a payload value, and gate
// errors quote them, so the attempt's `detail` holds only their codes.
import { setTimeout as sleep } from 'node:timers/promises';
import {
  activateAdapter,
  checkOpaquePaths,
  createAdapter,
  gateAdapter,
  getAdapter,
  loadRegistries,
  loadSamples,
  markValidated,
  runGate,
  validateAndActivate,
  type AdapterRow,
  type GateFailure,
  type GateSample,
} from '../adapters/index.js';
import type { AdapterRequest } from '../contracts/index.js';
import { fingerprint, shapeOf } from '../fingerprint/index.js';
import { findAdapter } from '../worker/match.js';
import { backoffMs, enqueueReplay } from '../worker/queue.js';
import { LlmUnavailableError, type LlmCompletion, type LlmMessage } from './llm.js';
import { shapesOverlap } from './overlap.js';
import { finishAttempt, inTransaction, linkAttempt, stillRunning, type AttemptOutcome, type Claim } from './poll.js';
import { generationMessages, parseReply, parseSameKind, retryMessage, sameKindMessages } from './prompt.js';
import type { GeneratorContext } from './settings.js';

/** Active adapters tried for reuse, newest first. Each runs in the sandbox, so this stays small. */
const MAX_REUSE_CANDIDATES = 5;
const MAX_VALIDATED_SHAPES = 20;
const MAX_SAME_KIND_EXAMPLES = 2;

function parseBody(sample: GateSample): unknown {
  return sample.body === null ? null : JSON.parse(sample.body);
}

/** Enough to act on, without an error's message, which could quote a value from the database. */
function describeError(error: unknown): string {
  if (error instanceof LlmUnavailableError) return error.message;
  const { name, code } = error as { name?: string; code?: string };
  return `${name ?? 'Error'}${code ? ` (${code})` : ''}`;
}

function callLlm(context: GeneratorContext, messages: readonly LlmMessage[], signal: AbortSignal): Promise<LlmCompletion> {
  return context.llm.complete(messages, AbortSignal.any([signal, AbortSignal.timeout(context.settings.llmTimeoutMs)]));
}

/** A validated, inactive adapter that hasn't been replaced, if one covers this shape. */
async function findWaitingAdapter(context: GeneratorContext, claim: Claim, sample: GateSample) {
  const result = await context.db.query<{
    id: string;
    fingerprint: string;
    opaque_paths: string[];
    exact: boolean;
    left_behind: boolean;
  }>(
    `SELECT a.id, a.fingerprint, a.opaque_paths,
       a.fingerprint = $4 OR EXISTS (
         SELECT 1 FROM adapter_fingerprints f WHERE f.adapter_id = a.id AND f.fingerprint = $4) AS exact,
       EXISTS (SELECT 1 FROM adapter_attempts t WHERE t.adapter_id = a.id AND t.status = 'failed') AS left_behind
     FROM adapters a
     WHERE a.account_id = $1 AND a.source = $2 AND a.op = $3
       AND a.validated_at IS NOT NULL AND NOT a.active AND a.superseded_at IS NULL
     ORDER BY a.created_at DESC`,
    [claim.accountId, claim.source, claim.op, claim.fingerprint],
  );
  return result.rows.find((row) => {
    if (row.exact) return true;
    try {
      return fingerprint(parseBody(sample), { opaquePaths: row.opaque_paths }) === row.fingerprint;
    } catch {
      return false;
    }
  });
}

async function recordFingerprint(context: GeneratorContext, adapterId: string, shape: string): Promise<void> {
  await context.db.query(
    'INSERT INTO adapter_fingerprints (adapter_id, fingerprint) VALUES ($1, $2) ON CONFLICT DO NOTHING',
    [adapterId, shape],
  );
}

/**
 * Handles a validated adapter that isn't live. If an earlier attempt of ours left it behind, this finishes
 * the activation, and retires it if it no longer passes. Otherwise it's an operator's call: this only
 * records the shape, so the poll stops offering it.
 */
async function settleWaitingAdapter(
  context: GeneratorContext,
  claim: Claim,
  sample: GateSample,
): Promise<AttemptOutcome | null> {
  const waiting = await findWaitingAdapter(context, claim, sample);
  if (!waiting) return null;
  if (!(claim.autoActivate && waiting.left_behind)) {
    await recordFingerprint(context, waiting.id, claim.fingerprint);
    return { status: 'succeeded', adapterId: waiting.id, detail: 'Waiting for an operator to activate an adapter.' };
  }
  const activated = await validateAndActivate(context.db, waiting.id);
  if (activated.status === 'activated') {
    return { status: 'succeeded', adapterId: waiting.id, detail: 'Finished activating an adapter.' };
  }
  await context.db.query('UPDATE adapters SET superseded_at = now() WHERE id = $1 AND NOT active', [waiting.id]);
  return null;
}

interface ReuseCandidate {
  id: string;
  code: string;
  opaque_paths: string[];
  fingerprints: string[];
}

/** Newest first, leaving out any adapter that has already failed on this shape in replay. */
async function loadReuseCandidates(context: GeneratorContext, claim: Claim): Promise<ReuseCandidate[]> {
  const result = await context.db.query<ReuseCandidate>(
    `SELECT a.id, a.code, a.opaque_paths,
       a.fingerprint || ARRAY(SELECT f.fingerprint FROM adapter_fingerprints f WHERE f.adapter_id = a.id) AS fingerprints
     FROM adapters a
     WHERE a.account_id = $1 AND a.source = $2 AND a.op = $3 AND a.active
       AND NOT EXISTS (
         SELECT 1 FROM replay_log l
         JOIN quarantine r ON r.account_id = l.account_id AND r.id = l.quarantine_id
         JOIN events e ON e.account_id = r.account_id AND e.id = r.event_id
         WHERE l.adapter_id = a.id AND l.status = 'failed' AND e.fingerprint = $4
       )
     ORDER BY a.created_at DESC, a.id DESC
     LIMIT $5`,
    [claim.accountId, claim.source, claim.op, claim.fingerprint, MAX_REUSE_CANDIDATES],
  );
  return result.rows;
}

/** One logged event of each shape an adapter has been validated on. */
async function loadValidatedShapes(context: GeneratorContext, claim: Claim, fingerprints: string[]): Promise<GateSample[]> {
  const result = await context.db.query<{ id: string; body: Buffer; request: AdapterRequest }>(
    `SELECT DISTINCT ON (e.fingerprint) e.id, e.body, e.request
     FROM events e
     WHERE e.account_id = $1 AND e.source = $2 AND e.op = $3 AND e.fingerprint = ANY($4::text[])
     ORDER BY e.fingerprint, e.seq DESC`,
    [claim.accountId, claim.source, claim.op, fingerprints.slice(0, MAX_VALIDATED_SHAPES)],
  );
  return result.rows.map(({ id, body, request }) => ({
    eventId: id,
    body: body.length === 0 ? null : body.toString('utf8'),
    request,
  }));
}

function tablesOf(output: unknown): string[] {
  const objects = (Array.isArray(output) ? output : [output]) as { table: string }[];
  return [...new Set(objects.map(({ table }) => table))];
}

/** Binds the shape to the adapter and asks for the replay together, so neither happens alone. */
async function bindShape(context: GeneratorContext, adapterId: string, shape: string): Promise<boolean> {
  return inTransaction(context.db, async (client) => {
    await client.query(
      'INSERT INTO adapter_fingerprints (adapter_id, fingerprint) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [adapterId, shape],
    );
    return enqueueReplay(client, adapterId);
  });
}

/**
 * Step 2's second half. The checks run cheapest first: shape overlap, then the gate, then the LLM. Each
 * catches what the one before can't. Overlap stops an adapter that copies any key, and the LLM stops
 * lookalikes, which can pass both.
 */
async function tryReuse(
  context: GeneratorContext,
  claim: Claim,
  samples: readonly GateSample[],
  signal: AbortSignal,
): Promise<AttemptOutcome | null> {
  const candidates = await loadReuseCandidates(context, claim);
  if (candidates.length === 0) return null;
  const registries = await loadRegistries(context.db, claim.accountId);
  const body = parseBody(samples[0]!);

  let checks = 0;
  for (const candidate of candidates) {
    if (checks >= context.settings.sameKindChecks) break;
    const validated = await loadValidatedShapes(context, claim, candidate.fingerprints);
    if (!shapesOverlap(body, validated.map(parseBody), candidate.opaque_paths)) continue;

    const gate = await runGate({
      adapter: { code: candidate.code, op: claim.op, opaquePaths: candidate.opaque_paths },
      samples,
      registries,
    });
    if (!gate.ok) continue;

    checks += 1;
    const answer = await callLlm(
      context,
      sameKindMessages({
        tables: tablesOf(gate.samples[0]!.output),
        examples: validated.slice(0, MAX_SAME_KIND_EXAMPLES),
        candidate: samples[0]!,
      }),
      signal,
    );
    if (answer.finishReason === 'length' || !parseSameKind(answer.content)) continue;

    if (await bindShape(context, candidate.id, claim.fingerprint)) {
      return { status: 'succeeded', adapterId: candidate.id, detail: 'Reused an existing adapter.' };
    }
  }
  return null;
}

/** The other open shapes for this source and op, so the LLM can spot fields whose keys vary. */
async function loadSiblingShapes(context: GeneratorContext, claim: Claim): Promise<string[]> {
  const result = await context.db.query<{ body: Buffer }>(
    `SELECT DISTINCT ON (e.fingerprint) e.body
     FROM quarantine q
     JOIN events e ON e.account_id = q.account_id AND e.id = q.event_id
     WHERE q.account_id = $1 AND e.source = $2 AND e.op = $3 AND e.fingerprint <> $4
       AND q.released_at IS NULL AND q.reason IN ('unknown_fingerprint', 'adapter_error', 'schema_conflict')
     ORDER BY e.fingerprint, e.seq DESC
     LIMIT 10`,
    [claim.accountId, claim.source, claim.op, claim.fingerprint],
  );
  return result.rows.map(({ body }) => shapeOf(body.length === 0 ? null : JSON.parse(body.toString('utf8'))));
}

async function loadReplacedFailure(context: GeneratorContext, claim: Claim, current: AdapterRow) {
  const result = await context.db.query<{ reason: string; detail: string | null }>(
    `SELECT q.reason, q.detail
     FROM quarantine q
     JOIN events e ON e.account_id = q.account_id AND e.id = q.event_id
     WHERE q.account_id = $1 AND e.source = $2 AND e.op = $3 AND e.fingerprint = $4 AND q.released_at IS NULL
       AND q.reason IN ('adapter_error', 'schema_conflict')
     ORDER BY e.seq DESC
     LIMIT 1`,
    [claim.accountId, claim.source, claim.op, claim.fingerprint],
  );
  const failure = result.rows[0];
  return failure ? { code: current.code, reason: failure.reason, detail: failure.detail } : undefined;
}

/** The account's full schema across its stores. A column's type is the same in each, apart from accidents. */
async function loadSchema(context: GeneratorContext, accountId: string) {
  const schema: Record<string, Record<string, string>> = {};
  for (const registry of (await loadRegistries(context.db, accountId)).values()) {
    for (const [table, columns] of registry) {
      schema[table] = { ...schema[table], ...Object.fromEntries(columns) };
    }
  }
  return schema;
}

function summarize(problems: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const problem of problems) counts.set(problem, (counts.get(problem) ?? 0) + 1);
  return [...counts].map(([problem, count]) => `${problem} (${count})`).join(', ');
}

/** Stores a passing draft, and activates it if the account allows. Each step can be picked up after a crash. */
async function storeAdapter(
  context: GeneratorContext,
  claim: Claim,
  draft: { code: string; opaquePaths: string[]; fingerprint: string },
  replacing: string | null,
): Promise<AttemptOutcome> {
  const { db } = context;
  if (!(await stillRunning(db, claim.attemptId))) return { status: 'failed', detail: 'Timed out before storing an adapter.' };

  const adapter = await createAdapter(db, {
    account_id: claim.accountId,
    source: claim.source,
    op: claim.op,
    fingerprint: draft.fingerprint,
    opaque_paths: draft.opaquePaths,
    code: draft.code,
  });
  if (!adapter) return { status: 'failed', detail: 'The account no longer exists.' };

  await linkAttempt(db, claim.attemptId, adapter.id);
  // An adapter's own fingerprint has its opaque paths collapsed. This says which event shape it's for.
  if (draft.fingerprint !== claim.fingerprint) await recordFingerprint(context, adapter.id, claim.fingerprint);
  await markValidated(db, adapter.id);

  if (!claim.autoActivate) {
    return { status: 'succeeded', adapterId: adapter.id, detail: `Generated version ${adapter.version}, waiting for an operator.` };
  }
  const activated = await activateAdapter(db, adapter.id, { replacing });
  return activated.status === 'activated'
    ? { status: 'succeeded', adapterId: adapter.id, detail: `Generated and activated version ${adapter.version}.` }
    : { status: 'failed', adapterId: adapter.id, detail: `Could not activate version ${adapter.version}: ${activated.status}.` };
}

/** Steps 3 to 5. Each failed try sends the LLM what went wrong, with backoff between tries. */
async function generate(
  context: GeneratorContext,
  claim: Claim,
  samples: readonly GateSample[],
  current: AdapterRow | null,
  signal: AbortSignal,
): Promise<AttemptOutcome> {
  const { settings } = context;
  const body = parseBody(samples[0]!);
  const replaces = current ? await loadReplacedFailure(context, claim, current) : undefined;
  const messages = generationMessages({
    op: claim.op,
    schema: await loadSchema(context, claim.accountId),
    samples,
    sampleShape: shapeOf(body),
    siblingShapes: await loadSiblingShapes(context, claim),
    ...(replaces ? { replaces } : {}),
  });
  if (!messages) return { status: 'failed', detail: 'The sample is too large to send to the LLM.' };

  const problems: string[] = [];
  let retryAfter = 0;
  for (let attempt = 1; attempt <= settings.llmTries; attempt += 1) {
    if (attempt > 1) {
      const delay = Math.min(
        settings.tryBackoffMaxMs,
        Math.max(backoffMs(attempt - 1, settings.tryBackoffBaseMs, settings.tryBackoffMaxMs), retryAfter),
      );
      await sleep(delay, undefined, { signal }).catch(() => {});
    }
    if (signal.aborted) return { status: 'failed', detail: 'Stopped before finishing.' };

    let completion: LlmCompletion;
    try {
      completion = await callLlm(context, messages, signal);
    } catch (error) {
      if (!(error instanceof LlmUnavailableError)) throw error;
      problems.push('llm_unavailable');
      retryAfter = error.retryAfterMs ?? 0;
      settings.log(`Attempt ${claim.attemptId}: ${error.message}`);
      continue;
    }
    retryAfter = 0;
    if (completion.finishReason === 'length') {
      problems.push('llm_out_of_tokens');
      continue;
    }
    if (!completion.content?.trim()) {
      problems.push('llm_empty_reply');
      continue;
    }

    const checked = await checkDraft(context, claim, current, body, completion.content);
    if ('draft' in checked) return storeAdapter(context, claim, checked.draft, checked.replacing);
    problems.push(...checked.errors.map(({ code }) => code));
    messages.push({ role: 'assistant', content: completion.content }, retryMessage(checked.errors));
  }
  return { status: 'failed', detail: `Gave up after ${settings.llmTries} tries: ${summarize(problems)}.` };
}

type DraftCheck =
  | { draft: { code: string; opaquePaths: string[]; fingerprint: string }; replacing: string | null }
  | { errors: Pick<GateFailure, 'code' | 'detail'>[] };

async function checkDraft(
  context: GeneratorContext,
  claim: Claim,
  current: AdapterRow | null,
  body: unknown,
  reply: string,
): Promise<DraftCheck> {
  const parsed = parseReply(reply);
  if (!parsed.ok) return { errors: [{ code: 'invalid_output', detail: parsed.error }] };
  const { code, opaquePaths } = parsed;

  const badPaths = checkOpaquePaths(opaquePaths);
  if (badPaths.length > 0) return { errors: badPaths };

  const collapsed = fingerprint(body, { opaquePaths });
  // Matching prefers fewer opaque paths and exact shapes (§7.1). An adapter that would lose to the one it's
  // replacing would never run, and with no failed replay to count, the cap would never stop the loop.
  if (opaquePaths.length > 0 && current && current.fingerprint !== collapsed) {
    return {
      errors: [{
        code: 'invalid_opaque_path',
        detail: 'Another adapter already matches this shape exactly, so this one must declare no opaque paths.',
      }],
    };
  }

  const gate = await gateAdapter(context.db, {
    account_id: claim.accountId,
    source: claim.source,
    op: claim.op,
    fingerprint: collapsed,
    opaque_paths: opaquePaths,
    code,
  });
  if (!gate.ok) return { errors: gate.failures };
  return { draft: { code, opaquePaths, fingerprint: collapsed }, replacing: gate.replacing };
}

async function runSteps(context: GeneratorContext, claim: Claim, signal: AbortSignal): Promise<AttemptOutcome> {
  const { db } = context;
  const samples = await loadSamples(db, {
    account_id: claim.accountId,
    source: claim.source,
    op: claim.op,
    fingerprint: claim.fingerprint,
    opaque_paths: [],
    code: '',
  });
  const sample = samples[0];
  if (!sample) return { status: 'failed', detail: 'No events of this shape were found.' };

  const settled = await settleWaitingAdapter(context, claim, sample);
  if (settled) return settled;

  const matched = await findAdapter(db, {
    accountId: claim.accountId,
    source: claim.source,
    op: claim.op,
    fingerprint: claim.fingerprint,
    body: sample.body ?? '',
  });
  if (matched && !claim.hasFailure) {
    // Step 2's first half. Nothing has failed, so this adapter just hasn't reached these rows yet.
    return (await enqueueReplay(db, matched.id))
      ? { status: 'succeeded', adapterId: matched.id, detail: 'Covered by an existing adapter.' }
      : { status: 'failed', detail: 'The adapter covering this shape stopped being active.' };
  }

  // If an adapter matches and failed, only a new version can win the match, so reuse can't help.
  if (!matched) {
    const reused = await tryReuse(context, claim, samples, signal);
    if (reused) return reused;
  }
  return generate(context, claim, samples, matched && (await getAdapter(db, matched.id)), signal);
}

/** Runs a claimed attempt to its end. Rejects only if the database can't record the result. */
export async function runAttempt(context: GeneratorContext, claim: Claim): Promise<AttemptOutcome> {
  const signal = AbortSignal.any([context.signal, AbortSignal.timeout(context.settings.staleAttemptMs)]);
  let outcome: AttemptOutcome;
  try {
    outcome = await runSteps(context, claim, signal);
  } catch (error) {
    outcome = { status: 'failed', detail: `Could not finish: ${describeError(error)}.` };
  }
  await finishAttempt(context.db, claim.attemptId, outcome);
  context.settings.log(`Attempt ${claim.attemptId} for shape ${claim.fingerprint} ${outcome.status}: ${outcome.detail}`);
  return outcome;
}
