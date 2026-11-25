// De database: SQLite, ingebouwd in Node.js. Je hoeft dus niets extra's te
// installeren; alles komt in één bestand terecht (data/privacyscan.db).
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function openDatabase(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });

  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS users (
      id                 INTEGER PRIMARY KEY,
      name               TEXT    NOT NULL,
      email              TEXT    NOT NULL UNIQUE COLLATE NOCASE,
      password_hash      TEXT    NOT NULL,   -- argon2id-hash, nooit het wachtwoord zelf
      created_at         INTEGER NOT NULL,   -- milliseconden sinds 1970 (Date.now())
      email_confirmed_at INTEGER,            -- leeg = het adres is nog niet bevestigd
      city               TEXT                -- woonplaats, optioneel
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id         TEXT    PRIMARY KEY,   -- SHA-256 van het sessietoken, nooit het token zelf
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );

    -- Tellers tegen wachtwoorden raden (zie limit-store.js)
    CREATE TABLE IF NOT EXISTS rate_limits (
      id       TEXT    PRIMARY KEY,     -- SHA-256 van bijvoorbeeld een IP- of e-mailadres
      hits     INTEGER NOT NULL,
      reset_at INTEGER NOT NULL
    );

    -- De links uit de bevestigingsmail. Net als bij sessies bewaren we alleen de
    -- hash van het token: lekt de database uit, dan werkt er geen enkele link.
    CREATE TABLE IF NOT EXISTS email_confirmations (
      id         TEXT    PRIMARY KEY,   -- SHA-256 van het token in de mail
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS email_confirmations_user ON email_confirmations (user_id);

    -- Alles wat een scan vindt: datalekken ('breach') en webresultaten ('web').
    -- ON DELETE CASCADE: verwijdert iemand zijn account, dan verdwijnt dit mee.
    CREATE TABLE IF NOT EXISTS findings (
      id         INTEGER PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind       TEXT    NOT NULL CHECK (kind IN ('breach', 'web')),
      source_key TEXT    NOT NULL,      -- naam van het datalek, of de link van het webresultaat
      title      TEXT    NOT NULL,
      url        TEXT,
      details    TEXT    NOT NULL DEFAULT '{}',   -- de rest, als JSON (datum, fragment, ...)
      status     TEXT    NOT NULL DEFAULT 'new'
                 CHECK (status IN ('new', 'mine', 'not_mine', 'unknown')),
      found_at   INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (user_id, kind, source_key)
    );
    CREATE INDEX IF NOT EXISTS findings_user ON findings (user_id);

    -- Wanneer is er voor het laatst gescand, en wat leverde dat op?
    CREATE TABLE IF NOT EXISTS scans (
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind        TEXT    NOT NULL CHECK (kind IN ('breach', 'web')),
      ran_at      INTEGER NOT NULL,
      found_count INTEGER NOT NULL,
      new_count   INTEGER NOT NULL,
      detail      TEXT,                 -- bij webzoeken: de zoekopdracht
      PRIMARY KEY (user_id, kind)
    );
  `);

  // Een database uit fase 1 heeft de twee nieuwe kolommen van users nog niet.
  addColumn(db, 'users', 'email_confirmed_at', 'INTEGER');
  addColumn(db, 'users', 'city', 'TEXT');

  return db;
}

function addColumn(db, table, column, type) {
  const exists = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
  if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

// node:sqlite heeft geen eigen "transaction". Met deze hulpfunctie lukt een
// groep wijzigingen helemaal of helemaal niet. De functie moet synchroon zijn.
export function inTransaction(db, work) {
  db.exec('BEGIN');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

// Wist verlopen sessies, bevestigingslinks en tellers. server.js roept dit elke
// minuut aan.
export function removeExpired(db) {
  const now = Date.now();
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
  db.prepare('DELETE FROM email_confirmations WHERE expires_at <= ?').run(now);
  db.prepare('DELETE FROM rate_limits WHERE reset_at <= ?').run(now);
}
