// Low-level node:sqlite connector (Node 22 builtin, requires --experimental-sqlite).
// Loaded via createRequire so Vite does not try to bundle the `node:` builtin
// (see vitest.config.mjs externalization note). This is the single place that
// touches the SQLite driver — the DAL and the error catalog build on top of it.
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');

// Opens (or creates) a SQLite database at `path`. Use ':memory:' for tests.
// WAL keeps concurrent reads from the second tier (error catalog) safe on-prem.
export function openDatabase(path) {
  if (path !== ':memory:') {
    // Ensure the parent directory exists so a first run on a fresh machine
    // doesn't crash creating the database file.
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new DatabaseSync(path);
  if (path !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL;');
  }
  db.exec('PRAGMA foreign_keys = ON;');
  return db;
}
