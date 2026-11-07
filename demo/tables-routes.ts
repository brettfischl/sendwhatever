// The live tables panel's routes and files, kept apart from the rest of the demo server.
import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { assertLoopbackRequest, stubSource, type TablesSource } from './tables.js';

/** Names are fixed, so a request path never reaches the filesystem. */
const FILES: Record<string, { file: string; type: string }> = {
  '/tables': { file: 'tables.html', type: 'text/html' },
  '/assets/tables-panel.css': { file: 'tables-panel.css', type: 'text/css' },
  '/assets/tables-panel.js': { file: 'tables-panel.js', type: 'text/javascript' },
  '/assets/tables-tracker.js': { file: 'tables-tracker.js', type: 'text/javascript' },
};
const PUBLIC_DIR = fileURLToPath(new URL('./public/', import.meta.url));

const stub = stubSource();

/** Returns undefined for any request that isn't the panel's. */
export function serveTablesPanel(
  req: IncomingMessage,
  res: ServerResponse,
  source: TablesSource = stub,
): Promise<void> | undefined {
  if (req.method !== 'GET') return undefined;
  // This runs before the server's error handling, so a target like `//` must not throw here.
  const pathname = URL.parse(req.url ?? '/', 'http://localhost')?.pathname;

  const asset = pathname && Object.hasOwn(FILES, pathname) ? FILES[pathname] : undefined;
  if (asset) return sendFile(res, asset.file, asset.type);
  if (pathname === '/api/tables') return sendData(req, res, source, () => source.tables());
  if (pathname === '/api/tables/events') return sendData(req, res, source, () => source.events());
  return undefined;
}

async function sendData(
  req: IncomingMessage,
  res: ServerResponse,
  source: TablesSource,
  read: () => Promise<unknown>,
): Promise<void> {
  if (source.loopbackOnly) assertLoopbackRequest(req);
  const body = JSON.stringify(await read());
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(body);
}

async function sendFile(res: ServerResponse, file: string, type: string): Promise<void> {
  const content = await readFile(`${PUBLIC_DIR}${file}`);
  res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` });
  res.end(content);
}
