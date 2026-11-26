// Tests voor het meten van het verkeer naar de externe diensten (src/monitor.js): tellers per dag,
// wat een fout is, de limieten die Brave meegeeft, en nooit een adres of zoekopdracht.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db.js';
import { listEvents } from '../src/events.js';
import {
  createMonitor, isSuccess, parseRateLimits, utcDay, windowLabel,
} from '../src/monitor.js';

const answer = (status, headers = {}) => async () => new Response('{}', { status, headers });

function dump(db) {
  return JSON.stringify([
    db.prepare('SELECT * FROM api_usage').all(),
    db.prepare('SELECT * FROM system_events').all(),
  ]);
}

test('isSuccess: 2xx is gelukt; 404 alleen bij de datalekbronnen ("staat in geen lek")', () => {
  for (const service of ['brave', 'xon', 'hibp', 'pwned-passwords']) {
    assert.equal(isSuccess(service, 200), true, service);
    assert.equal(isSuccess(service, 429), false, service);
    assert.equal(isSuccess(service, 500), false, service);
  }
  assert.equal(isSuccess('xon', 404), true);
  assert.equal(isSuccess('hibp', 404), true);
  assert.equal(isSuccess('brave', 404), false);
  assert.equal(isSuccess('pwned-passwords', 404), false);
});

test('fetchFor telt elke aanvraag per dienst per dag, en mislukte apart', async () => {
  const db = openDatabase(':memory:');
  const monitor = createMonitor(db);
  const brave = monitor.fetchFor('brave', answer(200));
  const braveFail = monitor.fetchFor('brave', answer(429));
  const xon = monitor.fetchFor('xon', answer(404));

  await brave('https://api.search.brave.com/res/v1/web/search?q=%22Anna%20de%20Vries%22');
  await brave('https://api.search.brave.com/res/v1/web/search?q=x');
  const failed = await braveFail('https://api.search.brave.com/res/v1/web/search?q=y');
  assert.equal(failed.status, 429); // het antwoord gaat ongewijzigd door
  await xon('https://api.xposedornot.com/v1/check-email/anna%40example.com');

  const { services, today } = monitor.usage();
  assert.equal(today, utcDay(Date.now()));
  assert.deepEqual(services.brave.today, { calls: 3, errors: 1 });
  assert.deepEqual(services.brave.month, { calls: 3, errors: 1 });
  assert.deepEqual(services.xon.today, { calls: 1, errors: 0 }); // 404 = niet in een lek, geen fout
  assert.deepEqual(services.hibp.today, { calls: 0, errors: 0 });

  const live = monitor.live();
  assert.equal(live.brave.lastOk, false);
  assert.equal(live.brave.lastStatus, 429);
  assert.equal(typeof live.brave.lastMs, 'number');
  assert.ok(live.brave.lastFailureAt > 0);

  // In het systeemlog: alleen de dienst en de status.
  assert.deepEqual(listEvents(db).map((event) => event.text), ['Brave Search antwoordde met HTTP 429.']);
  // Nergens een adres, zoekopdracht of e-mailadres.
  assert.ok(!/anna|Vries|search\.brave|xposedornot|check-email|q=/i.test(dump(db)));
  assert.ok(!/anna|Vries|q=|http/i.test(JSON.stringify(live)));
});

test('een netwerkfout telt als mislukt, komt in het log en gaat gewoon door naar de koppeling', async () => {
  const db = openDatabase(':memory:');
  const monitor = createMonitor(db);
  const broken = monitor.fetchFor('hibp', async () => { throw new TypeError('fetch failed: anna@example.com'); });
  await assert.rejects(broken('https://haveibeenpwned.com/api/v3/breachedaccount/anna%40example.com'), TypeError);

  assert.deepEqual(monitor.usage().services.hibp.today, { calls: 1, errors: 1 });
  assert.equal(monitor.live().hibp.lastStatus, null);
  assert.deepEqual(listEvents(db).map((event) => event.text), ['Have I Been Pwned: geen antwoord (netwerk of time-out).']);
  assert.ok(!dump(db).includes('anna'));
});

test('fetchFor weigert een onbekende dienst', () => {
  const monitor = createMonitor(openDatabase(':memory:'));
  assert.throws(() => monitor.fetchFor('google'), /Onbekende dienst: google/);
});

