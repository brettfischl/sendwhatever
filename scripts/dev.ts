// Runs the server and worker together. If either one exits, the other is stopped too.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
/** Longer than the worker's own shutdown limit, so this is only for a process that is truly stuck. */
const KILL_AFTER_MS = 35_000;

const children = [
  { name: 'server', script: 'src/http/main.ts' },
  { name: 'worker', script: 'src/worker/main.ts' },
].map(({ name, script }) => {
  const child = spawn(process.execPath, ['--import', 'tsx', script], { cwd: ROOT, stdio: 'inherit' });
  console.log(`[dev] ${name} started with pid ${child.pid}`);
  return { name, process: child, running: true };
});

let stopping = false;
let exitCode = 0;

/** Repeats are ignored: one Ctrl-C can arrive several times, and the children each get it just once here. */
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
