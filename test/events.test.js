// Tests voor het systeemlog (src/events.js): vaste meldingen, en nooit persoonsgegevens, ook niet als
// iemand ze per ongeluk meegeeft.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, removeExpired } from '../src/db.js';
import {
  CODE_TEXT, EVENTS, EVENT_DAYS, EVENT_MAX, cleanDetail, countRecentEvents, listEvents, logEvent, pruneEvents,
} from '../src/events.js';

const DAY = 24 * 60 * 60 * 1000;
const rows = (db) => db.prepare('SELECT code, level, detail FROM system_events ORDER BY id').all().map((row) => ({ ...row }));

test('logEvent bewaart een vaste melding met alleen toegestane details', () => {
  const db = openDatabase(':memory:');
  assert.equal(logEvent(db, 'scan_done', { scan: 'web', found: 12, added: 3, ms: 1400 }), true);
  assert.deepEqual(rows(db), [{ code: 'scan_done', level: 'info', detail: '{"scan":"web","found":12,"added":3,"ms":1400}' }]);
  const [event] = listEvents(db);
  assert.equal(event.text, 'Webzoekopdracht: 12 gevonden, 3 nieuw (1,4 s).');
  assert.equal(event.levelLabel, 'Info');
});

test('persoonsgegevens in de details vallen weg, wat iemand ook meegeeft', () => {
  const db = openDatabase(':memory:');
  logEvent(db, 'scan_failed', {
    scan: 'web',
    code: 'anna@example.com',          // geen bekende foutcode: wordt "unexpected"
    email: 'anna@example.com',         // geen toegestaan detail
    query: '"Anna de Vries" Utrecht',
    url: 'https://example.org/anna',
    key: 'BSA-geheim',
    name: 'Anna de Vries',
  });
  logEvent(db, 'external_failed', { service: 'brave', failure: 'http', status: 'Anna' });
  logEvent(db, 'unexpected_error', { error: 'Fout bij anna@example.com' });
  logEvent(db, 'account_blocked', { account: 'anna@example.com' });
  logEvent(db, 'scan_done', { scan: 'web', found: -1, added: 1.5, ms: '100' });

  const stored = JSON.stringify(rows(db));
  for (const secret of ['anna', 'Anna', 'Vries', 'Utrecht', 'example', 'BSA', 'geheim']) {
    assert.ok(!stored.includes(secret), `"${secret}" staat in het log`);
  }
  const texts = listEvents(db).map((event) => event.text).join('\n');
  assert.ok(!/anna|Vries|example|BSA/i.test(texts));
  assert.match(texts, /Webzoekopdracht lukte niet: onverwacht antwoord van de bron\./);
  assert.match(texts, /Brave Search antwoordde met HTTP \?\./);
  assert.match(texts, /Onverwachte fout bij een verzoek\./);
});

test('cleanDetail laat alleen getallen en woorden uit de vaste lijsten door', () => {
  assert.deepEqual(cleanDetail({ service: 'brave', failure: 'network', status: 429, account: 7, error: 'TypeError' }),
    { service: 'brave', failure: 'network', status: 429, error: 'TypeError', account: 7 });
  assert.deepEqual(cleanDetail({ service: 'google', status: 99, error: 'Error: oeps', what: 'iets' }), {});
  assert.deepEqual(cleanDetail(null), {});
  assert.deepEqual(cleanDetail({ code: 'search_paused' }), { code: 'search_paused' });
  assert.deepEqual(cleanDetail({ code: { toString: () => 'x' } }), { code: 'unexpected' });
});

test('elke foutcode heeft een tekst, en elke melding een niveau en een tekst', () => {
  for (const [code, event] of Object.entries(EVENTS)) {
    assert.ok(['info', 'warn', 'error'].includes(event.level), code);
    assert.equal(typeof event.text({}), 'string', code);
    assert.ok(!event.text({}).includes('undefined'), `${code}: ${event.text({})}`);
  }
  for (const text of Object.values(CODE_TEXT)) assert.ok(text.length > 3);
});

test('een onbekende melding wordt overgeslagen en laat niets stukgaan', () => {
  const db = openDatabase(':memory:');
  const original = console.error;
  const lines = [];
  console.error = (line) => lines.push(line);
  try {
    assert.equal(logEvent(db, 'bestaat_niet', { found: 1 }), false);
    db.close(); // ook een database die niet meer werkt, geeft geen fout
    assert.equal(logEvent(db, 'admin_login'), false);
  } finally {
    console.error = original;
  }
  assert.equal(lines.length, 2);
  assert.match(lines[0], /onbekende melding "bestaat_niet"/);
  assert.match(lines[1], /^Systeemlog: melding niet opgeslagen \(\w+\)\.$/);
});

test('listEvents: nieuwste eerst, en met onlyProblems alleen "let op" en "fout"', () => {
  const db = openDatabase(':memory:');
  const now = Date.now();
  logEvent(db, 'server_started', { mode: 'development' }, now - 3000);
  logEvent(db, 'external_failed', { service: 'xon', failure: 'network' }, now - 2000);
  logEvent(db, 'unexpected_error', { error: 'TypeError' }, now - 1000);

  assert.deepEqual(listEvents(db).map((event) => event.code), ['unexpected_error', 'external_failed', 'server_started']);
  assert.deepEqual(listEvents(db, { onlyProblems: true }).map((event) => event.text), [
    'Onverwachte fout (TypeError) bij een verzoek. De details staan in de terminal.',
    'XposedOrNot: geen antwoord (netwerk of time-out).',
  ]);
  assert.equal(listEvents(db, { limit: 1 }).length, 1);
  assert.deepEqual(countRecentEvents(db, now), { info: 1, warn: 1, error: 1 });
  assert.deepEqual(countRecentEvents(db, now + 2 * DAY), { info: 0, warn: 0, error: 0 });
});

test(`het log blijft hooguit ${EVENT_DAYS} dagen en ${EVENT_MAX} meldingen, ook via removeExpired`, () => {
  const db = openDatabase(':memory:');
  const now = Date.now();
  logEvent(db, 'admin_login', {}, now - (EVENT_DAYS + 1) * DAY);
  logEvent(db, 'admin_login', {}, now - (EVENT_DAYS - 1) * DAY);
  removeExpired(db, now);
  assert.equal(rows(db).length, 1);

  const insert = db.prepare("INSERT INTO system_events (at, level, code) VALUES (?, 'info', 'admin_login')");
  for (let i = 0; i < EVENT_MAX + 5; i += 1) insert.run(now - i);
  pruneEvents(db, now);
  const left = db.prepare('SELECT COUNT(*) AS n, MAX(at) AS newest FROM system_events').get();
  assert.equal(left.n, EVENT_MAX);
  assert.equal(left.newest, now); // de nieuwste blijven
});

test('korte duren staan in milliseconden, langere in seconden', () => {
  assert.equal(EVENTS.scan_done.text({ scan: 'deep', found: 0, added: 0, ms: 35 }), 'Deep Scan: 0 gevonden, 0 nieuw (35 ms).');
  assert.equal(EVENTS.deep_scan_done.text({ done: 2, total: 5, ms: 2500 }), 'Deep Scan: 2 van 5 stappen voltooid (2,5 s).');
  assert.equal(EVENTS.scan_done.text({ scan: 'check', found: 3, ms: 1000 }), 'Openbare e-mailcontrole: 3 gevonden (1 s).');
});
