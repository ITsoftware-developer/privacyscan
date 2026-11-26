// Tests voor de automatische kostenlimieten (src/budget.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_LIMITS, budgetState, budgetedSearch, parseLimit, perScanLimit, usedNow,
} from '../src/budget.js';
import { openDatabase } from '../src/db.js';
import { listEvents } from '../src/events.js';
import { utcDay } from '../src/monitor.js';
import { ScanError } from '../src/scan-error.js';
import { createDemoSearch } from '../src/search.js';
import {
  ANNA, CLUB, fakeHibp, fakeSearch, registerConfirmed, send, startServer,
} from './helpers.js';

const NOW = Date.UTC(2026, 10, 26, 12);
const isCode = (code) => (error) => error instanceof ScanError && error.code === code;
const usage = (db, service, day, calls) => db.prepare('INSERT INTO api_usage (service, day, calls, errors) VALUES (?, ?, ?, 0)')
  .run(service, day, calls);

test('parseLimit: leeg is de standaard, anders een heel getal van 1 of meer', () => {
  assert.equal(parseLimit('', 'X', 100), 100);
  assert.equal(parseLimit(undefined, 'X', 100), 100);
  assert.equal(parseLimit(' 50 ', 'X', 100), 50);
  for (const fout of ['0', '-1', 'abc', '1.5', '10 per dag', '99999999']) {
    assert.throws(() => parseLimit(fout, 'BRAVE_MAX_PER_DAY', 100), /BRAVE_MAX_PER_DAY moet een heel getal van 1 of meer zijn/, fout);
  }
  // De standaard blijft binnen het gratis maandtegoed van Brave ($5 = 1.000 aanvragen).
  assert.ok(DEFAULT_LIMITS.perMonth < 1000);
});

test('usedNow en budgetState tellen vandaag en deze maand (in UTC)', () => {
  const db = openDatabase(':memory:');
  usage(db, 'brave', utcDay(NOW), 7);
  usage(db, 'brave', '2026-11-02', 40);
  usage(db, 'brave', '2026-10-31', 500); // vorige maand: telt niet
  usage(db, 'xon', utcDay(NOW), 99);     // een andere dienst: telt niet
  assert.deepEqual(usedNow(db, 'brave', NOW), { day: 7, month: 47 });

  assert.deepEqual(budgetState(db, 'brave', { perDay: 10, perMonth: 100, perScan: 5 }, NOW), {
    day: { used: 7, max: 10 }, month: { used: 47, max: 100 }, reached: null,
  });
  assert.equal(budgetState(db, 'brave', { perDay: 7, perMonth: 100, perScan: 5 }, NOW).reached, 'day');
  assert.equal(budgetState(db, 'brave', { perDay: 7, perMonth: 47, perScan: 5 }, NOW).reached, 'month');
});

test('budgetedSearch: boven de grens geen aanvraag, en één melding per periode', async () => {
  const db = openDatabase(':memory:');
  const brave = fakeSearch({ name: 'brave', results: [CLUB] });
  const limited = budgetedSearch(brave, db, { perDay: 2, perMonth: 100, perScan: 25 }, { clock: () => NOW });
  assert.equal(limited.name, 'brave');

  await limited.search({ query: 'a' });
  usage(db, 'brave', utcDay(NOW), 2);
  await assert.rejects(limited.search({ query: 'b' }), isCode('budget'));
  await assert.rejects(limited.search({ query: 'c' }), isCode('budget'));
  assert.equal(brave.calls.length, 1);
  assert.deepEqual(listEvents(db).map((event) => event.text), [
    'Kostengrens bereikt: Brave Search krijgt vandaag geen aanvragen meer van de site.',
  ]);

  // De volgende dag werkt het weer, zonder dat iemand iets hoeft te doen.
  const tomorrow = budgetedSearch(brave, db, { perDay: 2, perMonth: 100, perScan: 25 }, { clock: () => NOW + 86400000 });
  await tomorrow.search({ query: 'd' });
  assert.equal(brave.calls.length, 2);
});

test('budgetedSearch laat de demo en onbekende diensten ongemoeid', () => {
  const db = openDatabase(':memory:');
  const demo = createDemoSearch();
  const other = fakeSearch({ name: 'nep' });
  assert.equal(budgetedSearch(demo, db), demo);
  assert.equal(budgetedSearch(other, db), other);
  assert.equal(budgetedSearch(null, db), null);
});

test('perScanLimit: elk onderzoek hooguit zoveel zoekopdrachten', async () => {
  const search = fakeSearch({ name: 'brave' });
  const scan = perScanLimit(search, 2);
  await scan.search({ query: '1' });
  await scan.search({ query: '2' });
  await assert.rejects(scan.search({ query: '3' }), isCode('budget_scan'));
  assert.equal(scan.queriesUsed, 2);
  assert.equal(search.calls.length, 2);
  const next = perScanLimit(search, 2); // een nieuw onderzoek begint weer bij nul
  await next.search({ query: '4' });
  assert.equal(next.queriesUsed, 1);
});

test('via de site: grens bereikt, dan zegt het zoeken en de Deep Scan dat eerlijk, en de beheerpagina ook', async (t) => {
  const search = fakeSearch({ name: 'brave', results: [CLUB] });
  const owner = { ...ANNA, email: 'eigenaar@example.com' };
  const {
    base, db, mailer,
  } = await startServer(t, {
    search, hibp: fakeHibp(), ownerEmail: owner.email, budget: { perDay: 1, perMonth: 10, perScan: 25 },
  });
  const cookie = await registerConfirmed(base, mailer, owner);
  usage(db, 'brave', utcDay(Date.now()), 1);

  const scan = await send(base, '/scan/web', { method: 'POST', cookie });
  assert.equal(scan.status, 429);
  assert.match(await scan.text(), /maximum aantal zoekopdrachten voor vandaag of deze maand bereikt/);
  await send(base, '/scan/deep', { method: 'POST', cookie });
  assert.equal(search.calls.length, 0);
  const report = await (await send(base, '/resultaten', { cookie })).text();
  assert.match(report, /De grens voor zoekopdrachten van de site \(per dag of per maand\) is bereikt/);

  const admin = await (await send(base, '/beheerder', { cookie })).text();
  assert.match(admin, /Kostengrens bereikt/);
  assert.match(admin, /Bereikt: geen zoekopdrachten meer vandaag/);
  assert.match(admin, /vandaag <strong>1<\/strong> van 1/);
  assert.match(admin, /Hooguit 1 zoekopdrachten per dag, 10 per maand en 25 per Deep Scan/);
});
