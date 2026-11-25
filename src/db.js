// De database: SQLite, ingebouwd in Node.js. Je hoeft dus niets extra's te
// installeren; alles komt in één bestand terecht (data/privacyscan.db).
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { BREACH_CONFIDENCE } from './confidence.js';

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

    -- De laatste Deep Scan: welke stappen er liepen en hoe ze afliepen (ook wat niet
    -- beschikbaar of niet toegankelijk was), en welke soorten gegevens zijn blootgesteld.
    CREATE TABLE IF NOT EXISTS scan_runs (
      user_id  INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      ran_at   INTEGER NOT NULL,
      steps    TEXT    NOT NULL,                -- de stappen, als JSON
      exposure TEXT    NOT NULL DEFAULT '[]'    -- de blootgestelde soorten gegevens, als JSON
    );
  `);

  // Een database uit fase 1 heeft de twee nieuwe kolommen van users nog niet.
  addColumn(db, 'users', 'email_confirmed_at', 'INTEGER');
  addColumn(db, 'users', 'city', 'TEXT');

  // Bij elke bevinding: uit welke bron, hoe zeker, en wanneer het voor het laatst is onderzocht
  // (anders dan updated_at, dat ook verandert als jij een keuze maakt).
  addColumn(db, 'findings', 'source_id', 'TEXT');
  addColumn(db, 'findings', 'confidence', 'TEXT');
  addColumn(db, 'findings', 'confidence_note', 'TEXT');
  addColumn(db, 'findings', 'checked_at', 'INTEGER');
  backfillEvidence(db);

  return db;
}

// Bevindingen uit de tijd voor deze kolommen krijgen hun bron en datum alsnog. Dat kan zonder te
// gokken: een datalek heeft de bron in zijn gegevens (of is van HIBP, de enige bron toen), en er
// bestond alleen de demo-zoekdienst. Een webresultaat krijgt geen zekerheid: die is nooit
// beoordeeld, en dat tonen we dan ook zo.
function backfillEvidence(db) {
  db.exec('UPDATE findings SET checked_at = updated_at WHERE checked_at IS NULL');
  db.prepare(`
    UPDATE findings SET
      source_id = CASE WHEN json_valid(details) THEN COALESCE(json_extract(details, '$.source'), 'hibp') ELSE 'hibp' END,
      confidence = ?, confidence_note = ?
    WHERE kind = 'breach' AND source_id IS NULL`).run(BREACH_CONFIDENCE.level, BREACH_CONFIDENCE.note);
  db.exec("UPDATE findings SET source_id = 'demo' WHERE kind = 'web' AND source_id IS NULL");
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
