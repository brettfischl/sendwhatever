// The adapter sandbox (PRD §12). Adapter code is untrusted, so it runs in a fresh V8 isolate inside a
// fresh child process. Some allocations, such as growing a Map without end, abort the whole process
// instead of tripping isolated-vm's memory limit. A separate process means that kills one run rather
// than the worker, and gives a way to stop code V8 can't interrupt. Only the child loads isolated-vm,
// so callers don't need `--no-node-snapshot`.
import { type ChildProcess, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { AdapterRequest } from '../contracts/index.js';

const CHILD_PATH = fileURLToPath(new URL('./child.mjs', import.meta.url));
/** Wall-clock, so it has to leave room for a busy machine: timing out sends a healthy event to quarantine (§12). */
const DEFAULT_TIMEOUT_MS = 5000;
const MAX_DETAIL_LENGTH = 2000;
const MAX_STDERR_LENGTH = 16_384;
/** Sent by the child once it has loaded and received the run, before any adapter code. */
const STARTED = 'started';

export type SandboxFailureKind =
  /** The code doesn't parse. */
  | 'syntax_error'
  /** The code parses but doesn't define a function named `adapt`. */
  | 'no_adapter'
  /** The adapter threw, at the top level or inside `adapt`. */
  | 'threw'
  /** The adapter returned something that isn't plain data, such as a function or a Date. */
  | 'invalid_output'
  | 'timeout'
  | 'memory_limit'
  /** The raw body isn't valid JSON, which is the caller's fault and not the adapter's. */
  | 'invalid_body'
  /** The sandbox process died for a reason it couldn't identify. */
  | 'crashed';

export type SandboxResult =
  /** `output` is plain data that still needs validating. It may hold `undefined`, `NaN` and `Infinity`. */
  | { ok: true; output: unknown }
  | { ok: false; kind: SandboxFailureKind; detail: string };

export interface AdapterRun {
  code: string;
  /** The raw body text. It's parsed in the sandbox so large integers survive. `null` or empty means no body. */
  body: string | null;
  request: AdapterRequest;
}

export interface SandboxLimits {
  /** Execution time for one run, including parsing the body. */
  timeoutMs?: number;
  /** Treat this as a guideline, since a determined adapter can reach 2-3 times this. */
  memoryLimitMb?: number;
  /** How long past `timeoutMs` the process may live before it is killed, as a backstop for code V8 can't interrupt. */
  killGraceMs?: number;
  /** How long the process may take to load, before it is counted as unavailable rather than a slow adapter. */
  startupTimeoutMs?: number;
}

/** The sandbox itself couldn't run, so the event says nothing about the adapter and should be retried. */
export class SandboxUnavailableError extends Error {
  override name = 'SandboxUnavailableError';
}

/**
 * Runs adapter code against one event. A fault in the adapter or the body resolves to `ok: false`, and
 * the promise rejects with `SandboxUnavailableError` only when the sandbox itself can't run.
 */
export async function runAdapter(run: AdapterRun, limits: SandboxLimits = {}): Promise<SandboxResult> {
  const timeoutMs = limits.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const memoryLimitMb = limits.memoryLimitMb ?? 128;
  const killGraceMs = limits.killGraceMs ?? 1000;
  const startupTimeoutMs = limits.startupTimeoutMs ?? 30_000;
  const job = { code: run.code, body: run.body ?? '', requestJson: JSON.stringify(run.request), timeoutMs, memoryLimitMb };

  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      // An empty environment keeps secrets away from the process if adapter code ever escapes V8. TZ and
      // LC_ALL are fixed because date and locale methods read them, and replays must match on any host.
      child = spawn(process.execPath, ['--no-node-snapshot', CHILD_PATH], {
        cwd: '/',
        env: { TZ: 'UTC', LC_ALL: 'C' },
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      });
    } catch (error) {
      reject(new SandboxUnavailableError(`Could not start the sandbox process: ${(error as Error).message}`));
      return;
    }

    let killedFor: 'startup' | 'time limit' | undefined;
    const killAfter = (ms: number, reason: 'startup' | 'time limit') =>
      setTimeout(() => {
        killedFor = reason;
        child.kill('SIGKILL');
      }, ms);
    let killTimer = killAfter(startupTimeoutMs, 'startup');

    let stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-MAX_STDERR_LENGTH);
    });

    child.once('error', (error) => {
      clearTimeout(killTimer);
      child.kill('SIGKILL');
      reject(new SandboxUnavailableError(`Could not start the sandbox process: ${error.message}`));
    });

    child.on('message', (message) => {
      clearTimeout(killTimer);
      if (message === STARTED) {
        killTimer = killAfter(timeoutMs + killGraceMs, 'time limit');
        return;
      }
      child.kill('SIGKILL');
      resolve(decodeResult(message));
    });

    // After a result this does nothing, because the promise has already settled.
    child.once('close', (code, signal) => {
      clearTimeout(killTimer);
      if (killedFor === 'time limit') {
        resolve(failed('timeout', `The adapter exceeded the ${timeoutMs} ms time limit.`));
      } else if (killedFor === 'startup') {
        reject(new SandboxUnavailableError(`The sandbox process did not start within ${startupTimeoutMs} ms.`));
      } else if (signal === 'SIGTERM' || signal === 'SIGINT' || signal === 'SIGHUP' || signal === 'SIGKILL') {
        // Something outside the sandbox stopped it, such as a shutdown or the kernel's OOM killer.
        reject(new SandboxUnavailableError(`The sandbox process was stopped by ${signal}.`));
      } else if (signal !== null) {
        resolve(classifyAbort(signal, stderr, memoryLimitMb));
      } else {
        reject(new SandboxUnavailableError(`The sandbox process exited with code ${code}: ${stderr.slice(-500)}`));
      }
    });

    // A failed send means the child died, which the close handler reports.
    child.send(job, () => {});
  });
}

