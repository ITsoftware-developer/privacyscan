// Tests voor de pauzeknoppen (src/controls.js) en de proefaanvragen (src/probes.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBreachCheck } from '../src/breach-check.js';
import {
  canPause, isPaused, pausableBreachCheck, pausableSearch, pausedSince, setPaused,
} from '../src/controls.js';
import { openDatabase } from '../src/db.js';
import {
  EXAMPLE_ADDRESS, HIBP_TEST_ADDRESS, NEUTRAL_QUERY, probeHibp, probeSearch, probeXon,
} from '../src/probes.js';
import { ScanError } from '../src/scan-error.js';
import { createDemoSearch } from '../src/search.js';
import { fakeHibp, fakeSearch } from './helpers.js';

const isCode = (code) => (error) => error instanceof ScanError && error.code === code;

test('pauzeren, hervatten en "sinds wanneer" staan in de database', () => {
  const db = openDatabase(':memory:');
  assert.equal(isPaused(db, 'brave'), false);
  assert.equal(setPaused(db, 'brave', true, 1000), true);
  assert.equal(setPaused(db, 'brave', true, 2000), false); // al gepauzeerd: niets veranderd
  assert.equal(isPaused(db, 'brave'), true);
  assert.equal(pausedSince(db, 'brave'), 1000);
  assert.equal(isPaused(db, 'xon'), false);

  assert.equal(setPaused(db, 'brave', false), true);
  assert.equal(setPaused(db, 'brave', false), false);
  assert.equal(isPaused(db, 'brave'), false);
  assert.equal(pausedSince(db, 'brave'), null);
});

test('alleen bekende, pauzeerbare bronnen kunnen op pauze', () => {
  const db = openDatabase(':memory:');
  assert.equal(canPause('brave'), true);
  assert.equal(canPause('xon'), true);
  assert.equal(canPause('hibp'), true);
  assert.equal(canPause('pwned-passwords'), false);
  assert.equal(canPause('toString'), false);
  assert.throws(() => setPaused(db, 'pwned-passwords', true), /kan niet gepauzeerd worden/);
  assert.throws(() => setPaused(db, 'google', true), /kan niet gepauzeerd worden/);
});

test('pausableSearch: op pauze komt er geen aanvraag, de rest van de zoekdienst blijft hetzelfde', async () => {
  const db = openDatabase(':memory:');
  const brave = fakeSearch({ name: 'brave', results: [{ title: 'x', url: 'https://example.org', snippet: '' }], retainsResults: false });
  const guarded = pausableSearch(brave, db);

  assert.equal(guarded.name, 'brave');
  assert.equal(guarded.retainsResults, false);
  assert.equal(guarded.isDemo, false);
  assert.equal((await guarded.search({ query: 'q' })).length, 1);

  setPaused(db, 'brave', true);
  await assert.rejects(guarded.search({ query: 'q' }), isCode('paused'));
  assert.equal(brave.calls.length, 1); // de tweede aanvraag is nooit verstuurd

  setPaused(db, 'brave', false);
  await guarded.search({ query: 'q' });
  assert.equal(brave.calls.length, 2);

  // Een waarde die later verandert, komt ook door (de Proxy geeft door, hij kopieert niet).
  brave.retainsResults = true;
  assert.equal(guarded.retainsResults, true);
});

test('pausableSearch laat de demo, onbekende zoekdiensten en "geen zoekdienst" ongemoeid', () => {
  const db = openDatabase(':memory:');
  const demo = createDemoSearch();
  const other = fakeSearch({ name: 'nep' });
  assert.equal(pausableSearch(demo, db), demo);
  assert.equal(pausableSearch(other, db), other);
  assert.equal(pausableSearch(null, db), null);
});

