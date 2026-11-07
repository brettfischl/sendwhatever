// Turns the result logs into the tables in REPORT.md, and re-runs stored adapters to check what neither
// the gate nor the carry check looks at. It makes no model calls. Run: tsx spike/analyze.ts <label>...
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RESULTS_DIR } from './fireworks.js';
import { planFor, toSample, type Evaluation } from './evaluate.js';
import { attendanceLeftReq, scenarios, type Req } from './fixtures.js';
import { runAdapter } from '../src/sandbox/index.js';

// Fireworks' pricing page, Standard rates for DeepSeek V4.1 Flash, ignoring the cached input discount.
const PRICE_INPUT = 0.3 / 1e6;
const PRICE_OUTPUT = 1.2 / 1e6;

interface Row {
  label: string; scenario: string; repeat: number; step?: number; attempt: number; ok: boolean; ms: number;
  promptTokens: number; completionTokens: number; finishReason: string; code?: string; opaquePaths?: string[];
  evaluation?: Evaluation; generationFailure?: string;
}

const all = [...scenarios, attendanceLeftReq];
const scenarioOf = (name: string) => all.find((s) => s.name === name)!;
const pct = (n: number, d: number) => (d === 0 ? '-' : `${n}/${d}`);
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
const quantile = (xs: number[], q: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * q))] ?? 0;

/** Rows whose id changes with the event id, so a repeat of the same record adds more of them. */
async function resendGrowth(code: string, opaque: string[], req: Req): Promise<string[]> {
  const run = async (eventId: string) => {
    const sample = toSample(req, eventId);
    const result = await runAdapter({ code, body: sample.body, request: sample.request });
    return result.ok ? planFor(result.output, sample, opaque) : null;
  };
  const [a, b] = await Promise.all([run('00000000-0000-4000-8000-00000000000a'), run('00000000-0000-4000-8000-00000000000b')]);
  if (!a || !b) return [];
  const grows: string[] = [];
  for (const table of a.tables) {
    const other = new Set(b.tables.find((t) => t.table === table.table)?.rows.map((r) => r.id));
    const fresh = table.rows.filter((r) => !other.has(r.id)).length;
    if (fresh > 0) grows.push(`${table.table}(${fresh})`);
  }
  return grows;
}

function booleanPaths(value: unknown, path: (string | number)[] = []): (string | number)[][] {
  if (typeof value === 'boolean') return [path];
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => booleanPaths(v, [...path, Array.isArray(value) ? Number(k) : k]));
  }
  return [];
}

/** A boolean can't be made unique, so this flips each one and checks that the output changes. */
async function ignoredBooleans(code: string, req: Req): Promise<string[]> {
  if (req.body === null) return [];
  const base = await runAdapter({ code, body: JSON.stringify(req.body), request: toSample(req).request });
  if (!base.ok) return [];
  const ignored: string[] = [];
  for (const path of booleanPaths(req.body)) {
    const copy = structuredClone(req.body) as Record<string | number, any>;
    let at = copy;
    for (const key of path.slice(0, -1)) at = at[key];
    at[path.at(-1)!] = !at[path.at(-1)!];
    const flipped = await runAdapter({ code, body: JSON.stringify(copy), request: toSample(req).request });
    if (flipped.ok && JSON.stringify(flipped.output) === JSON.stringify(base.output)) ignored.push(path.join('.'));
  }
  return ignored;
}