test('de limieten van Brave worden gelezen zoals hun handleiding ze beschrijft', async () => {
  const headers = (values) => new Headers(values);
  assert.deepEqual(parseRateLimits(headers({
    'X-RateLimit-Limit': '1, 15000',
    'X-RateLimit-Policy': '1;w=1, 15000;w=2592000',
    'X-RateLimit-Remaining': '1, 1000',
    'X-RateLimit-Reset': '1, 1419704',
  })), [
    { window: 1, limit: 1, remaining: 1, reset: 1 },
    { window: 2592000, limit: 15000, remaining: 1000, reset: 1419704 },
  ]);
  // Zonder Policy-header: eerst per seconde, dan per maand.
  assert.deepEqual(parseRateLimits(headers({ 'X-RateLimit-Remaining': '49, 812' })), [
    { window: 1, limit: null, remaining: 49, reset: null },
    { window: 2592000, limit: null, remaining: 812, reset: null },
  ]);
  // Eén venster.
  assert.deepEqual(parseRateLimits(headers({ 'X-RateLimit-Remaining': '50', 'X-RateLimit-Limit': '50' })), [
    { window: 1, limit: 50, remaining: 50, reset: null },
  ]);
  // Ontbreekt of onleesbaar: niets.
  assert.equal(parseRateLimits(headers({})), null);
  assert.equal(parseRateLimits(headers({ 'X-RateLimit-Remaining': 'veel' })), null);
  assert.equal(parseRateLimits(null), null);

  // De monitor onthoudt ze bij een antwoord van Brave.
  const monitor = createMonitor(openDatabase(':memory:'));
  await monitor.fetchFor('brave', answer(200, { 'X-RateLimit-Remaining': '1, 999', 'X-RateLimit-Limit': '1, 1000' }))('https://x');
  assert.deepEqual(monitor.live().brave.limits[1], { window: 2592000, limit: 1000, remaining: 999, reset: null });
  assert.ok(monitor.live().brave.limitsAt > 0);
});

test('windowLabel geeft een gewone omschrijving van een venster', () => {
  assert.equal(windowLabel(1), 'per seconde');
  assert.equal(windowLabel(86400), 'per dag');
  assert.equal(windowLabel(2592000), 'per maand');
  assert.equal(windowLabel(7200), 'per 7.200 seconden');
  assert.equal(windowLabel(null), 'per periode');
});

test('usage verdeelt de tellers over vandaag, deze maand en vorige maand (in UTC)', () => {
  const db = openDatabase(':memory:');
  const insert = db.prepare('INSERT INTO api_usage (service, day, calls, errors) VALUES (?, ?, ?, ?)');
  insert.run('brave', '2026-01-15', 4, 1);   // deze maand
  insert.run('brave', '2026-01-02', 6, 0);   // deze maand, vandaag
  insert.run('brave', '2025-12-31', 10, 2);  // vorige maand (over de jaargrens)
  insert.run('brave', '2025-11-30', 99, 0);  // te oud
  insert.run('onbekend', '2026-01-02', 5, 5); // geen bekende dienst: telt niet mee

  const monitor = createMonitor(db);
  const usage = monitor.usage(Date.UTC(2026, 0, 2, 12));
  assert.equal(usage.today, '2026-01-02');
  assert.equal(usage.month, '2026-01');
  assert.equal(usage.previous, '2025-12');
  assert.deepEqual(usage.services.brave, {
    today: { calls: 6, errors: 0 },
    month: { calls: 10, errors: 1 },
    previousMonth: { calls: 10, errors: 2 },
  });
  assert.equal(usage.services.onbekend, undefined);
});

test('track toont wat er loopt, ook als het misgaat; setTest onthoudt de laatste test', async () => {
  const monitor = createMonitor(openDatabase(':memory:'));
  let during;
  const result = await monitor.track('web', async () => {
    during = monitor.running();
    return 42;
  });
  assert.equal(result, 42);
  assert.equal(during.length, 1);
  assert.equal(during[0].scan, 'web');
  assert.deepEqual(monitor.running(), []);

  await assert.rejects(monitor.track('deep', async () => { throw new Error('mis'); }), /mis/);
  assert.deepEqual(monitor.running(), []);

  monitor.setTest('xon', { ok: true, text: 'Gelukt.' });
  assert.equal(monitor.live().xon.test.ok, true);
  assert.equal(monitor.live().xon.test.text, 'Gelukt.');

  // live() geeft een kopie: wie die verandert, verandert de monitor niet.
  monitor.live().xon.test.text = 'Veranderd';
  assert.equal(monitor.live().xon.test.text, 'Gelukt.');
});
