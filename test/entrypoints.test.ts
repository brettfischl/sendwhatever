// Runs the documented commands as real processes, the way someone at a terminal would.
import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import net from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { fingerprint } from '../src/fingerprint/index.js';
import { readOnlyRoleName } from '../src/storage/postgres/sql.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const config = loadConfig();
const INTERNAL_TOKEN = 'entrypoints-test-token';
const db = new pg.Pool({ connectionString: config.appDatabaseUrl, max: 2 });

const accounts: string[] = [];
const running = new Set<Running>();

interface Running {
  command: ChildProcess;
  /** The process group, which holds npm and everything it started. */
  group: number;
  port: number;
  output: () => string;
  exited: Promise<number | null>;
}

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitFor<T>(what: string, check: () => Promise<T | undefined>, run?: Running): Promise<T> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}\n${run?.output() ?? ''}`);
    await sleep(100);
  }
}

/**
 * Other test files share this queue, so the worker only ever gets the account named here. Without an
 * account yet, a random id makes it claim nothing.
 */
function npmRun(script: string, workerAccountId: string, port: number): Running {
  const command = spawn('npm', ['run', '--silent', script], {
    cwd: ROOT,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(port), WORKER_ACCOUNT_ID: workerAccountId, INTERNAL_API_TOKEN: INTERNAL_TOKEN },
  });
  let output = '';
  command.stdout.on('data', (chunk) => (output += chunk));
  command.stderr.on('data', (chunk) => (output += chunk));
  const started: Running = {
    command,
    group: command.pid!,
    port,
    output: () => output,
    exited: new Promise((resolve) => command.on('exit', resolve)),
  };
  running.add(started);
  return started;
}

async function startDev(workerAccountId: string = randomUUID()): Promise<Running> {
  const dev = npmRun('dev', workerAccountId, await freePort());
  await waitForStart(dev, 'sendwhatever worker started');
  await waitForStart(dev, 'sendwhatever listening');
  return dev;
}

/** Fails straight away if the command dies, rather than at the deadline with the reason hidden. */
async function waitForStart(run: Running, line: string): Promise<void> {
  await waitFor(
    `"${line}"`,
    async () => {
      if (run.output().includes(line)) return true;
      if (run.command.exitCode !== null) throw new Error(`Exited with ${run.command.exitCode}\n${run.output()}`);
      return undefined;
    },
    run,
  );
}

/** A negative id means a process group. */
function isAlive(id: number): boolean {
  try {
    process.kill(id, 0);
    return true;
  } catch {
    return false;
  }
}

/** npm's group, plus the server and worker, which `npm run dev` puts in groups of their own. */
function everyId(run: Running): number[] {
  const pids = [...run.output().matchAll(/started with pid (\d+)/g)].map((match) => Number(match[1]));
  return [-run.group, ...pids];
}

/** Expects npm to exit with `code` and to leave nothing it started behind. */
async function expectAllStopped(run: Running, code: number): Promise<void> {
  expect(await run.exited, run.output()).toBe(code);
  await waitFor('every process to stop', async () => (everyId(run).some(isAlive) ? undefined : true), run);
  running.delete(run);
}

interface Created {
  account_id: string;
  slug: string;
  api_key: string;
  database: { host: string; port: number; database: string; user: string; password: string };
}

async function createAccount(port: number): Promise<Created> {
  const res = await fetch(`http://127.0.0.1:${port}/accounts`, {
    method: 'POST',
    headers: { authorization: `Bearer ${INTERNAL_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ slug: `entry-${randomBytes(5).toString('hex')}` }),
  });
  expect(res.status).toBe(201);
  const created = (await res.json()) as Created;
  accounts.push(created.account_id);
  return created;
}

async function ingest(port: number, account: Created, body: unknown): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}/ingest`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-account-slug': account.slug,
      authorization: `Bearer ${account.api_key}`,
    },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(202);
  return ((await res.json()) as { event_id: string }).event_id;
}

async function jobsLeft(accountId: string): Promise<number> {
  const { rows } = await db.query('SELECT 1 FROM queue WHERE account_id = $1', [accountId]);
  return rows.length;
}

async function quarantined(eventId: string) {
  const { rows } = await db.query<{ reason: string; store_id: string | null }>(
    'SELECT reason, store_id FROM quarantine WHERE event_id = $1',
    [eventId],
  );
  return rows;
}

afterEach(async () => {
  for (const run of running) {
    for (const id of everyId(run)) if (isAlive(id)) process.kill(id, 'SIGKILL');
  }
  running.clear();
});