for (const label of process.argv.slice(2)) {
  const rows = readFileSync(join(RESULTS_DIR, `${label}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Row & { kind?: string }).filter((r) => !r.kind);
  const chains = new Map<string, Row[]>();
  for (const row of rows) {
    const key = `${row.scenario}#${row.repeat}#${row.step ?? ''}`;
    chains.set(key, [...(chains.get(key) ?? []), row]);
  }

  console.log(`\n## ${label}\n`);
  console.log('| scenario | n | 1st-try gate | 1st-try, excl. suspected false failures | after retries | holdout | semantic clean | avg attempts |');
  console.log('|---|---:|---:|---:|---:|---:|---:|---:|');
  const finals: { scenario: string; row: Row }[] = [];
  for (const scenario of all.map((s) => s.name)) {
    const group = [...chains.entries()].filter(([key]) => key.startsWith(`${scenario}#`)).map(([, chain]) => chain.sort((a, b) => a.attempt - b.attempt));
    if (group.length === 0) continue;
    const n = group.length;
    const first = group.filter((c) => c[0]!.ok).length;
    const firstFair = group.filter((c) => c[0]!.ok || c[0]!.evaluation?.onlySuspects).length;
    const after = group.filter((c) => c.some((r) => r.ok)).length;
    const lasts = group.map((c) => c.find((r) => r.ok) ?? c.at(-1)!);
    lasts.forEach((row) => finals.push({ scenario, row }));
    const holdout = lasts.filter((r) => r.ok && r.evaluation?.holdoutOk).length;
    const clean = lasts.filter((r) => r.ok && r.evaluation?.holdoutOk && !r.evaluation.issues.length && !r.evaluation.holdoutIssues.length).length;
    console.log(`| ${scenario} | ${n} | ${pct(first, n)} | ${pct(firstFair, n)} | ${pct(after, n)} | ${pct(holdout, n)} | ${pct(clean, n)} | ${mean(group.map((c) => c.length)).toFixed(1)} |`);
  }

  const cost = (r: Row) => r.promptTokens * PRICE_INPUT + r.completionTokens * PRICE_OUTPUT;
  const perChain = [...chains.values()];
  const ms = rows.map((r) => r.ms);
  console.log(`\ncalls ${rows.length}; length failures ${rows.filter((r) => r.finishReason === 'length').length}; latency per call avg ${(mean(ms) / 1000).toFixed(1)}s p95 ${(quantile(ms, 0.95) / 1000).toFixed(1)}s max ${(Math.max(...ms) / 1000).toFixed(1)}s`);
  console.log(`tokens per call: prompt avg ${mean(rows.map((r) => r.promptTokens)).toFixed(0)}, completion avg ${mean(rows.map((r) => r.completionTokens)).toFixed(0)} max ${Math.max(...rows.map((r) => r.completionTokens))}`);
  console.log(`per adapter including retries: cost avg $${mean(perChain.map((c) => c.reduce((s, r) => s + cost(r), 0))).toFixed(5)} max $${Math.max(...perChain.map((c) => c.reduce((s, r) => s + cost(r), 0))).toFixed(5)}; time avg ${(mean(perChain.map((c) => c.reduce((s, r) => s + r.ms, 0))) / 1000).toFixed(1)}s\n`);

  const tally = new Map<string, number>();
  for (const r of rows) {
    if (r.generationFailure) tally.set(`generation:${r.generationFailure}`, (tally.get(`generation:${r.generationFailure}`) ?? 0) + 1);
    for (const f of r.evaluation?.failures ?? []) tally.set(`gate:${f.code}`, (tally.get(`gate:${f.code}`) ?? 0) + 1);
    for (const s of r.evaluation?.suspects ?? []) tally.set(`suspect:${s.claim}`, (tally.get(`suspect:${s.claim}`) ?? 0) + 1);
  }
  console.log('failure tally, all attempts:', JSON.stringify(Object.fromEntries(tally)));
  const issueTally = new Map<string, number>();
  for (const { row } of finals) {
    for (const i of [...(row.evaluation?.issues ?? []), ...(row.evaluation?.holdoutIssues ?? [])]) issueTally.set(i.code, (issueTally.get(i.code) ?? 0) + 1);
    for (const f of row.ok ? row.evaluation?.holdoutFailures ?? [] : []) issueTally.set(`holdout:${f.code}`, (issueTally.get(`holdout:${f.code}`) ?? 0) + 1);
  }
  console.log('final-adapter issues (hidden from the model):', JSON.stringify(Object.fromEntries(issueTally)));

  console.log('\nfinal adapters, offline checks:');
  const passing = finals.filter(({ row }) => row.ok && row.code);
  console.log(`  unique-value carry misses: ${passing.filter(({ row }) => row.evaluation!.carryMisses.length).length}/${passing.length}`);
  for (const { scenario, row } of passing) {
    if (row.evaluation!.carryMisses.length) console.log(`    ${scenario}: ${row.evaluation!.carryMisses.slice(0, 4).join(' | ')}`);
  }
  let growing = 0;
  let ignoring = 0;
  for (const { scenario, row } of passing) {
    const s = scenarioOf(scenario);
    const grows = await resendGrowth(row.code!, row.opaquePaths ?? [], s.sample);
    const ignored = await ignoredBooleans(row.code!, s.sample);
    if (grows.length) { growing += 1; console.log(`    resend adds rows: ${scenario} r${row.repeat}: ${grows.join(' ')}`); }
    if (ignored.length) { ignoring += 1; console.log(`    ignored boolean: ${scenario} r${row.repeat}: ${ignored.join(' ')}`); }
  }
  console.log(`  adapters whose rows grow on a resend: ${growing}/${passing.length}; ignoring a boolean: ${ignoring}/${passing.length}`);
  console.log('  tables chosen:');
  for (const name of new Set(passing.map((p) => p.scenario))) {
    console.log(`    ${name}: ${passing.filter((p) => p.scenario === name).map((p) => p.row.evaluation!.plan.map((t) => t.table).join('+')).join(' | ')}`);
  }
}
process.exit(0);
