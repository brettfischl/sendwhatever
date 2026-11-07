// Runs the server, worker, and generator together. If one exits, the others are stopped too.
//
// Each child gets its own process group, so Ctrl-C reaches it once, from here. Otherwise it would also
// get the signal from the terminal, as would any sandbox process running an adapter, and that job
// couldn't finish.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
/** Longer than the worker's own shutdown limit, so this is only for a process that is truly stuck. */
const KILL_AFTER_MS = 35_000;

const scripts = [
  { name: 'server', script: 'src/http/main.ts' },
  { name: 'worker', script: 'src/worker/main.ts' },
];
// Everything but generating adapters still works without a key, so this shouldn't stop local development.
if (loadConfig().fireworksApiKey) scripts.push({ name: 'generator', script: 'src/generator/main.ts' });
else console.warn('[dev] FIREWORKS_API_KEY is not set, so running without the generator. New shapes stay in quarantine.');

const children = scripts.map(({ name, script }) => {
  const child = spawn(process.execPath, ['--import', 'tsx', script], { cwd: ROOT, stdio: 'inherit', detached: true });
  console.log(`[dev] ${name} started with pid ${child.pid}`);
  return { name, process: child, running: true };
});

let stopping = false;
let exitCode = 0;

/** Repeats are ignored, since one Ctrl-C can arrive here several times. */
function stopAll(signal: NodeJS.Signals): void {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (child.running) child.process.kill(signal);
  setTimeout(() => {
    for (const child of children) if (child.running) child.process.kill('SIGKILL');
  }, KILL_AFTER_MS).unref();
}

for (const child of children) {
  child.process.on('exit', (code, signal) => {
    child.running = false;
    if (code !== 0) exitCode = 1;
    if (!stopping) {
      console.error(`[dev] ${child.name} exited (${signal ?? `code ${code}`}), so stopping everything`);
      exitCode = 1;
      stopAll('SIGTERM');
    }
    if (children.every(({ running }) => !running)) process.exit(exitCode);
  });
}

process.on('SIGINT', () => stopAll('SIGINT'));
process.on('SIGTERM', () => stopAll('SIGTERM'));
// A closed terminal. The children are in other process groups, so it can't reach them directly.
process.on('SIGHUP', () => stopAll('SIGTERM'));
