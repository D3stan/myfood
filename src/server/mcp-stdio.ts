import { chmodSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { openDb } from './db.ts';
import { createMyFoodMcpServer } from './mcp.ts';

function resolveDbPath(): string {
  const explicit = process.env.MYFOOD_DB?.trim();
  if (explicit) return explicit === ':memory:' ? explicit : resolve(explicit);
  const dataDir = resolve(process.env.DATA_DIR ?? './data');
  return join(dataDir, 'myfood.db');
}

const dbFile = resolveDbPath();
if (dbFile !== ':memory:') {
  mkdirSync(dirname(dbFile), { recursive: true, mode: 0o700 });
}
const db = openDb(dbFile);
if (dbFile !== ':memory:') {
  try {
    chmodSync(dbFile, 0o600);
  } catch {
    // Ignore chmod failures on shared or read-only mounts.
  }
}

const defaultUserRaw = process.env.MYFOOD_USER_ID?.trim();
const defaultUserId = defaultUserRaw && /^\d+$/.test(defaultUserRaw) ? Number(defaultUserRaw) : undefined;

const server = createMyFoodMcpServer(db, { defaultUserId });
const transport = new StdioServerTransport();

let closing = false;
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  try {
    await server.close();
  } finally {
    if (db.isOpen) db.close();
  }
}

process.on('SIGINT', () => {
  void shutdown().finally(() => process.exit(0));
});
process.on('SIGTERM', () => {
  void shutdown().finally(() => process.exit(0));
});
process.stdin.on('end', () => {
  void shutdown();
});

await server.connect(transport);
