// Tests voor de tijdelijke opslag van webresultaten: sommige zoekdiensten (Brave) staan niet toe dat
// we hun resultaten bewaren, dus ze blijven maar een half uur staan. Jouw keuzes blijven wel
// bestaan, als vingerafdruk van het adres. Daarnaast het opruimen van demo-gegevens.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, removeExpired, purgeDemoData } from '../src/db.js';
import {
  countFindings, lastScan, limitRetention, listFindings, recordScan, saveBreaches, saveRun, saveWebResults,
  setWebStatus,
} from '../src/findings.js';
import { WEB_RESULT_MINUTES, WEB_RESULT_MS, webKey } from '../src/retention.js';
import { ADOBE, CLUB, GIDS, NAAMGENOOT } from './helpers.js';

const ANNA_ID = 1;
const BRAM_ID = 2;
const NOW = 1_800_000_000_000; // een vast tijdstip, zodat de tests niet van de klok afhangen
const MINUTE = 60 * 1000;

function newDb() {
  const db = openDatabase(':memory:');
  for (const [id, email] of [[ANNA_ID, 'anna@example.com'], [BRAM_ID, 'bram@example.com']]) {
    db.prepare('INSERT INTO users (id, name, email, password_hash, created_at) VALUES (?, ?, ?, ?, 0)')
      .run(id, `Gebruiker ${id}`, email, 'x');
  }
  return db;
}

// Bewaart resultaten zoals een zoekdienst die niet mag bewaren: met een einddatum.
function saveShortLived(db, userId, results, now, sourceId = 'brave') {
  return saveWebResults(db, userId, results, now, { sourceId, expiresAt: now + WEB_RESULT_MS });
}

const urlsOf = (db, userId, now) => listFindings(db, userId, now).web.map((item) => item.url).sort();

function idOf(db, userId, url, now) {
  return listFindings(db, userId, now).web.find((item) => item.url === url).id;
}

// --- webKey ---------------------------------------------------------------------------------

test('webKey is een vingerafdruk van het adres: een code van 64 tekens, niet het adres zelf', () => {
  const key = webKey(CLUB.url);
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.ok(!key.includes('example'));
  assert.ok(!key.includes('club'));
  assert.equal(webKey(CLUB.url), key); // altijd dezelfde code bij hetzelfde adres
  assert.notEqual(webKey(GIDS.url), key);
});

test('webKey zegt hetzelfde voor schrijfwijzen van hetzelfde adres, en negeert het stuk na #', () => {
  assert.equal(webKey('HTTPS://Example.ORG/club/uitslagen'), webKey('https://example.org/club/uitslagen'));
  assert.equal(webKey('https://example.org/club/uitslagen#deel-2'), webKey('https://example.org/club/uitslagen'));
  // Een ander pad of een andere zoekopdracht is wel een andere pagina.
  assert.notEqual(webKey('https://example.org/club/uitslagen?jaar=2025'), webKey('https://example.org/club/uitslagen'));
  assert.notEqual(webKey('https://example.org/club/uitslagen/'), webKey('https://example.org/club/uitslagen'));
});

test('webKey laat een kapot adres niet crashen en geeft er toch een code voor', () => {
  for (const kapot of ['dit is geen adres', '', null, undefined, 42]) {
    assert.match(webKey(kapot), /^[0-9a-f]{64}$/);
  }
});

test('de bewaartermijn staat op 30 minuten', () => {
  assert.equal(WEB_RESULT_MINUTES, 30);
  assert.equal(WEB_RESULT_MS, 30 * MINUTE);
});

// --- Resultaten met een einddatum ---------------------------------------------------------

test('een resultaat met een einddatum staat erin tot die datum, en daarna toont en telt niemand het meer', () => {
  const db = newDb();
  assert.equal(saveShortLived(db, ANNA_ID, [CLUB, GIDS], NOW), 2);

  const row = db.prepare("SELECT expires_at FROM findings WHERE url = ?").get(CLUB.url);
  assert.equal(row.expires_at, NOW + 30 * MINUTE);

  // Net voor het einde: alles staat er nog.
  const almost = NOW + 30 * MINUTE - 1;
  assert.deepEqual(urlsOf(db, ANNA_ID, almost), [CLUB.url, GIDS.url].sort());
  assert.equal(countFindings(db, ANNA_ID, almost).web, 2);

  // Op het moment zelf is het weg: een einddatum is "tot", niet "tot en met".
  const gone = NOW + 30 * MINUTE;
  assert.deepEqual(urlsOf(db, ANNA_ID, gone), []);
  assert.deepEqual(countFindings(db, ANNA_ID, gone), { breaches: 0, web: 0, webNew: 0, webMine: 0 });
  // De rij staat er technisch nog: pas removeExpired wist hem echt.
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM findings').get().n, 2);
});

