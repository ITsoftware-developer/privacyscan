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
    assert.deepEqual(tables, [
      'api_usage', 'broker_checks', 'budget_holds', 'email_confirmations', 'findings', 'jobs', 'phone_codes', 'rate_limits', 'scan_runs',
      'scans', 'sessions', 'settings', 'system_events', 'users', 'web_choices',
    ]);
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
    assert.ok(columns.includes('blocked_at'));

    const user = db.prepare('SELECT * FROM users').get();
    assert.equal(user.email, 'anna@example.com');
    assert.equal(user.created_at, 123);
    assert.equal(user.email_confirmed_at, null); // nog niet bevestigd
    assert.equal(user.city, null);
    assert.equal(user.blocked_at, null); // een bestaand account is niet geblokkeerd
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
    db.prepare("INSERT INTO scan_runs (user_id, ran_at, steps, exposure) VALUES (?, 0, '[]', '[]')").run(id);
    addFinding(db, id);
    addFinding(db, id, 'https://example.org/', 'web');
  }

  db.prepare('DELETE FROM users WHERE id = 1').run();

  for (const table of ['sessions', 'email_confirmations', 'scans', 'scan_runs', 'findings']) {
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

test('er is één rapport per gebruiker, en het hoort bij een bestaande gebruiker', () => {
  const db = openDatabase(':memory:');
  addUser(db);
  const insert = db.prepare("INSERT INTO scan_runs (user_id, ran_at, steps, exposure) VALUES (?, 0, '[]', '[]')");

  assert.throws(() => insert.run(99), /FOREIGN KEY/);
  insert.run(1);
  assert.throws(() => insert.run(1), /UNIQUE|PRIMARY KEY/);
  assert.throws(() => db.prepare('INSERT INTO scan_runs (user_id, ran_at) VALUES (1, 0)').run(), /NOT NULL|UNIQUE|PRIMARY KEY/);
});

// Zo zag de tabel findings eruit voordat er bewijs bij elke bevinding hoorde (versie 0.4.0).
const FINDINGS_BEFORE_EVIDENCE = `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL, created_at INTEGER NOT NULL, email_confirmed_at INTEGER, city TEXT
  );
  CREATE TABLE findings (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('breach', 'web')),
    source_key TEXT NOT NULL, title TEXT NOT NULL, url TEXT,
    details TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'mine', 'not_mine', 'unknown')),
    found_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    UNIQUE (user_id, kind, source_key)
  );
  INSERT INTO users VALUES (1, 'Anna', 'anna@example.com', 'hash', 100, 100, NULL);
`;

test('een database van vóór het bewijs krijgt bron en datum bij elke bevinding, zonder te gokken', () => {
  const dir = mkdtempSync(join(tmpdir(), 'privacyscan-'));
  try {
    const path = join(dir, 'oud.db');
    const old = new DatabaseSync(path);
    old.exec(FINDINGS_BEFORE_EVIDENCE);
    const insert = old.prepare(`INSERT INTO findings (user_id, kind, source_key, title, url, details, status, found_at, updated_at)
                                VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)`);
    insert.run('breach', 'Adobe', 'Adobe', 'https://haveibeenpwned.com/PwnedWebsites#Adobe', '{"breachDate":"2013-10-04"}', 'mine', 10, 20);
    insert.run('breach', 'LinkedIn', 'LinkedIn', null, '{"source":"xon","breachDate":"2012-06-05"}', 'mine', 11, 21);
    insert.run('breach', 'Kapot', 'Kapot', null, 'dit is geen json', 'mine', 12, 22);
    insert.run('web', 'https://example.org/a', 'Een resultaat', 'https://example.org/a', '{"snippet":"x"}', 'mine', 13, 23);
    old.close();

    const db = openDatabase(path);
    const rows = Object.fromEntries(db.prepare(
      'SELECT source_key, source_id, confidence, confidence_note, checked_at, status, found_at, updated_at, title FROM findings',
    ).all().map((row) => [row.source_key, row]));

    // Een datalek zonder bron in zijn gegevens kwam van HIBP, de enige bron toen. Met "source" in de gegevens
    // staat die bron er al. Kapotte gegevens gooien niets en tellen als HIBP.
    assert.equal(rows.Adobe.source_id, 'hibp');
    assert.equal(rows.LinkedIn.source_id, 'xon');
    assert.equal(rows.Kapot.source_id, 'hibp');
    for (const name of ['Adobe', 'LinkedIn', 'Kapot']) {
      assert.equal(rows[name].confidence, 'hoog', name); // de bron zei zelf dat het adres in dit lek stond
      assert.match(rows[name].confidence_note, /letterlijke overeenkomst/, name);
    }

    // Er bestond alleen de demo-zoekdienst. Een zekerheid is nooit beoordeeld, dus die blijft leeg.
    assert.equal(rows['https://example.org/a'].source_id, 'demo');
    assert.equal(rows['https://example.org/a'].confidence, null);
    assert.equal(rows['https://example.org/a'].confidence_note, null);

    // Het laatste onderzoek was het laatste moment dat we iets wisten: updated_at. Al het andere blijft staan.
    assert.deepEqual(Object.values(rows).map((row) => [row.found_at, row.updated_at, row.checked_at]), [
      [10, 20, 20], [11, 21, 21], [12, 22, 22], [13, 23, 23],
    ]);
    assert.equal(rows.Adobe.status, 'mine');
    assert.equal(rows.Adobe.title, 'Adobe');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM scan_runs').get().n, 0); // en de nieuwe tabel bestaat
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('de bijwerking van een oude database is eenmalig: een tweede keer openen verandert niets meer', () => {
  const dir = mkdtempSync(join(tmpdir(), 'privacyscan-'));
  try {
    const path = join(dir, 'oud.db');
    const old = new DatabaseSync(path);
    old.exec(FINDINGS_BEFORE_EVIDENCE);
    old.exec(`INSERT INTO findings (user_id, kind, source_key, title, details, status, found_at, updated_at)
              VALUES (1, 'web', 'https://example.org/a', 'A', '{}', 'new', 1, 2),
                     (1, 'breach', 'Adobe', 'Adobe', '{}', 'mine', 1, 2)`);
    old.close();

    openDatabase(path).close();

    // Daarna zijn ze door een scan opnieuw onderzocht en beoordeeld. Bij het volgende openen mag er niets terugdraaien.
    const midden = openDatabase(path);
    midden.exec(`UPDATE findings SET source_id = 'xon', confidence = 'laag', confidence_note = 'Nieuwe uitleg', checked_at = 999
                 WHERE kind = 'breach'`);
    midden.exec("UPDATE findings SET source_id = 'brave', confidence = 'laag', checked_at = 999 WHERE kind = 'web'");
    midden.close();

    const db = openDatabase(path);
    const rows = db.prepare('SELECT kind, source_id, confidence, confidence_note, checked_at FROM findings ORDER BY kind').all();
    assert.deepEqual(rows.map((row) => ({ ...row })), [
      { kind: 'breach', source_id: 'xon', confidence: 'laag', confidence_note: 'Nieuwe uitleg', checked_at: 999 },
      { kind: 'web', source_id: 'brave', confidence: 'laag', confidence_note: null, checked_at: 999 },
    ]);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
