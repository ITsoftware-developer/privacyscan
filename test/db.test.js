// Tests voor de database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, removeExpired } from '../src/db.js';

test('openDatabase maakt de map, het bestand en de tabellen aan', () => {
  const dir = mkdtempSync(join(tmpdir(), 'privacyscan-'));
  try {
    const path = join(dir, 'nieuwe-map', 'test.db');
    const db = openDatabase(path);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => row.name);
    db.close();

    assert.ok(existsSync(path));
    assert.deepEqual(tables, ['rate_limits', 'sessions', 'users']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('removeExpired wist alleen verlopen sessies en tellers', () => {
  const db = openDatabase(':memory:');
  const hour = 60 * 60 * 1000;
  const past = Date.now() - hour;
  const future = Date.now() + hour;

  db.prepare("INSERT INTO users (id, name, email, password_hash, created_at) VALUES (1, 'Anna', 'anna@example.com', 'x', 0)").run();
  const addSession = db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, 1, ?)');
  addSession.run('verlopen', past);
  addSession.run('geldig', future);
  const addCounter = db.prepare('INSERT INTO rate_limits (id, hits, reset_at) VALUES (?, 1, ?)');
  addCounter.run('verlopen', past);
  addCounter.run('geldig', future);

  removeExpired(db);

  assert.deepEqual(db.prepare('SELECT id FROM sessions').all().map((r) => r.id), ['geldig']);
  assert.deepEqual(db.prepare('SELECT id FROM rate_limits').all().map((r) => r.id), ['geldig']);
});