afterAll(async () => {
  const admin = new pg.Client({
    host: 'localhost',
    port: config.postgresPort,
    database: 'sw_data',
    user: 'sw_data',
    password: config.dataDbPassword,
  });
  await admin.connect();
  const ids = [accounts];
  for (const id of accounts) {
    const namespace = `acct_${id.replaceAll('-', '')}_1`;
    await admin.query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(namespace)} WITH (FORCE)`);
    await admin.query(`DROP ROLE IF EXISTS ${pg.escapeIdentifier(readOnlyRoleName(namespace))}`);
  }
  await admin.end();
  await db.query('DELETE FROM queue WHERE account_id = ANY($1)', ids);
  await db.query('DELETE FROM replay_log WHERE account_id = ANY($1)', ids);
  await db.query('DELETE FROM quarantine WHERE account_id = ANY($1)', ids);
  await db.query(
    'DELETE FROM adapter_fingerprints WHERE adapter_id IN (SELECT id FROM adapters WHERE account_id = ANY($1))',
    ids,
  );
  await db.query('DELETE FROM adapters WHERE account_id = ANY($1)', ids);
  await db.query(
    'DELETE FROM data_columns WHERE store_id IN (SELECT id FROM account_stores WHERE account_id = ANY($1))',
    ids,
  );
  await db.query('DELETE FROM events WHERE account_id = ANY($1)', ids);
  await db.query('DELETE FROM api_keys WHERE account_id = ANY($1)', ids);
  await db.query('DELETE FROM account_stores WHERE account_id = ANY($1)', ids);
  await db.query('DELETE FROM accounts WHERE id = ANY($1)', ids);
  await db.end();
});

describe('npm run dev', () => {
  it('takes a payload from /ingest to quarantine, then to a store once an adapter exists', async () => {
    // The worker can only be told about an account that exists, so this takes two runs.
    const first = await startDev();
    const account = await createAccount(first.port);
    process.kill(-first.group, 'SIGINT'); // What Ctrl-C does: all of npm's group gets it.
    await expectAllStopped(first, 0);

    const dev = await startDev(account.account_id);
    const body = { id: 'c1', name: 'Ada' };

    const unknown = await ingest(dev.port, account, body);
    await waitFor(
      'the unknown shape to reach quarantine',
      async () => ((await quarantined(unknown)).length > 0 ? true : undefined),
      dev,
    );
    expect(await quarantined(unknown)).toEqual([{ reason: 'unknown_fingerprint', store_id: null }]);
    expect(await jobsLeft(account.account_id)).toBe(0);

    await db.query(
      `INSERT INTO adapters (account_id, source, op, fingerprint, opaque_paths, version, code, active, validated_at)
       VALUES ($1, '', 'write', $2, '{}', 1, $3, true, now())`,
      [
        account.account_id,
        fingerprint(body),
        `function adapt(payload) {
          return { table: 'contact', rows: [{ id: payload.data.id, name: payload.data.name }] };
        }`,
      ],
    );

    const known = await ingest(dev.port, account, body);
    await waitFor(
      'the job to finish',
      async () => ((await jobsLeft(account.account_id)) === 0 ? true : undefined),
      dev,
    );
    expect(await quarantined(known)).toEqual([]);

    // The login POST /accounts handed out, so this is what a customer would see.
    const customer = new pg.Client(account.database);
    await customer.connect();
    try {
      const { rows } = await customer.query('SELECT id, name FROM contact');
      expect(rows).toEqual([{ id: 'c1', name: 'Ada' }]);
    } finally {
      await customer.end();
    }

    process.kill(dev.group, 'SIGTERM'); // What a process manager does: only npm gets it.
    await expectAllStopped(dev, 0);
  });

  it('stops the server if the worker dies', async () => {
    const dev = await startDev();
    const pid = /worker started with pid (\d+)/.exec(dev.output())?.[1];
    expect(pid).toBeDefined();

    process.kill(Number(pid), 'SIGKILL');

    await expectAllStopped(dev, 1);
    expect(dev.output()).toContain('[dev] worker exited (SIGKILL), so stopping everything');
  });
});

describe('npm run worker', () => {
  it('runs alone and stops cleanly', async () => {
    const worker = npmRun('worker', randomUUID(), await freePort());
    await waitForStart(worker, 'sendwhatever worker started');

    process.kill(worker.group, 'SIGTERM');

    await expectAllStopped(worker, 0);
  });
});