test('zonder einddatum blijft een webresultaat staan zolang het account bestaat', () => {
  const db = newDb();
  saveWebResults(db, ANNA_ID, [CLUB], NOW, { sourceId: 'demo' });
  assert.equal(db.prepare('SELECT expires_at FROM findings').get().expires_at, null);

  const jarenLater = NOW + 5 * 365 * 24 * 60 * MINUTE;
  assert.deepEqual(urlsOf(db, ANNA_ID, jarenLater), [CLUB.url]);
  removeExpired(db, jarenLater);
  assert.deepEqual(urlsOf(db, ANNA_ID, jarenLater), [CLUB.url]);
});

test('datalekken verlopen nooit: alleen webresultaten hebben een einddatum', () => {
  const db = newDb();
  saveBreaches(db, ANNA_ID, [{ ...ADOBE, source: 'hibp' }], NOW);
  saveShortLived(db, ANNA_ID, [CLUB], NOW);

  const later = NOW + 24 * 60 * MINUTE;
  removeExpired(db, later);
  const found = listFindings(db, ANNA_ID, later);
  assert.equal(found.breaches.length, 1);
  assert.equal(found.web.length, 0);
});

test('opnieuw zoeken verlengt de einddatum van wat je al had, zonder het dubbel te zetten of als nieuw te tellen', () => {
  const db = newDb();
  saveShortLived(db, ANNA_ID, [CLUB], NOW);

  const later = NOW + 20 * MINUTE;
  assert.equal(saveShortLived(db, ANNA_ID, [CLUB, GIDS], later), 1); // alleen GIDS is nieuw

  const rows = db.prepare('SELECT url, found_at, checked_at, expires_at FROM findings ORDER BY url').all();
  assert.equal(rows.length, 2);
  const club = rows.find((row) => row.url === CLUB.url);
  assert.equal(club.found_at, NOW);               // eerst gevonden: onveranderd
  assert.equal(club.checked_at, later);           // laatst onderzocht: nu
  assert.equal(club.expires_at, later + 30 * MINUTE);

  // Na de oorspronkelijke einddatum staat het nog, omdat het verlengd is.
  assert.deepEqual(urlsOf(db, ANNA_ID, NOW + 40 * MINUTE), [CLUB.url, GIDS.url].sort());
});

test('een resultaat dat net verlopen is en opnieuw gevonden wordt, telt als nieuw en komt bovenaan', () => {
  const db = newDb();
  saveShortLived(db, ANNA_ID, [CLUB], NOW);

  const later = NOW + 31 * MINUTE; // verlopen, maar removeExpired is nog niet langs geweest
  assert.deepEqual(urlsOf(db, ANNA_ID, later), []);
  assert.equal(saveShortLived(db, ANNA_ID, [CLUB], later), 1);

  const row = db.prepare('SELECT found_at, expires_at FROM findings').get();
  assert.equal(row.found_at, later); // het is voor jou weer een nieuwe vondst
  assert.equal(row.expires_at, later + 30 * MINUTE);
  assert.deepEqual(urlsOf(db, ANNA_ID, later), [CLUB.url]);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM findings').get().n, 1); // geen dubbele rij
});

test('resultaten van twee gebruikers verlopen los van elkaar', () => {
  const db = newDb();
  saveShortLived(db, ANNA_ID, [CLUB], NOW);
  saveShortLived(db, BRAM_ID, [CLUB], NOW + 20 * MINUTE);

  const at = NOW + 35 * MINUTE;
  removeExpired(db, at);
  assert.deepEqual(urlsOf(db, ANNA_ID, at), []);
  assert.deepEqual(urlsOf(db, BRAM_ID, at), [CLUB.url]);
});

// --- Jouw keuzes blijven, zonder het resultaat -----------------------------------------------

test('je keuze wordt bewaard als vingerafdruk van het adres, zonder adres, titel of tekst', () => {
  const db = newDb();
  saveShortLived(db, ANNA_ID, [CLUB, GIDS], NOW);

  assert.equal(setWebStatus(db, ANNA_ID, idOf(db, ANNA_ID, CLUB.url, NOW), 'mine', NOW + MINUTE), true);

  const choices = db.prepare('SELECT user_id, url_key, status, decided_at FROM web_choices').all()
    .map((row) => ({ ...row }));
  assert.deepEqual(choices, [
    { user_id: ANNA_ID, url_key: webKey(CLUB.url), status: 'mine', decided_at: NOW + MINUTE },
  ]);

  // In de tabel met keuzes staat nergens iets uit het resultaat.
  const dump = JSON.stringify(db.prepare('SELECT * FROM web_choices').all());
  for (const geheim of [CLUB.url, 'example.org', CLUB.title, 'Clubkampioenschappen', 'Anna de Vries']) {
    assert.ok(!dump.includes(geheim), `"${geheim}" staat in de keuzes`);
  }
});

