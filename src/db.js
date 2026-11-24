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
      id            INTEGER PRIMARY KEY,
      name          TEXT    NOT NULL,
      email         TEXT    NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT    NOT NULL,   -- argon2id-hash, nooit het wachtwoord zelf
      created_at    INTEGER NOT NULL    -- milliseconden sinds 1970 (Date.now())
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
  `);
  return db;
}

// Wist verlopen sessies en tellers. server.js roept dit elke minuut aan.
export function removeExpired(db) {
  const now = Date.now();
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
  db.prepare('DELETE FROM rate_limits WHERE reset_at <= ?').run(now);
}
