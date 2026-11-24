// Tests voor de database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, removeExpired } from '../src/db.js';

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