test('een nieuwe keuze bij hetzelfde adres vervangt de vorige, ook bij de bewaarde keuze', () => {
  const db = newDb();
  saveShortLived(db, ANNA_ID, [CLUB], NOW);
  const id = idOf(db, ANNA_ID, CLUB.url, NOW);

  setWebStatus(db, ANNA_ID, id, 'mine', NOW + 1 * MINUTE);
  setWebStatus(db, ANNA_ID, id, 'not_mine', NOW + 2 * MINUTE);

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM web_choices').get().n, 1);
  const choice = db.prepare('SELECT status, decided_at FROM web_choices').get();
  assert.deepEqual({ ...choice }, { status: 'not_mine', decided_at: NOW + 2 * MINUTE });
  assert.equal(listFindings(db, ANNA_ID, NOW + 3 * MINUTE).web[0].status, 'not_mine');
});

test('een verlopen resultaat kun je niet meer beoordelen, en er wordt dan ook niets onthouden', () => {
  const db = newDb();
  saveShortLived(db, ANNA_ID, [CLUB], NOW);
  const id = idOf(db, ANNA_ID, CLUB.url, NOW);

  const late = NOW + 31 * MINUTE; // de pagina stond nog open
  assert.equal(setWebStatus(db, ANNA_ID, id, 'mine', late), false);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM web_choices').get().n, 0);
  assert.equal(db.prepare('SELECT status FROM findings').get().status, 'new');
});

test('je keuze overleeft het verlopen van het resultaat en geldt weer als hetzelfde adres opnieuw gevonden wordt', () => {
  const db = newDb();
  saveShortLived(db, ANNA_ID, [CLUB, GIDS, NAAMGENOOT], NOW);
  setWebStatus(db, ANNA_ID, idOf(db, ANNA_ID, CLUB.url, NOW), 'mine', NOW + MINUTE);
  setWebStatus(db, ANNA_ID, idOf(db, ANNA_ID, GIDS.url, NOW), 'not_mine', NOW + MINUTE);

  // Alles verloopt en wordt gewist.
  const later = NOW + 2 * 60 * MINUTE;
  removeExpired(db, later);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM findings').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM web_choices').get().n, 2);

  // Een nieuwe zoekronde vindt dezelfde adressen weer. Wat je al beoordeeld had, is dat nog steeds.
  const added = saveShortLived(db, ANNA_ID, [CLUB, GIDS, NAAMGENOOT], later);
  assert.equal(added, 1); // alleen de naamgenoot is echt nieuw voor jou
  const byUrl = Object.fromEntries(listFindings(db, ANNA_ID, later).web.map((item) => [item.url, item.status]));
  assert.deepEqual(byUrl, {
    [CLUB.url]: 'mine',
    [GIDS.url]: 'not_mine',
    [NAAMGENOOT.url]: 'new',
  });
  assert.deepEqual(countFindings(db, ANNA_ID, later), { breaches: 0, web: 3, webNew: 1, webMine: 1 });
});

test('een keuze geldt ook voor hetzelfde adres met een ander stuk na #', () => {
  const db = newDb();
  saveShortLived(db, ANNA_ID, [{ ...CLUB, url: 'https://example.org/club/uitslagen#a' }], NOW);
  setWebStatus(db, ANNA_ID, idOf(db, ANNA_ID, 'https://example.org/club/uitslagen#a', NOW), 'not_mine', NOW);

  const later = NOW + 40 * MINUTE;
  removeExpired(db, later);
  assert.equal(saveShortLived(db, ANNA_ID, [{ ...CLUB, url: 'https://example.org/club/uitslagen#b' }], later), 0);
  assert.equal(listFindings(db, ANNA_ID, later).web[0].status, 'not_mine');
});

test('keuzes zijn van één gebruiker: Bram krijgt niet wat Anna koos', () => {
  const db = newDb();
  saveShortLived(db, ANNA_ID, [CLUB], NOW);
  setWebStatus(db, ANNA_ID, idOf(db, ANNA_ID, CLUB.url, NOW), 'mine', NOW);

  assert.equal(saveShortLived(db, BRAM_ID, [CLUB], NOW), 1); // voor Bram is dit nieuw
  assert.equal(listFindings(db, BRAM_ID, NOW).web[0].status, 'new');
});

