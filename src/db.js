// De database: SQLite, ingebouwd in Node.js. Je hoeft dus niets extra's te
// installeren; alles komt in één bestand terecht (data/privacyscan.db).
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { BREACH_CONFIDENCE } from './confidence.js';
import { pruneEvents } from './events.js';
import { webKey } from './retention.js';

export function openDatabase(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });

  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000; -- schrijft een ander proces net, dan even wachten in plaats van meteen een fout

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

    -- Wat je zelf hebt gekozen bij een webresultaat (Dit ben ik / Dit ben ik niet / Weet ik niet).
    -- Dit staat los van de resultaten: sommige zoekdiensten staan niet toe dat we hun resultaten
    -- bewaren. Die verdwijnen dan na een half uur, maar jouw keuze blijft. Er staat alleen een
    -- vingerafdruk (SHA-256) van het adres in, nooit het adres, de titel of het fragment zelf.
    CREATE TABLE IF NOT EXISTS web_choices (
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      url_key    TEXT    NOT NULL,
      status     TEXT    NOT NULL CHECK (status IN ('mine', 'not_mine', 'unknown')),
      decided_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, url_key)
    );

    -- De laatste Deep Scan: welke stappen er liepen en hoe ze afliepen (ook wat niet
    -- beschikbaar of niet toegankelijk was), en welke soorten gegevens zijn blootgesteld.
    CREATE TABLE IF NOT EXISTS scan_runs (
      user_id  INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      ran_at   INTEGER NOT NULL,
      steps    TEXT    NOT NULL,                -- de stappen, als JSON
      exposure TEXT    NOT NULL DEFAULT '[]'    -- de blootgestelde soorten gegevens, als JSON
    );

    -- Voor de beheerpagina: hoeveel aanvragen de site per dag naar elke externe dienst stuurde, en
    -- hoeveel daarvan mislukten. Alleen tellers: geen adressen, zoekopdrachten of e-mailadressen.
    CREATE TABLE IF NOT EXISTS api_usage (
      service TEXT    NOT NULL,             -- brave, xon, hibp of pwned-passwords (zie services.js)
      day     TEXT    NOT NULL,             -- de dag in UTC, als 2026-11-26
      calls   INTEGER NOT NULL DEFAULT 0,
      errors  INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (service, day)
    );

    -- Het systeemlog van de beheerpagina: vaste meldingen met alleen getallen en vaste woorden als
    -- details (zie events.js). Blijft hooguit 30 dagen.
    CREATE TABLE IF NOT EXISTS system_events (
      id     INTEGER PRIMARY KEY,
      at     INTEGER NOT NULL,
      level  TEXT    NOT NULL CHECK (level IN ('info', 'warn', 'error')),
      code   TEXT    NOT NULL,
      detail TEXT    NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS system_events_at ON system_events (at);

    -- De onderzoekswachtrij (zie jobs/queue.js): een Deep Scan loopt op de achtergrond, zodat je de
    -- pagina mag sluiten. Per stap de voortgang, als JSON (dezelfde stappen als in het rapport).
    -- ON DELETE CASCADE: verwijdert iemand zijn account, dan verdwijnen zijn onderzoeken mee.
    CREATE TABLE IF NOT EXISTS jobs (
      id           INTEGER PRIMARY KEY,
      user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind         TEXT    NOT NULL CHECK (kind IN ('deep')),
      status       TEXT    NOT NULL CHECK (status IN ('queued', 'running', 'done', 'failed')),
      steps        TEXT    NOT NULL DEFAULT '[]',
      error        TEXT,                     -- een vaste code als het onderzoek mislukte, nooit een melding
      attempts     INTEGER NOT NULL DEFAULT 0,
      created_at   INTEGER NOT NULL,
      started_at   INTEGER,
      heartbeat_at INTEGER,
      finished_at  INTEGER
    );
    CREATE INDEX IF NOT EXISTS jobs_status ON jobs (status, created_at);
    CREATE INDEX IF NOT EXISTS jobs_user ON jobs (user_id, created_at);

    -- De code waarmee je je telefoonnummer bevestigt (zie routes-profile.js). Alleen de hash van de
    -- code, nooit de code zelf; hij is 10 minuten geldig en je hebt 5 pogingen.
    CREATE TABLE IF NOT EXISTS phone_codes (
      user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      phone      TEXT    NOT NULL,
      code_hash  TEXT    NOT NULL,
      attempts   INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );

    -- De Data Broker Engine: per account en per databroker wanneer we voor het laatst keken, of dat
    -- lukte en hoeveel mogelijke vermeldingen er waren. Geen resultaten zelf: die staan (kort) in findings.
    CREATE TABLE IF NOT EXISTS broker_checks (
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      broker_id  TEXT    NOT NULL,
      status     TEXT    NOT NULL CHECK (status IN ('gevonden', 'niet-gevonden', 'niet-toegankelijk', 'overgeslagen')),
      found      INTEGER NOT NULL DEFAULT 0,
      via        TEXT    NOT NULL DEFAULT '',   -- met welke gegevens gevonden: naam, telefoon, e-mail
      checked_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, broker_id)
    );

    -- Instellingen die de beheerder op de beheerpagina verandert, zoals een bron pauzeren. Sleutels
    -- en wachtwoorden staan hier nooit: die blijven in .env.
    CREATE TABLE IF NOT EXISTS settings (
      key        TEXT    PRIMARY KEY,
      value      TEXT    NOT NULL,
      updated_at INTEGER NOT NULL
    );

    -- De kostengrens (budget.js): een plek die een aanvraag naar een betaalde dienst krijgt voordat hij
    -- vertrekt, tot het antwoord er is en in api_usage staat. Zo tellen lopende aanvragen mee, ook uit
    -- een ander proces. Een plek van een proces dat onderweg stopte, verloopt vanzelf (expires_at).
    CREATE TABLE IF NOT EXISTS budget_holds (
      id         INTEGER PRIMARY KEY,
      service    TEXT    NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
  `);

  // Een database uit fase 1 heeft de twee nieuwe kolommen van users nog niet.
  addColumn(db, 'users', 'email_confirmed_at', 'INTEGER');
  addColumn(db, 'users', 'city', 'TEXT');
  // Geblokkeerd door de beheerder (bij misbruik). Leeg = niet geblokkeerd.
  addColumn(db, 'users', 'blocked_at', 'INTEGER');
  // Je telefoonnummer (internationaal, +31612345678), en wanneer je het met een sms-code bevestigde.
  // Alleen een bevestigd nummer wordt onderzocht.
  addColumn(db, 'users', 'phone', 'TEXT');
  addColumn(db, 'users', 'phone_verified_at', 'INTEGER');
  // Wanneer je toestemming gaf om ook op je e-mailadres op het web te zoeken. Leeg = nee.
  addColumn(db, 'users', 'email_web_at', 'INTEGER');

  // Een onderzoek stoppen (zie jobs/queue.js): wie erom vroeg, 'user' of 'admin'. Leeg = niemand.
  addColumn(db, 'jobs', 'cancel_requested', 'TEXT');
  // De Data Broker Engine: hoeveel van de gevonden pagina's je gegevens noemen (naam, bevestigd
  // telefoonnummer of e-mailadres), en of de zoekdienst alles kon geven (0 = mogelijk onvolledig).
  addColumn(db, 'broker_checks', 'matched', 'INTEGER NOT NULL DEFAULT 0');
  addColumn(db, 'broker_checks', 'complete', 'INTEGER NOT NULL DEFAULT 1');

  // Bij elke bevinding: uit welke bron, hoe zeker, en wanneer het voor het laatst is onderzocht
  // (anders dan updated_at, dat ook verandert als jij een keuze maakt).
  addColumn(db, 'findings', 'source_id', 'TEXT');
  addColumn(db, 'findings', 'confidence', 'TEXT');
  addColumn(db, 'findings', 'confidence_note', 'TEXT');
  addColumn(db, 'findings', 'checked_at', 'INTEGER');
  // Tot wanneer een bevinding bewaard mag blijven. Leeg = zolang je account bestaat. Webresultaten
  // van een zoekdienst die bewaren niet toestaat, krijgen hier een tijd (zie retention.js).
  addColumn(db, 'findings', 'expires_at', 'INTEGER');
  db.exec('CREATE INDEX IF NOT EXISTS findings_expiry ON findings (expires_at) WHERE expires_at IS NOT NULL');
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
// BEGIN IMMEDIATE neemt meteen de schrijfrechten: een ander proces kan dan tussen ons lezen en schrijven
// niets veranderen (voor tellen-en-reserveren in één keer, zie budget.js).
export function inTransaction(db, work, { immediate = false } = {}) {
  db.exec(immediate ? 'BEGIN IMMEDIATE' : 'BEGIN');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

// Wist verlopen sessies, bevestigingslinks, tellers en webresultaten die niet langer bewaard mogen
// worden, en oude regels uit het systeemlog en de verbruikstellers. server.js roept dit elke minuut aan.
export function removeExpired(db, now = Date.now()) {
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
  db.prepare('DELETE FROM email_confirmations WHERE expires_at <= ?').run(now);
  db.prepare('DELETE FROM rate_limits WHERE reset_at <= ?').run(now);
  db.prepare('DELETE FROM phone_codes WHERE expires_at <= ?').run(now);
  db.prepare('DELETE FROM budget_holds WHERE expires_at <= ?').run(now);
  db.prepare('DELETE FROM findings WHERE expires_at IS NOT NULL AND expires_at <= ?').run(now);
  pruneEvents(db, now);
  db.prepare("DELETE FROM jobs WHERE status IN ('done', 'failed') AND finished_at <= ?").run(now - JOB_DAYS * 24 * 60 * 60 * 1000);
  db.prepare('DELETE FROM api_usage WHERE day < ?')
    .run(new Date(now - USAGE_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10));
}

// Hoe lang de tellers van het verbruik blijven: ruim een jaar, om maanden te kunnen vergelijken.
export const USAGE_DAYS = 400;
// Hoe lang een afgerond onderzoek in de wachtrij blijft staan (het rapport zelf staat in scan_runs).
export const JOB_DAYS = 30;

// Wist alles wat de demo-zoekdienst verzonnen heeft: de nepresultaten, de keuzes die je daarbij
// maakte, de laatste webzoekopdracht en een Deep Scan-rapport waar demo-resultaten in staan.
// server.js doet dit zodra er een andere zoekdienst dan de demo is, zodat er nooit nepdata blijft
// staan tussen echte bevindingen. Geeft terug hoeveel nepresultaten er weg zijn.
export function purgeDemoData(db) {
  return inTransaction(db, () => {
    const demo = db
      .prepare("SELECT user_id, url FROM findings WHERE kind = 'web' AND source_id = 'demo'")
      .all();
    const dropChoice = db.prepare('DELETE FROM web_choices WHERE user_id = ? AND url_key = ?');
    for (const row of demo) dropChoice.run(row.user_id, webKey(row.url));

    db.exec(`
      DELETE FROM scans WHERE kind = 'web'
        AND user_id IN (SELECT user_id FROM findings WHERE kind = 'web' AND source_id = 'demo');
      DELETE FROM scan_runs WHERE json_valid(steps)
        AND EXISTS (SELECT 1 FROM json_each(scan_runs.steps) WHERE json_extract(json_each.value, '$.demo') = 1);
      DELETE FROM findings WHERE kind = 'web' AND source_id = 'demo';
    `);
    return demo.length;
  });
}
