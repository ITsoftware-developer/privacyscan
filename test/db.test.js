// Tests voor de database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inTransaction, openDatabase, removeExpired } from '../src/db.js';

function addUser(db, id = 1, email = 'anna@example.com') {
  db.prepare('INSERT INTO users (id, name, email, password_hash, created_at) VALUES (?, ?, ?, ?, 0)')
    .run(id, 'Anna', email, 'x');
}

function addFinding(db, userId = 1, key = 'Adobe', kind = 'breach') {
  db.prepare(`INSERT INTO findings (user_id, kind, source_key, title, found_at, updated_at)
              VALUES (?, ?, ?, ?, 0, 0)`).run(userId, kind, key, key);
}

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
    assert.deepEqual(tables, ['email_confirmations', 'findings', 'rate_limits', 'scans', 'sessions', 'users']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('een database uit fase 1 wordt bijgewerkt, zonder gegevens te verliezen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'privacyscan-'));
  try {
    const path = join(dir, 'oud.db');

    // Zo zag de tabel users er in fase 1 uit.
    const old = new DatabaseSync(path);
    old.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY, name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE COLLATE NOCASE,
        password_hash TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      INSERT INTO users VALUES (1, 'Anna', 'anna@example.com', 'hash', 123);
    `);
    old.close();

    // Twee keer openen: de tweede keer moet niets meer veranderen.
    openDatabase(path).close();
    const db = openDatabase(path);

    const columns = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
    assert.ok(columns.includes('email_confirmed_at'));
    assert.ok(columns.includes('city'));

    const user = db.prepare('SELECT * FROM users').get();
    assert.equal(user.email, 'anna@example.com');
    assert.equal(user.created_at, 123);
    assert.equal(user.email_confirmed_at, null); // nog niet bevestigd
    assert.equal(user.city, null);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('removeExpired wist alleen verlopen sessies, bevestigingslinks en tellers', () => {
  const db = openDatabase(':memory:');
  const hour = 60 * 60 * 1000;
  const past = Date.now() - hour;
  const future = Date.now() + hour;

  addUser(db);
  const addSession = db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, 1, ?)');
  addSession.run('verlopen', past);
  addSession.run('geldig', future);
  const addConfirmation = db.prepare('INSERT INTO email_confirmations (id, user_id, expires_at) VALUES (?, 1, ?)');
  addConfirmation.run('verlopen', past);
  addConfirmation.run('geldig', future);
  const addCounter = db.prepare('INSERT INTO rate_limits (id, hits, reset_at) VALUES (?, 1, ?)');
  addCounter.run('verlopen', past);
  addCounter.run('geldig', future);

  removeExpired(db);

  for (const table of ['sessions', 'email_confirmations', 'rate_limits']) {
    assert.deepEqual(db.prepare(`SELECT id FROM ${table}`).all().map((r) => r.id), ['geldig'], table);
  }
});

test('een account verwijderen wist alles wat eraan hangt (ON DELETE CASCADE)', () => {
  const db = openDatabase(':memory:');
  addUser(db, 1);
  addUser(db, 2, 'bram@example.com');
  for (const id of [1, 2]) {
    db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, 1)').run(`s${id}`, id);
    db.prepare('INSERT INTO email_confirmations (id, user_id, expires_at) VALUES (?, ?, 1)').run(`c${id}`, id);
    db.prepare('INSERT INTO scans (user_id, kind, ran_at, found_count, new_count) VALUES (?, ?, 0, 1, 1)')
      .run(id, 'breach');
    addFinding(db, id);
    addFinding(db, id, 'https://example.org/', 'web');
  }

  db.prepare('DELETE FROM users WHERE id = 1').run();

  for (const table of ['sessions', 'email_confirmations', 'scans', 'findings']) {
    const rows = db.prepare(`SELECT user_id FROM ${table}`).all();
    assert.ok(rows.length > 0, `${table}: de gegevens van het andere account blijven staan`);
    assert.ok(rows.every((row) => row.user_id === 2), `${table}: niets van account 1 over`);
  }
});

test('de database houdt rommel tegen: onbekende gebruiker, soort, status en dubbelen', () => {
  const db = openDatabase(':memory:');
  addUser(db);

  assert.throws(() => addFinding(db, 99), /FOREIGN KEY/);
  assert.throws(() => addFinding(db, 1, 'x', 'onbekend'), /CHECK/);
  assert.throws(() => db.prepare(`
    INSERT INTO findings (user_id, kind, source_key, title, status, found_at, updated_at)
    VALUES (1, 'web', 'a', 'a', 'misschien', 0, 0)`).run(), /CHECK/);

  addFinding(db, 1, 'Adobe');
  assert.throws(() => addFinding(db, 1, 'Adobe'), /UNIQUE/);
  addFinding(db, 1, 'Adobe', 'web'); // dezelfde sleutel, andere soort: mag wel
});

test('inTransaction bewaart alles of niets', () => {
  const db = openDatabase(':memory:');
  addUser(db);

  assert.equal(inTransaction(db, () => {
    addFinding(db, 1, 'A');
    addFinding(db, 1, 'B');
    return 'klaar';
  }), 'klaar');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM findings').get().n, 2);

  assert.throws(() => inTransaction(db, () => {
    addFinding(db, 1, 'C');
    addFinding(db, 1, 'A'); // bestaat al: de hele groep wordt teruggedraaid
  }), /UNIQUE/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM findings').get().n, 2);
});