/** V8 aborts the process on some out-of-memory paths rather than trip the isolate's limit. */
function classifyAbort(signal: NodeJS.Signals, stderr: string, memoryLimitMb: number): SandboxResult {
  if (/is_heap_oom = 1|out of memory|invalid (table )?size/i.test(stderr)) {
    return failed('memory_limit', `The adapter exceeded the ${memoryLimitMb} MB memory limit.`);
  }
  return failed('crashed', `The sandbox process died with ${signal}.`);
}

function failed(kind: SandboxFailureKind, detail: string): SandboxResult {
  return { ok: false, kind, detail: detail.slice(0, MAX_DETAIL_LENGTH) };
}

const FAILURE_KINDS: ReadonlySet<string> = new Set<SandboxFailureKind>([
  'syntax_error',
  'no_adapter',
  'threw',
  'invalid_output',
  'timeout',
  'memory_limit',
  'invalid_body',
  'crashed',
]);

/** Treats the message as hostile, in case adapter code took over the child process. */
function decodeResult(message: unknown): SandboxResult {
  try {
    if (typeof message !== 'string') throw new Error('not a string');
    const parsed: unknown = JSON.parse(message);
    if (!Array.isArray(parsed)) throw new Error('not an array');
    const [tag, value] = parsed as unknown[];
    if (tag === 'ok') return { ok: true, output: decodeValue(value) };
    if (typeof tag === 'string' && FAILURE_KINDS.has(tag) && typeof value === 'string') {
      return failed(tag as SandboxFailureKind, value);
    }
    throw new Error('unknown tag');
  } catch (error) {
    return failed('crashed', `The sandbox returned an unreadable result: ${(error as Error).message}`);
  }
}

/** The reverse of `encode` in guest.js. It defines keys, so `__proto__` can't set a prototype. */
function decodeValue(node: unknown): unknown {
  if (typeof node !== 'object' || node === null) return node;
  if (!Array.isArray(node)) throw new Error('unexpected object');
  switch (node[0]) {
    case 'u':
      return undefined;
    case 'n':
      return NaN;
    case 'i':
      return Infinity;
    case '-i':
      return -Infinity;
    case 'a':
      return node.slice(1).map(decodeValue);
    case 'o': {
      const object = {};
      for (let i = 1; i < node.length; i += 2) {
        Object.defineProperty(object, String(node[i]), {
          value: decodeValue(node[i + 1]),
          writable: true,
          enumerable: true,
          configurable: true,
        });
      }
      return object;
    }
    default:
      throw new Error('unknown tag');
  }
}
