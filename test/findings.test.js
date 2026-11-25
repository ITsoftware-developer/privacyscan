// Tests voor het bewaren, ordenen en beoordelen van resultaten.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db.js';
import {
  WEB_CHOICES, countFindings, lastRun, lastScan, listFindings, recordScan, saveBreaches, saveRun, saveWebResults,
  setWebStatus,
} from '../src/findings.js';
import { ADOBE, CLUB, GIDS, NAAMGENOOT } from './helpers.js';

const ANNA_ID = 1;
const BRAM_ID = 2;

function newDb() {
  const db = openDatabase(':memory:');
  for (const [id, email] of [[ANNA_ID, 'anna@example.com'], [BRAM_ID, 'bram@example.com']]) {
    db.prepare('INSERT INTO users (id, name, email, password_hash, created_at) VALUES (?, ?, ?, ?, 0)')
      .run(id, `Gebruiker ${id}`, email, 'x');
  }
  return db;
}

function webOf(db, userId = ANNA_ID) {
  return listFindings(db, userId).web;
}

function idOf(db, url, userId = ANNA_ID) {
  return webOf(db, userId).find((item) => item.url === url).id;
}

test('je hebt drie keuzes bij een webresultaat, en "nog niet beoordeeld" is er geen van', () => {
  assert.deepEqual(WEB_CHOICES, {
    mine: 'Dit ben ik',
    not_mine: 'Dit ben ik niet',
    unknown: 'Weet ik niet',
  });
  assert.ok(!('new' in WEB_CHOICES));
});

test('nieuwe webresultaten krijgen de status "new" en bewaren titel, adres en tekst', () => {
  const db = newDb();
  assert.equal(saveWebResults(db, ANNA_ID, [CLUB, GIDS], 1000), 2);

  const web = webOf(db);
  assert.equal(web.length, 2);
  assert.deepEqual(web.map((item) => item.status), ['new', 'new']);
  assert.deepEqual(web.map((item) => item.kind), ['web', 'web']);
  assert.equal(web[0].title, CLUB.title);
  assert.equal(web[0].url, CLUB.url);
  assert.deepEqual(web[0].details, { snippet: CLUB.snippet });
  assert.deepEqual(listFindings(db, ANNA_ID).breaches, []);
});

test('opnieuw bewaren zet niets dubbel, houdt je keuze en werkt titel en tekst bij', () => {
  const db = newDb();
  saveWebResults(db, ANNA_ID, [CLUB, GIDS], 1000);
  setWebStatus(db, ANNA_ID, idOf(db, CLUB.url), 'mine');

  const added = saveWebResults(db, ANNA_ID, [
    { ...CLUB, title: 'Nieuwe titel', snippet: 'Nieuwe tekst' },
    GIDS,
    NAAMGENOOT,
  ], 2000);

  assert.equal(added, 1); // alleen de naamgenoot was nieuw
  const web = webOf(db);
  assert.equal(web.length, 3);
  const club = web.find((item) => item.url === CLUB.url);
  assert.equal(club.status, 'mine'); // je keuze blijft staan
  assert.equal(club.title, 'Nieuwe titel');
  assert.equal(club.details.snippet, 'Nieuwe tekst');
  assert.equal(club.found_at, 1000); // het was al eerder gevonden
  assert.equal(web.find((item) => item.url === GIDS.url).status, 'new');
  assert.equal(web.find((item) => item.url === NAAMGENOOT.url).status, 'new');
});

test('dezelfde lijst twee keer in één keer bewaren geeft ook geen dubbelen', () => {
  const db = newDb();
  assert.equal(saveWebResults(db, ANNA_ID, [CLUB, CLUB, GIDS], 1000), 2);
  assert.equal(webOf(db).length, 2);
});

test('webresultaten staan op de volgorde van de zoekdienst, met wat nieuw is bovenaan', () => {
  const db = newDb();
  saveWebResults(db, ANNA_ID, [CLUB, GIDS], 1000);
  saveWebResults(db, ANNA_ID, [NAAMGENOOT, CLUB, GIDS], 2000);

  const order = () => webOf(db).map((item) => item.url);
  assert.deepEqual(order(), [NAAMGENOOT.url, CLUB.url, GIDS.url]);

  // Een keuze verandert de volgorde niet: anders springt het resultaat weg zodra je klikt.
  for (const [url, status] of [[CLUB.url, 'mine'], [GIDS.url, 'not_mine'], [NAAMGENOOT.url, 'unknown']]) {
    setWebStatus(db, ANNA_ID, idOf(db, url), status);
    assert.deepEqual(order(), [NAAMGENOOT.url, CLUB.url, GIDS.url]);
  }
});