test('pausableBreachCheck pauzeert alleen de bron die het adres opzoekt', async () => {
  const db = openDatabase(':memory:');
  const hibp = { hasKey: false, hasKeyFor: (email) => email.endsWith('@hibp-integration-tests.com'), calls: [], async breachesFor(email) { hibp.calls.push(email); return []; } };
  const xon = { calls: [], async breachesFor(email) { xon.calls.push(email); return []; } };
  const guarded = pausableBreachCheck(createBreachCheck({ hibp, xon }), db);

  setPaused(db, 'xon', true);
  await assert.rejects(guarded.breachesFor('anna@example.com'), isCode('paused'));
  await guarded.breachesFor(HIBP_TEST_ADDRESS); // die gaat naar HIBP, en die staat niet op pauze
  assert.deepEqual(xon.calls, []);
  assert.deepEqual(hibp.calls, [HIBP_TEST_ADDRESS]);
  assert.equal(guarded.sourceFor('anna@example.com'), 'xon'); // de rest werkt gewoon
  assert.equal(guarded.hasKey, true);

  setPaused(db, 'xon', false);
  setPaused(db, 'hibp', true);
  await guarded.breachesFor('anna@example.com');
  await assert.rejects(guarded.breachesFor(HIBP_TEST_ADDRESS), isCode('paused'));
});

test('pausableBreachCheck: een controle zonder sourceFor (zoals de nepversie) geldt als HIBP', async () => {
  const db = openDatabase(':memory:');
  const fake = fakeHibp();
  const guarded = pausableBreachCheck(fake, db);
  setPaused(db, 'hibp', true);
  await assert.rejects(guarded.breachesFor('anna@example.com'), isCode('paused'));
  assert.deepEqual(fake.calls, []);
  fake.hasKey = false; // ook hier geeft de Proxy de actuele waarde door
  assert.equal(guarded.hasKey, false);
});

// --- Proefaanvragen ---------------------------------------------------------------------------------

test('probeSearch zoekt alleen de neutrale zoekopdracht en zegt in gewone woorden hoe het ging', async () => {
  const search = fakeSearch({ results: [{ title: 'Domtoren', url: 'https://example.org/dom', snippet: 'x' }] });
  assert.deepEqual(await probeSearch(search), { ok: true, text: 'De sleutel werkt: 1 resultaat gelezen bij een neutrale zoekopdracht.' });
  assert.deepEqual(search.calls, [{ query: NEUTRAL_QUERY, name: 'Domtoren', city: 'Utrecht' }]);

  search.results = [];
  assert.equal((await probeSearch(search)).ok, false);

  search.error = new ScanError('bad_key');
  assert.deepEqual(await probeSearch(search), { ok: false, text: 'Brave weigert de sleutel (HTTP 401 of 403). Controleer BRAVE_API_KEY in je .env: de sleutel van je Search-abonnement, zonder aanhalingstekens of spaties.' });
  search.error = new Error('kapot\nmet een tweede regel');
  assert.deepEqual(await probeSearch(search), { ok: false, text: 'Onverwachte fout: kapot' });
});

test('probeXon en probeHibp gebruiken alleen het voorbeeldadres en het testadres', async () => {
  const asked = [];
  const xon = { listSize: async () => 812, breachesFor: async (email) => { asked.push(email); return []; } };
  assert.deepEqual(await probeXon(xon), { ok: true, text: 'De lijst met bekende lekken is gelezen (812 lekken) en een controle met een voorbeeldadres is gelukt.' });
  assert.deepEqual(asked, [EXAMPLE_ADDRESS]);
  assert.equal((await probeXon({ ...xon, listSize: async () => { throw new ScanError('rate_limited'); } })).text,
    'XposedOrNot staat geen aanvragen meer toe: de gratis limiet (25 per uur, 100 per dag) is bereikt. Probeer het later nog eens.');

  const hibp = fakeHibp({ breaches: [{ name: 'Adobe' }] });
  assert.deepEqual(await probeHibp(hibp), { ok: true, text: 'Het testadres van Have I Been Pwned is gecontroleerd (1 lek).' });
  assert.deepEqual(hibp.calls, [HIBP_TEST_ADDRESS]);
  hibp.error = new ScanError('bad_key');
  assert.deepEqual(await probeHibp(hibp), { ok: false, text: 'Have I Been Pwned weigert de sleutel. Controleer HIBP_API_KEY in je .env.' });
});
