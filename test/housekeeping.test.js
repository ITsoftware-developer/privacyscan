// Tests voor wat er bij het starten met de bewaarde gegevens gebeurt (housekeeping.js), afhankelijk
// van de zoekdienst die nu is ingesteld: demo-gegevens opruimen, een einddatum geven aan wat niet
// mag blijven, en wat verlopen is wissen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db.js';
import { listFindings, recordScan, saveBreaches, saveWebResults } from '../src/findings.js';
import { prepareStorage } from '../src/housekeeping.js';
import { WEB_RESULT_MS } from '../src/retention.js';
import { createBraveSearch, createDemoSearch } from '../src/search.js';
import { ADOBE, CLUB, GIDS, NAAMGENOOT, fakeSearch } from './helpers.js';

const NOW = 1_800_000_000_000;
const MINUTE = 60 * 1000;

function newDb() {
  const db = openDatabase(':memory:');
  db.prepare('INSERT INTO users (id, name, email, password_hash, created_at) VALUES (1, ?, ?, ?, 0)')
    .run('Anna de Vries', 'anna@example.com', 'x');
  return db;
}

const brave = (retainsResults = false) => createBraveSearch({
  apiKey: 'BSA-test-sleutel-0123456789', retainsResults, minIntervalMs: 0, fetchImpl: async () => { throw new Error('geen netwerk'); },
});

// Een database zoals die van een eerdere versie: nepresultaten van de demo, een echt resultaat van Brave
// zonder einddatum (van toen er opslagrechten waren), een datalek en een verlopen resultaat.
function seed(db) {
  saveWebResults(db, 1, [CLUB, GIDS], NOW - 10 * MINUTE, { sourceId: 'demo' });
  recordScan(db, 1, 'web', 2, 2, '"Anna de Vries"', NOW - 10 * MINUTE);
  saveWebResults(db, 1, [NAAMGENOOT], NOW - 10 * MINUTE, { sourceId: 'brave' });
  saveWebResults(db, 1, [{ title: 'Oud', url: 'https://example.org/oud', snippet: '' }], NOW - 90 * MINUTE,
    { sourceId: 'brave', expiresAt: NOW - 60 * MINUTE });
  saveBreaches(db, 1, [{ ...ADOBE, source: 'hibp' }], NOW - 10 * MINUTE);
}

const urls = (db) => listFindings(db, 1, NOW).web.map((item) => item.url).sort();

test('met Brave zonder opslagrechten: demo weg, wat zonder einddatum bleef krijgt er een, verlopen weg', () => {
  const db = newDb();
  seed(db);

  const result = prepareStorage(db, brave(false), NOW);
  assert.deepEqual(result, { purged: 2, limited: 1 });

  assert.deepEqual(urls(db), [NAAMGENOOT.url]);
  const row = db.prepare('SELECT expires_at FROM findings WHERE url = ?').get(NAAMGENOOT.url);
  assert.equal(row.expires_at, NOW + WEB_RESULT_MS);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM findings WHERE url = ?').get('https://example.org/oud').n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM scans WHERE kind = 'web'").get().n, 0); // de "laatst gezocht" van de demo
  assert.equal(listFindings(db, 1, NOW).breaches.length, 1); // het datalek is echt en blijft
});

test('met Brave mét opslagrechten: demo weg, maar echte resultaten krijgen geen einddatum', () => {
  const db = newDb();
  seed(db);

  assert.deepEqual(prepareStorage(db, brave(true), NOW), { purged: 2, limited: 0 });
  assert.equal(db.prepare('SELECT expires_at FROM findings WHERE url = ?').get(NAAMGENOOT.url).expires_at, null);
  assert.deepEqual(urls(db), [NAAMGENOOT.url]);
});

test('zonder zoekdienst: demo weg en echte resultaten blijven zoals ze waren', () => {
  const db = newDb();
  seed(db);

  assert.deepEqual(prepareStorage(db, null, NOW), { purged: 2, limited: 0 });
  assert.deepEqual(urls(db), [NAAMGENOOT.url]);
  assert.equal(db.prepare('SELECT expires_at FROM findings WHERE url = ?').get(NAAMGENOOT.url).expires_at, null);
});

test('met de demo-zoekdienst blijven de demo-resultaten staan: de ontwikkelaar wil ze zien', () => {
  const db = newDb();
  seed(db);

  assert.deepEqual(prepareStorage(db, createDemoSearch(), NOW), { purged: 0, limited: 0 });
  assert.deepEqual(urls(db), [CLUB.url, GIDS.url, NAAMGENOOT.url].sort());
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM scans WHERE kind = 'web'").get().n, 1);
});

test('een onbekende zoekdienst telt als "mag niet bewaren", tenzij hij het zelf zegt', () => {
  const db = newDb();
  saveWebResults(db, 1, [CLUB], NOW, { sourceId: 'nep' });

  assert.deepEqual(prepareStorage(db, fakeSearch({ name: 'nep', retainsResults: false }), NOW), { purged: 0, limited: 1 });
  assert.equal(db.prepare('SELECT expires_at FROM findings').get().expires_at, NOW + WEB_RESULT_MS);

  const other = newDb();
  saveWebResults(other, 1, [CLUB], NOW, { sourceId: 'nep' });
  assert.deepEqual(prepareStorage(other, fakeSearch({ name: 'nep', retainsResults: true }), NOW), { purged: 0, limited: 0 });
  assert.equal(other.prepare('SELECT expires_at FROM findings').get().expires_at, null);
});

test('twee keer starten geeft hetzelfde: er gaat niets nog een keer kwijt of op de schop', () => {
  const db = newDb();
  seed(db);
  prepareStorage(db, brave(false), NOW);
  const before = JSON.stringify(db.prepare('SELECT url, expires_at FROM findings ORDER BY id').all());

  assert.deepEqual(prepareStorage(db, brave(false), NOW + MINUTE), { purged: 0, limited: 0 });
  assert.equal(JSON.stringify(db.prepare('SELECT url, expires_at FROM findings ORDER BY id').all()), before);
});

test('een lege database starten kan altijd', () => {
  const db = newDb();
  for (const search of [null, createDemoSearch(), brave(false), brave(true)]) {
    assert.deepEqual(prepareStorage(db, search, NOW), { purged: 0, limited: 0 });
  }
});