test('kapotte of vreemde opgeslagen details laten de lijst niet vastlopen', () => {
  const db = newDb();
  const insert = db.prepare(`INSERT INTO findings (user_id, kind, source_key, title, details, found_at, updated_at)
                             VALUES (?, 'web', ?, ?, ?, 0, 0)`);
  insert.run(ANNA_ID, 'https://example.org/een', 'Kapot', '{dit is geen json');
  insert.run(ANNA_ID, 'https://example.org/twee', 'Een getal', '42');
  insert.run(ANNA_ID, 'https://example.org/drie', 'Leeg', 'null');
  insert.run(ANNA_ID, 'https://example.org/vier', 'Goed', '{"snippet":"tekst"}');

  const web = webOf(db);
  assert.deepEqual(web.map((item) => item.details), [{}, {}, {}, { snippet: 'tekst' }]);
});

test('datalekken staan met het nieuwste lek bovenaan, los van de webresultaten', () => {
  const db = newDb();
  saveBreaches(db, ANNA_ID, [
    { ...ADOBE, name: 'Oud', title: 'Oud', breachDate: '2009-01-01' },
    ADOBE,
  ], 1000);
  saveWebResults(db, ANNA_ID, [CLUB], 1000);

  const { breaches, web } = listFindings(db, ANNA_ID);
  assert.deepEqual(breaches.map((item) => item.title), ['Adobe', 'Oud']);
  assert.equal(web.length, 1);
});

test('setWebStatus verandert alleen je eigen webresultaten', () => {
  const db = newDb();
  saveWebResults(db, ANNA_ID, [CLUB], 1000);
  saveWebResults(db, BRAM_ID, [CLUB, GIDS], 1000);
  saveBreaches(db, ANNA_ID, [ADOBE], 1000);
  const annaClub = idOf(db, CLUB.url, ANNA_ID);
  const bramClub = idOf(db, CLUB.url, BRAM_ID);
  const breachId = listFindings(db, ANNA_ID).breaches[0].id;

  // Bram kan Annas resultaat niet aanpassen.
  assert.equal(setWebStatus(db, BRAM_ID, annaClub, 'not_mine'), false);
  assert.equal(webOf(db, ANNA_ID)[0].status, 'new');

  // En Anna het resultaat van Bram niet.
  assert.equal(setWebStatus(db, ANNA_ID, bramClub, 'mine'), false);
  assert.equal(webOf(db, BRAM_ID).find((item) => item.id === bramClub).status, 'new');

  // Een datalek is geen webresultaat, ook niet van jezelf.
  assert.equal(setWebStatus(db, ANNA_ID, breachId, 'not_mine'), false);
  assert.equal(listFindings(db, ANNA_ID).breaches[0].status, 'mine');

  // Een id dat niet bestaat.
  assert.equal(setWebStatus(db, ANNA_ID, 9999, 'mine'), false);

  // Je eigen resultaat wel, en je mag van gedachten veranderen.
  assert.equal(setWebStatus(db, ANNA_ID, annaClub, 'mine'), true);
  assert.equal(webOf(db, ANNA_ID)[0].status, 'mine');
  assert.equal(setWebStatus(db, ANNA_ID, annaClub, 'unknown'), true);
  assert.equal(webOf(db, ANNA_ID)[0].status, 'unknown');
});

test('de database zelf weigert een status die niet bestaat', () => {
  const db = newDb();
  saveWebResults(db, ANNA_ID, [CLUB], 1000);
  assert.throws(() => setWebStatus(db, ANNA_ID, idOf(db, CLUB.url), 'misschien'), /CHECK/);
  assert.equal(webOf(db)[0].status, 'new');
});

test('countFindings telt datalekken en webresultaten per status, per gebruiker', () => {
  const db = newDb();
  saveBreaches(db, ANNA_ID, [ADOBE], 1000);
  saveWebResults(db, ANNA_ID, [CLUB, GIDS, NAAMGENOOT], 1000);
  setWebStatus(db, ANNA_ID, idOf(db, CLUB.url), 'mine');
  setWebStatus(db, ANNA_ID, idOf(db, GIDS.url), 'not_mine');
  saveWebResults(db, BRAM_ID, [CLUB], 1000);

  assert.deepEqual(countFindings(db, ANNA_ID), { breaches: 1, web: 3, webNew: 1, webMine: 1 });
  assert.deepEqual(countFindings(db, BRAM_ID), { breaches: 0, web: 1, webNew: 1, webMine: 0 });
  assert.deepEqual(countFindings(db, 99), { breaches: 0, web: 0, webNew: 0, webMine: 0 });
});