test('een account verwijderen wist ook de bewaarde keuzes', () => {
  const db = newDb();
  saveShortLived(db, ANNA_ID, [CLUB], NOW);
  setWebStatus(db, ANNA_ID, idOf(db, ANNA_ID, CLUB.url, NOW), 'mine', NOW);
  saveShortLived(db, BRAM_ID, [CLUB], NOW);
  setWebStatus(db, BRAM_ID, idOf(db, BRAM_ID, CLUB.url, NOW), 'unknown', NOW);

  db.prepare('DELETE FROM users WHERE id = ?').run(ANNA_ID);
  const rest = db.prepare('SELECT user_id FROM web_choices').all().map((row) => row.user_id);
  assert.deepEqual(rest, [BRAM_ID]);
});

// --- limitRetention ---------------------------------------------------------------------------

test('limitRetention geeft wat nog zonder einddatum bewaard staat een einddatum, alleen voor die zoekdienst', () => {
  const db = newDb();
  saveWebResults(db, ANNA_ID, [CLUB], NOW, { sourceId: 'brave' });           // zonder einddatum
  saveWebResults(db, ANNA_ID, [GIDS], NOW, { sourceId: 'demo' });            // andere dienst
  saveWebResults(db, BRAM_ID, [NAAMGENOOT], NOW, { sourceId: 'brave' });     // andere gebruiker, zelfde dienst
  saveShortLived(db, BRAM_ID, [CLUB], NOW);                                   // heeft al een einddatum
  saveBreaches(db, ANNA_ID, [{ ...ADOBE, source: 'hibp' }], NOW);

  const later = NOW + 5 * MINUTE;
  assert.equal(limitRetention(db, 'brave', later), 2);

  const expiry = (url, userId) => db
    .prepare('SELECT expires_at FROM findings WHERE url = ? AND user_id = ?').get(url, userId).expires_at;
  assert.equal(expiry(CLUB.url, ANNA_ID), later + 30 * MINUTE);
  assert.equal(expiry(NAAMGENOOT.url, BRAM_ID), later + 30 * MINUTE);
  assert.equal(expiry(GIDS.url, ANNA_ID), null);                 // de demo blijft zoals hij was
  assert.equal(expiry(CLUB.url, BRAM_ID), NOW + 30 * MINUTE);    // een bestaande einddatum blijft
  assert.equal(db.prepare("SELECT expires_at FROM findings WHERE kind = 'breach'").get().expires_at, null);

  // Een tweede keer is er niets meer te doen.
  assert.equal(limitRetention(db, 'brave', later + MINUTE), 0);

  // En na dat half uur is het echt weg.
  removeExpired(db, later + 31 * MINUTE);
  assert.deepEqual(urlsOf(db, ANNA_ID, later + 31 * MINUTE), [GIDS.url]);
});

// --- removeExpired ----------------------------------------------------------------------------

test('removeExpired wist alleen webresultaten waarvan de einddatum voorbij is', () => {
  const db = newDb();
  saveShortLived(db, ANNA_ID, [CLUB], NOW);                                   // verloopt op NOW + 30 min
  saveShortLived(db, ANNA_ID, [GIDS], NOW + 20 * MINUTE);                     // verloopt op NOW + 50 min
  saveWebResults(db, ANNA_ID, [NAAMGENOOT], NOW, { sourceId: 'demo' });       // geen einddatum
  saveBreaches(db, ANNA_ID, [{ ...ADOBE, source: 'hibp' }], NOW);

  removeExpired(db, NOW + 35 * MINUTE);
  const left = db.prepare('SELECT url, title FROM findings ORDER BY id').all().map((row) => row.url ?? row.title);
  assert.ok(!left.includes(CLUB.url));
  assert.ok(left.includes(GIDS.url));
  assert.ok(left.includes(NAAMGENOOT.url));
  assert.equal(left.length, 3); // GIDS, naamgenoot en het datalek
});

// --- purgeDemoData ----------------------------------------------------------------------------