test('een scan per soort per gebruiker: de laatste wint', () => {
  const db = newDb();
  assert.equal(lastScan(db, ANNA_ID, 'web'), null);

  recordScan(db, ANNA_ID, 'web', 3, 3, '"Anna de Vries"', 1000);
  assert.deepEqual({ ...lastScan(db, ANNA_ID, 'web') }, {
    ran_at: 1000, found_count: 3, new_count: 3, detail: '"Anna de Vries"',
  });

  recordScan(db, ANNA_ID, 'web', 4, 1, '"Anna de Vries" "Utrecht"', 2000);
  assert.deepEqual({ ...lastScan(db, ANNA_ID, 'web') }, {
    ran_at: 2000, found_count: 4, new_count: 1, detail: '"Anna de Vries" "Utrecht"',
  });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM scans WHERE kind = 'web'").get().n, 1);

  // Datalekken en andere gebruikers hebben een eigen scan.
  assert.equal(lastScan(db, ANNA_ID, 'breach'), null);
  assert.equal(lastScan(db, BRAM_ID, 'web'), null);
});

test('account verwijderen wist de webresultaten en scans van die gebruiker, en niet meer', () => {
  const db = newDb();
  saveWebResults(db, ANNA_ID, [CLUB, GIDS], 1000);
  saveWebResults(db, BRAM_ID, [CLUB], 1000);
  recordScan(db, ANNA_ID, 'web', 2, 2, 'x', 1000);
  recordScan(db, BRAM_ID, 'web', 1, 1, 'x', 1000);

  db.prepare('DELETE FROM users WHERE id = ?').run(ANNA_ID);

  assert.equal(webOf(db, ANNA_ID).length, 0);
  assert.equal(lastScan(db, ANNA_ID, 'web'), null);
  assert.equal(webOf(db, BRAM_ID).length, 1);
  assert.notEqual(lastScan(db, BRAM_ID, 'web'), null);
});

// --- Bewijs bij elke bevinding: bron, datum en zekerheid ---------------------------------------

test('een datalek bewaart zijn bron, zijn zekerheid en wanneer het onderzocht is', () => {
  const db = newDb();
  saveBreaches(db, ANNA_ID, [
    { ...ADOBE, title: 'Adobe' },
    { name: 'LinkedIn', title: 'LinkedIn', source: 'xon', url: 'https://example.com/linkedin', dataClasses: [] },
  ], 5000);

  const [linkedin, adobe] = [
    listFindings(db, ANNA_ID).breaches.find((item) => item.title === 'LinkedIn'),
    listFindings(db, ANNA_ID).breaches.find((item) => item.title === 'Adobe'),
  ];
  assert.deepEqual([adobe.source_id, adobe.confidence, adobe.checked_at], ['hibp', 'hoog', 5000]); // zonder bron: HIBP
  assert.deepEqual([linkedin.source_id, linkedin.confidence, linkedin.checked_at], ['xon', 'hoog', 5000]);
  assert.match(adobe.confidence_note, /letterlijke overeenkomst/);
});

test('een datalek dat opnieuw gezien wordt, krijgt een nieuwe onderzoeksdatum maar houdt zijn eerste vondst', () => {
  const db = newDb();
  saveBreaches(db, ANNA_ID, [ADOBE], 1000);
  assert.equal(saveBreaches(db, ANNA_ID, [ADOBE], 9000), 0);

  const row = db.prepare("SELECT found_at, updated_at, checked_at FROM findings WHERE kind = 'breach'").get();
  assert.deepEqual({ ...row }, { found_at: 1000, updated_at: 9000, checked_at: 9000 });
});

test('een webresultaat bewaart zijn bron en zekerheid, en wordt bij een nieuwe ronde opnieuw beoordeeld', () => {
  const db = newDb();
  const asked = [];
  const rate = (result) => {
    asked.push(result.url);
    return { level: 'gemiddeld', note: 'Alleen je naam staat erin.' };
  };
  saveWebResults(db, ANNA_ID, [CLUB], 1000, { sourceId: 'brave', rate });

  let item = webOf(db)[0];
  assert.deepEqual([item.source_id, item.confidence, item.confidence_note, item.checked_at], [
    'brave', 'gemiddeld', 'Alleen je naam staat erin.', 1000,
  ]);
  assert.deepEqual(asked, [CLUB.url]);

  // Een woonplaats kan veranderd zijn: dan is dezelfde pagina ineens zekerder.
  saveWebResults(db, ANNA_ID, [CLUB], 2000, { sourceId: 'brave', rate: () => ({ level: 'hoog', note: 'Naam en woonplaats.' }) });
  item = webOf(db)[0];
  assert.deepEqual([item.confidence, item.confidence_note, item.checked_at], ['hoog', 'Naam en woonplaats.', 2000]);
  assert.equal(webOf(db).length, 1);
});

test('bewaren zonder bewijs wist geen bewijs dat er al was, maar werkt wel de datum bij', () => {
  const db = newDb();
  saveWebResults(db, ANNA_ID, [CLUB], 1000, { sourceId: 'brave', rate: () => ({ level: 'laag', note: 'Niet erin.' }) });
  saveWebResults(db, ANNA_ID, [CLUB], 3000); // zonder bewijs: zoals de oude aanroep

  const item = webOf(db)[0];
  assert.deepEqual([item.source_id, item.confidence, item.confidence_note], ['brave', 'laag', 'Niet erin.']);
  assert.equal(item.checked_at, 3000);
});

test('zonder bewijs bewaard blijft zonder bewijs: er wordt niets verzonnen', () => {
  const db = newDb();
  saveWebResults(db, ANNA_ID, [CLUB], 1000);
  const item = webOf(db)[0];
  assert.deepEqual([item.source_id, item.confidence, item.confidence_note], [null, null, null]);
  assert.equal(item.checked_at, 1000);
});

test('jouw keuze verandert niet wanneer een resultaat onderzocht is', () => {
  const db = newDb();
  saveWebResults(db, ANNA_ID, [CLUB], 1000, { sourceId: 'brave' });
  setWebStatus(db, ANNA_ID, idOf(db, CLUB.url), 'mine');
  const item = webOf(db)[0];
  assert.equal(item.status, 'mine');
  assert.equal(item.checked_at, 1000); // updated_at verandert door je keuze, checked_at niet
});

// --- Het rapport van de laatste Deep Scan ------------------------------------------------------

const RUN = {
  ranAt: 4000,
  steps: [
    { id: 'datalekken', title: 'Datalekdatabases onderzoeken', status: 'done', sources: ['hibp'], note: '1 datalek.' },
    { id: 'databrokers', title: 'Databrokers controleren', status: 'planned', sources: [], note: 'Nog niet.' },
  ],
  exposure: [{ id: 'inloggegevens', label: 'Inloggegevens', breaches: ['Adobe'], advice: 'Pas je wachtwoord aan.' }],
};

test('het rapport van de laatste Deep Scan wordt bewaard en teruggegeven zoals het was', () => {
  const db = newDb();
  assert.equal(lastRun(db, ANNA_ID), null); // nog geen Deep Scan

  saveRun(db, ANNA_ID, RUN);
  assert.deepEqual(lastRun(db, ANNA_ID), RUN);
  assert.equal(lastRun(db, BRAM_ID), null); // van Anna alleen
});

test('een nieuw rapport vervangt het vorige, per gebruiker', () => {
  const db = newDb();
  saveRun(db, ANNA_ID, RUN);
  saveRun(db, BRAM_ID, { ...RUN, ranAt: 1 });
  saveRun(db, ANNA_ID, { ranAt: 9000, steps: [], exposure: [] });

  assert.deepEqual(lastRun(db, ANNA_ID), { ranAt: 9000, steps: [], exposure: [] });
  assert.equal(lastRun(db, BRAM_ID).ranAt, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM scan_runs').get().n, 2);
});

test('een kapot bewaard rapport geeft niets terug, in plaats van iets verkeerds', () => {
  const db = newDb();
  saveRun(db, ANNA_ID, RUN);

  for (const [steps, exposure] of [
    ['geen json', '[]'], ['[]', 'ook geen json'], ['{"een":"object"}', '[]'], ['[]', '"tekst"'], ['null', '[]'], ['', ''],
  ]) {
    db.prepare('UPDATE scan_runs SET steps = ?, exposure = ? WHERE user_id = ?').run(steps, exposure, ANNA_ID);
    assert.equal(lastRun(db, ANNA_ID), null, `${steps} / ${exposure}`);
  }
});