function seedDemoAndReal(db) {
  // Anna: demo-resultaten met een keuze, een webscan en een rapport van de Deep Scan met demo.
  saveWebResults(db, ANNA_ID, [CLUB, GIDS], NOW, { sourceId: 'demo' });
  setWebStatus(db, ANNA_ID, idOf(db, ANNA_ID, CLUB.url, NOW), 'mine', NOW);
  recordScan(db, ANNA_ID, 'web', 2, 2, null, NOW);
  recordScan(db, ANNA_ID, 'breach', 1, 1, null, NOW);
  saveBreaches(db, ANNA_ID, [{ ...ADOBE, source: 'hibp' }], NOW);
  saveRun(db, ANNA_ID, {
    ranAt: NOW,
    steps: [{ id: 'datalekken', status: 'done' }, { id: 'web', status: 'done', demo: true }],
    exposure: [],
  });

  // Bram: alleen echte gegevens (een echte zoekdienst, een keuze, een rapport zonder demo).
  saveWebResults(db, BRAM_ID, [NAAMGENOOT], NOW, { sourceId: 'brave', expiresAt: NOW + WEB_RESULT_MS });
  setWebStatus(db, BRAM_ID, idOf(db, BRAM_ID, NAAMGENOOT.url, NOW), 'not_mine', NOW);
  recordScan(db, BRAM_ID, 'web', 1, 1, null, NOW);
  saveRun(db, BRAM_ID, {
    ranAt: NOW,
    steps: [{ id: 'datalekken', status: 'done' }, { id: 'web', status: 'done' }],
    exposure: [],
  });
}

test('purgeDemoData wist alles wat de demo verzon, en laat echte gegevens en andere gebruikers met rust', () => {
  const db = newDb();
  seedDemoAndReal(db);

  assert.equal(purgeDemoData(db), 2); // twee nepresultaten

  // Anna: de nepresultaten, haar keuze daarbij, haar webscan en haar demorapport zijn weg ...
  assert.deepEqual(urlsOf(db, ANNA_ID, NOW), []);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM web_choices WHERE user_id = ?').get(ANNA_ID).n, 0);
  assert.equal(lastScan(db, ANNA_ID, 'web'), null);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM scan_runs WHERE user_id = ?').get(ANNA_ID).n, 0);
  // ... maar haar datalek en haar datalekkenscan, die echt zijn, blijven.
  assert.equal(listFindings(db, ANNA_ID, NOW).breaches.length, 1);
  assert.ok(lastScan(db, ANNA_ID, 'breach'));

  // Bram: niets veranderd.
  assert.deepEqual(urlsOf(db, BRAM_ID, NOW), [NAAMGENOOT.url]);
  assert.equal(db.prepare('SELECT status FROM web_choices WHERE user_id = ?').get(BRAM_ID).status, 'not_mine');
  assert.ok(lastScan(db, BRAM_ID, 'web'));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM scan_runs WHERE user_id = ?').get(BRAM_ID).n, 1);
});

test('purgeDemoData twee keer draaien kan geen kwaad, en zonder demo-gegevens verandert er niets', () => {
  const db = newDb();
  seedDemoAndReal(db);
  assert.equal(purgeDemoData(db), 2);
  assert.equal(purgeDemoData(db), 0);

  const schoon = newDb();
  saveWebResults(schoon, BRAM_ID, [CLUB], NOW, { sourceId: 'brave', expiresAt: NOW + WEB_RESULT_MS });
  recordScan(schoon, BRAM_ID, 'web', 1, 1, null, NOW);
  assert.equal(purgeDemoData(schoon), 0);
  assert.deepEqual(urlsOf(schoon, BRAM_ID, NOW), [CLUB.url]);
  assert.ok(lastScan(schoon, BRAM_ID, 'web'));
});

test('een keuze bij een adres dat echt is blijft staan, ook als dezelfde gebruiker demo-resultaten had', () => {
  const db = newDb();
  saveWebResults(db, ANNA_ID, [CLUB], NOW, { sourceId: 'demo' });
  saveShortLived(db, ANNA_ID, [GIDS], NOW);
  setWebStatus(db, ANNA_ID, idOf(db, ANNA_ID, CLUB.url, NOW), 'mine', NOW);
  setWebStatus(db, ANNA_ID, idOf(db, ANNA_ID, GIDS.url, NOW), 'not_mine', NOW);

  assert.equal(purgeDemoData(db), 1);
  const keys = db.prepare('SELECT url_key FROM web_choices').all().map((row) => row.url_key);
  assert.deepEqual(keys, [webKey(GIDS.url)]);
  assert.deepEqual(urlsOf(db, ANNA_ID, NOW), [GIDS.url]);
});

test('een Deep Scan-rapport met kapotte stappen laat purgeDemoData niet vastlopen', () => {
  const db = newDb();
  db.prepare('INSERT INTO scan_runs (user_id, ran_at, steps, exposure) VALUES (?, ?, ?, ?)')
    .run(ANNA_ID, NOW, 'dit is geen json', '[]');
  assert.equal(purgeDemoData(db), 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM scan_runs').get().n, 1);
});
