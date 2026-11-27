// Tests voor de beheerpagina (/beheerder): wie erop mag, wat erop staat (en wat bewust niet), en
// wat je er kunt doen: bronnen testen en pauzeren, accounts blokkeren en deblokkeren.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  accountOverview, blockAccount, braveCost, format, recentScans,
} from '../src/admin.js';
import { createBreachCheck } from '../src/breach-check.js';
import { openDatabase } from '../src/db.js';
import { listEvents } from '../src/events.js';
import { createHibp } from '../src/hibp.js';
import { createMonitor } from '../src/monitor.js';
import { createSmsSender } from '../src/sms.js';
import { NEUTRAL_QUERY } from '../src/probes.js';
import { createBraveSearch } from '../src/search.js';
import { createXon } from '../src/xon.js';
import {
  ANNA, CLUB, GIDS, fakeBraveFetch, fakeHibp, fakeSearch, fakeXonFetch, jsonResponse, login, register,
  registerConfirmed, send, sessionCookie, startServer,
} from './helpers.js';

const OWNER = {
  naam: 'Eva Eigenaar',
  email: 'eigenaar@example.com',
  wachtwoord: 'groene giraf op een step',
  wachtwoord2: 'groene giraf op een step',
};
const KEY = 'BSA-test-sleutel-0123456789';

// Een site met een beheerder (die als eerste een account maakt, dus nummer 1 is) en Anna (nummer 2).
async function site(t, options = {}) {
  const server = await startServer(t, { ownerEmail: OWNER.email, hibp: fakeHibp(), ...options });
  const owner = await registerConfirmed(server.base, server.mailer, OWNER);
  const anna = await registerConfirmed(server.base, server.mailer, ANNA);
  return { ...server, owner, anna };
}

const get = (base, path, cookie) => send(base, path, { cookie });
const post = (base, path, cookie, fields = {}) => send(base, path, { method: 'POST', cookie, fields });
const textOf = async (response) => response.text();
const codes = (db) => listEvents(db, { limit: 200 }).map((event) => event.code);

// --- Wie mag erop -----------------------------------------------------------------------------------

test('alleen de beheerder komt op /beheerder; de server controleert het bij elk verzoek', async (t) => {
  const { base, db, owner, anna } = await site(t);

  const anonymous = await get(base, '/beheerder');
  assert.equal(anonymous.status, 303);
  assert.equal(anonymous.headers.get('location'), '/inloggen');

  const normal = await get(base, '/beheerder', anna);
  assert.equal(normal.status, 404);
  assert.match(await normal.text(), /Pagina niet gevonden/); // alsof de pagina niet bestaat
  assert.equal(normal.headers.get('cache-control'), 'no-store');

  const ok = await get(base, '/beheerder', owner);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('cache-control'), 'no-store');
  assert.equal(ok.headers.get('x-robots-tag'), 'noindex, nofollow');
  assert.match(await ok.text(), /<h1>Beheer<\/h1>/);

  // Ook de formulieren: een gewone gebruiker kan niets doen, ook niet met de juiste adressen.
  for (const path of ['/beheerder/accounts/1/blokkeren', '/beheerder/bronnen/brave/pauze', '/beheerder/bronnen/hibp/test']) {
    const response = await post(base, path, anna, { actie: 'pauzeren' });
    assert.equal(response.status, 404, path);
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users WHERE blocked_at IS NOT NULL').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM settings').get().n, 0);
});

test('het adres van de beheerder telt pas als het bevestigd is', async (t) => {
  const { base, mailer } = await startServer(t, { ownerEmail: OWNER.email });
  const unconfirmed = sessionCookie(await register(base, OWNER));
  assert.ok(mailer.outbox.length > 0);
  assert.equal((await get(base, '/beheerder', unconfirmed)).status, 404);
  // Inloggen brengt je dan ook gewoon naar het dashboard.
  assert.equal((await login(base, OWNER.email, OWNER.wachtwoord)).headers.get('location'), '/dashboard');
});

test('hoofdletters in OWNER_EMAIL of bij het inloggen maken niet uit', async (t) => {
  const { base, owner } = await site(t, { ownerEmail: '  Eigenaar@Example.COM ' });
  assert.equal((await get(base, '/beheerder', owner)).status, 200);
  assert.equal((await login(base, 'EIGENAAR@example.com', OWNER.wachtwoord)).headers.get('location'), '/beheerder');
});

test('zonder OWNER_EMAIL: op je eigen computer staat er hoe je de pagina aanzet, online de gewone 404', async (t) => {
  const local = await startServer(t);
  const anna = await registerConfirmed(local.base, local.mailer, ANNA);
  const response = await get(local.base, '/beheerder', anna);
  assert.equal(response.status, 404);
  const text = await response.text();
  assert.match(text, /De beheerpagina staat uit/);
  assert.match(text, /Zet OWNER_EMAIL met jouw e-mailadres in je \.env en start de site opnieuw/);

  const online = await startServer(t, { production: true });
  const bram = await registerConfirmed(online.base, online.mailer, { ...ANNA, email: 'bram@example.com' });
  const hidden = await get(online.base, '/beheerder', bram);
  assert.equal(hidden.status, 404);
  const hiddenText = await hidden.text();
  assert.match(hiddenText, /Pagina niet gevonden/);
  assert.doesNotMatch(hiddenText, /OWNER_EMAIL/);
});

test('de beheerder komt na het inloggen op /beheerder, iedereen anders op het dashboard', async (t) => {
  const { base, db } = await site(t);
  const ownerLogin = await login(base, OWNER.email, OWNER.wachtwoord);
  assert.equal(ownerLogin.status, 303);
  assert.equal(ownerLogin.headers.get('location'), '/beheerder');
  assert.ok(sessionCookie(ownerLogin));

  const annaLogin = await login(base, ANNA.email, ANNA.wachtwoord);
  assert.equal(annaLogin.headers.get('location'), '/dashboard');
  assert.equal(codes(db).filter((code) => code === 'admin_login').length, 1);
});

test('alleen de beheerder ziet de links naar Dashboard en Beheer', async (t) => {
  const { base, owner, anna } = await site(t);
  assert.match(await textOf(await get(base, '/dashboard', owner)), /<a href="\/beheerder">Beheer<\/a>/);
  assert.doesNotMatch(await textOf(await get(base, '/dashboard', anna)), /href="\/beheerder"/);
});

test('formulieren van een andere site worden ook hier geweigerd', async (t) => {
  const { base, db, owner } = await site(t);
  const response = await send(base, '/beheerder/accounts/2/blokkeren', {
    method: 'POST', cookie: owner, origin: 'https://kwaadwillend.example', fetchSite: 'cross-site',
  });
  assert.equal(response.status, 403);
  assert.equal(db.prepare('SELECT blocked_at FROM users WHERE id = 2').get().blocked_at, null);
});

// --- Wat erop staat ---------------------------------------------------------------------------------

test('de beheerpagina toont alle onderdelen, maar geen namen, woonplaatsen, zoekopdrachten, resultaten of sleutels', async (t) => {
  const search = fakeSearch({ results: [CLUB, GIDS] });
  const { base, db, owner, anna } = await site(t, { search, hibp: fakeHibp({ breaches: [] }) });
  await post(base, '/profiel', anna, { woonplaats: 'Utrecht' });
  assert.equal((await post(base, '/scan/web', anna)).status, 303);
  assert.equal((await post(base, '/scan/deep', anna)).status, 303);
  assert.ok(db.prepare("SELECT detail FROM scans WHERE kind = 'web'").get().detail.includes('Anna')); // de zoekopdracht bestaat wel

  const text = await textOf(await get(base, '/beheerder', owner));
  for (const id of ['status', 'bronnen', 'verbruik', 'onderzoeken', 'databrokers', 'log', 'accounts', 'instellingen', 'nog-niet']) {
    assert.match(text, new RegExp(`id="${id}"`), id);
  }
  // Wel: de accounts (met e-mailadres), tellers en het log.
  assert.match(text, /anna@example\.com/);
  assert.match(text, /Webzoekopdracht: 2 gevonden, 2 nieuw/);
  assert.match(text, /Deep Scan: \d+ van 12 stappen voltooid/);
  assert.match(text, /Jij \(beheerder\)/);
  assert.match(text, /Nog niet gebouwd/);
  assert.match(text, /Er is geen AI ingesteld\. Met AI_PROVIDER=ollama in je \.env kijkt een lokaal model mee/);
  // Niet: wat er over Anna gevonden is, haar naam, woonplaats of zoekopdracht.
  for (const secret of ['Anna de Vries', 'Utrecht', CLUB.url, GIDS.url, CLUB.title, GIDS.snippet, 'clubkampioenschappen']) {
    assert.ok(!text.includes(secret), `"${secret}" staat op de beheerpagina`);
  }
});

test('de Data Broker Engine op de beheerpagina: het register en of zoeken werkte, geen treffers en geen telefoonnummers', async (t) => {
  const listing = { title: 'Anna de Vries - Telefoonboek', url: 'https://www.telefoonboek.nl/anna-de-vries', snippet: 'Anna de Vries, bel 06-12345678' };
  const search = fakeSearch({
    results: (request) => {
      if (request.query.includes('site:spokeo.com')) throw Object.assign(new Error('storing'), { code: 'unavailable' });
      return request.query.includes('site:telefoonboek.nl') || request.query.includes('0612345678') ? [listing] : [];
    },
  });
  const sms = createSmsSender();
  const { base, db, owner, anna } = await site(t, { search, sms });
  await post(base, '/profiel/telefoon', anna, { telefoon: '06 12345678' });
  await post(base, '/profiel/telefoon/bevestigen', anna, { code: sms.outbox[0].text.match(/\b(\d{6})\b/)[1] });
  assert.equal(db.prepare('SELECT phone FROM users WHERE id = 2').get().phone, '+31612345678');
  await post(base, '/scan/deep', anna);
  assert.equal(db.prepare("SELECT status FROM broker_checks WHERE broker_id = 'telefoonboek'").get().status, 'gevonden');

  const html = await textOf(await get(base, '/beheerder', owner));
  const section = html.slice(html.indexOf('id="databrokers"'), html.indexOf('id="log"'));
  assert.match(section, /15 databrokers en telefoongidsen in het register,\s+nagekeken op 26 november 2026/);
  assert.match(section, /Afgeschermd, en dus niet doorzocht: Pipl\./);
  assert.match(section, /2 zoekopdrachten per Deep Scan/);
  const row = (name) => section.slice(section.indexOf(`>${name}</a>`), section.indexOf('</tr>', section.indexOf(`>${name}</a>`)));
  // Telefoonboek.nl: één account gecontroleerd. Of daar iets gevonden is, staat er niet.
  assert.match(row('Telefoonboek.nl'), /<td class="num">1<\/td>\s*<td class="num">0<\/td>\s*<td class="num">0<\/td>/);
  // Spokeo: de zoekdienst gaf een fout, dat telt als niet toegankelijk.
  assert.match(row('Spokeo'), /<td class="num">1<\/td>\s*<td class="num">1<\/td>\s*<td class="num">0<\/td>/);
  assert.doesNotMatch(section, /Mogelijke vermelding|gevonden/i);
  assert.match(section, /Daarnaast herkent de site \d+ personenzoeksites in gewone zoekresultaten/);
  for (const secret of [listing.url, listing.title, '06 12345678', '06-12345678', '+31612345678', '0612345678', 'Anna de Vries']) {
    assert.ok(!html.includes(secret), `"${secret}" staat op de beheerpagina`);
  }
});

test('zonder zoekdienst zegt de beheerpagina dat de site zonder BRAVE_API_KEY gestart is', async (t) => {
  const { base, owner } = await site(t, { search: null });
  const text = await textOf(await get(base, '/beheerder', owner));
  assert.match(text, /<strong>Geen zoekdienst\.<\/strong> De site is op .+ gestart zonder\s+<code>BRAVE_API_KEY<\/code>/);
  assert.match(text, /hij leest <code>\.env<\/code> alleen bij het starten/);
  assert.doesNotMatch(text, /Tweestapsverificatie bestaat nog niet/); // die waarschuwing is voor een openbare site
});

test('op een openbare site waarschuwt de beheerpagina dat tweestapsverificatie nog ontbreekt', async (t) => {
  const { base, owner } = await site(t, { production: true });
  assert.match(await textOf(await get(base, '/beheerder', owner)), /Tweestapsverificatie bestaat nog niet/);
});

test('scans komen in het systeemlog met aantallen, zonder wie of wat; een onverwachte fout alleen met zijn soort', async (t) => {
  const hibp = fakeHibp({ breaches: [] });
  const { base, db, anna } = await site(t, { hibp });
  await post(base, '/scan/datalekken', anna);

  hibp.error = new TypeError('kapot bij anna@example.com');
  const original = console.error;
  console.error = () => {};
  try {
    assert.equal((await post(base, '/scan/datalekken', anna)).status, 500);
  } finally {
    console.error = original;
  }
  const texts = listEvents(db).map((event) => event.text);
  assert.ok(texts.includes('Onverwachte fout (TypeError) bij een verzoek. De details staan in de terminal.'));
  assert.ok(texts.some((text) => /^Datalekcontrole: 0 gevonden, 0 nieuw \(/.test(text)));
  assert.ok(!JSON.stringify(db.prepare('SELECT * FROM system_events').all()).includes('anna'));
});

// --- Bronnen pauzeren -------------------------------------------------------------------------------

test('pauzeren werkt echt: zoeken en de Deep Scan vragen dan niets aan de zoekdienst', async (t) => {
  const search = fakeSearch({ name: 'brave', results: [CLUB] });
  const { base, db, owner, anna } = await site(t, { search });

  const paused = await post(base, '/beheerder/bronnen/brave/pauze', owner, { actie: 'pauzeren' });
  assert.equal(paused.status, 303);
  assert.equal(paused.headers.get('location'), '/beheerder?melding=gepauzeerd#bronnen');

  const scan = await post(base, '/scan/web', anna);
  assert.equal(scan.status, 503);
  assert.match(await scan.text(), /Zoeken op het web is tijdelijk uitgezet door de beheerder/);
  await post(base, '/scan/deep', anna);
  assert.equal(search.calls.length, 0);
  const report = await textOf(await get(base, '/resultaten', anna));
  assert.match(report, /De beheerder heeft de zoekdienst tijdelijk uitgezet/);

  const page = await textOf(await get(base, '/beheerder?melding=gepauzeerd', owner));
  assert.match(page, /De bron staat op pauze/);
  assert.match(page, /Gepauzeerd/);
  assert.match(page, /Weer aanzetten/);
  assert.match(page, /Webzoekopdracht lukte niet: zoekdienst gepauzeerd door de beheerder/);

  await post(base, '/beheerder/bronnen/brave/pauze', owner, { actie: 'hervatten' });
  assert.equal((await post(base, '/scan/web', anna)).status, 303);
  assert.equal(search.calls.length, 1);
  assert.deepEqual(codes(db).filter((code) => code.startsWith('source_')), ['source_resumed', 'source_paused']);
});

test('een gepauzeerde datalekbron: de openbare controle en het dashboard vragen er niets aan', async (t) => {
  const hibp = fakeHibp({ breaches: [] });
  const { base, owner, anna } = await site(t, { hibp });
  await post(base, '/beheerder/bronnen/hibp/pauze', owner, { actie: 'pauzeren' });
  hibp.calls.length = 0;

  const check = await send(base, '/controle', { method: 'POST', fields: { email: 'iemand@example.com' } });
  assert.equal(check.status, 503);
  assert.match(await check.text(), /De controle staat tijdelijk uit/);
  const scan = await post(base, '/scan/datalekken', anna);
  assert.equal(scan.status, 503);
  assert.match(await scan.text(), /tijdelijk uitgezet door de beheerder/);
  assert.deepEqual(hibp.calls, []);
});

test('pauzeren: een onbekende bron of keuze wordt geweigerd', async (t) => {
  const { base, db, owner } = await site(t);
  assert.equal((await post(base, '/beheerder/bronnen/google/pauze', owner, { actie: 'pauzeren' })).status, 404);
  assert.equal((await post(base, '/beheerder/bronnen/pwned-passwords/pauze', owner, { actie: 'pauzeren' })).status, 404);
  assert.equal((await post(base, '/beheerder/bronnen/brave/pauze', owner, { actie: 'weg' })).status, 400);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM settings').get().n, 0);
});

// --- Bronnen testen en het verbruik -----------------------------------------------------------------

const BRAVE_OK = {
  type: 'search',
  web: {
    type: 'search',
    results: [
      { title: 'Domtoren', url: 'https://example.org/dom', description: 'De Domtoren in Utrecht.' },
      { title: 'Utrecht', url: 'https://example.net/utrecht', description: 'Wat te doen.' },
    ],
  },
};

// Een site met de echte koppelingen, die via de monitor tellen, en nep-fetches: er gaat niets naar buiten.
async function realSources(t, { testLimit = 20 } = {}) {
  const db = openDatabase(':memory:');
  const monitor = createMonitor(db);
  const brave = fakeBraveFetch(() => new Response(JSON.stringify(BRAVE_OK), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'X-RateLimit-Limit': '1, 1000',
      'X-RateLimit-Remaining': '1, 998',
      'X-RateLimit-Reset': '1, 172800',
    },
  }));
  const xon = fakeXonFetch({ email: () => jsonResponse(404, { Error: 'Not found' }) });
  const hibpCalls = [];
  const hibpFetch = async (url, init) => {
    hibpCalls.push({ url: String(url), init });
    return jsonResponse(200, [{ Name: 'Adobe', Title: 'Adobe', BreachDate: '2013-10-04', DataClasses: ['Email addresses'] }]);
  };
  const search = createBraveSearch({ apiKey: KEY, fetchImpl: monitor.fetchFor('brave', brave.impl), minIntervalMs: 0 });
  const check = createBreachCheck({
    hibp: createHibp({ fetchImpl: monitor.fetchFor('hibp', hibpFetch), minIntervalMs: 0 }),
    xon: createXon({ fetchImpl: monitor.fetchFor('xon', xon.impl), minIntervalMs: 0 }),
  });
  const server = await site(t, {
    db, monitor, search, hibp: check, testLimit,
  });
  return {
    ...server, brave, xon, hibpCalls, monitor,
  };
}

test('de testknoppen doen een neutrale proefaanvraag en tonen de uitkomst, de limieten en het verbruik', async (t) => {
  const { base, db, owner, brave, xon, hibpCalls } = await realSources(t);

  for (const id of ['brave', 'xon', 'hibp']) {
    const response = await post(base, `/beheerder/bronnen/${id}/test`, owner);
    assert.equal(response.status, 303, id);
    assert.equal(response.headers.get('location'), '/beheerder?melding=getest#bronnen');
  }
  // Alleen de neutrale zoekopdracht en de voorbeeld- en testadressen gingen de deur uit.
  assert.equal(brave.calls.length, 1);
  assert.equal(new URL(brave.calls[0].url).searchParams.get('q'), NEUTRAL_QUERY);
  assert.ok(xon.calls.every((call) => !call.url.includes('example.com') || call.url.includes('controle%40example.com')));
  assert.equal(hibpCalls.length, 1);
  assert.match(hibpCalls[0].url, /account-exists%40hibp-integration-tests\.com/);

  const text = await textOf(await get(base, '/beheerder?melding=getest', owner));
  assert.match(text, /De test is klaar/);
  assert.match(text, /De sleutel werkt: 2 resultaten gelezen bij een neutrale zoekopdracht\./);
  assert.match(text, /De lijst met bekende lekken is gelezen \(\d+ lekken\) en een controle met een voorbeeldadres is gelukt\./);
  assert.match(text, /Het testadres van Have I Been Pwned is gecontroleerd \(1 lek\)\./);
  // De limieten die Brave meegaf, en het verbruik dat de site zelf telde.
  assert.match(text, /per maand: nog <strong>998<\/strong> van 1\.000, begint opnieuw over 2 dagen/);
  assert.match(text, /Geslaagde aanvragen deze kalendermaand: <strong>1<\/strong>/);
  assert.ok(!text.includes(KEY)); // de sleutel staat nergens
  assert.deepEqual(codes(db).filter((code) => code.startsWith('source_test')).sort(), ['source_test_ok', 'source_test_ok', 'source_test_ok']);
});

test('een mislukte test zegt in gewone woorden wat er mis is', async (t) => {
  const { base, owner, brave } = await realSources(t);
  brave.answer = () => new Response('{}', { status: 401 });
  const original = console.error;
  console.error = () => {};
  try {
    await post(base, '/beheerder/bronnen/brave/test', owner);
  } finally {
    console.error = original;
  }
  const text = await textOf(await get(base, '/beheerder', owner));
  assert.match(text, /Brave weigert de sleutel \(HTTP 401 of 403\)/);
  assert.match(text, /Brave Search antwoordde met HTTP 401\./); // ook in het log
});

test('testen kan niet eindeloos, en alleen bij een bron die er is', async (t) => {
  const { base, db, owner, brave } = await realSources(t, { testLimit: 2 });
  await post(base, '/beheerder/bronnen/brave/test', owner);
  await post(base, '/beheerder/bronnen/brave/test', owner);
  const third = await post(base, '/beheerder/bronnen/brave/test', owner);
  assert.equal(third.headers.get('location'), '/beheerder?melding=te-vaak#bronnen');
  assert.equal(brave.calls.length, 2);
  assert.ok(codes(db).includes('limit_reached'));

  assert.equal((await post(base, '/beheerder/bronnen/pwned-passwords/test', owner)).status, 404);
  assert.equal((await post(base, '/beheerder/bronnen/google/test', owner)).status, 404);
});

test('zonder echte zoekdienst is er geen testknop voor Brave', async (t) => {
  const { base, owner } = await site(t, { search: null });
  assert.doesNotMatch(await textOf(await get(base, '/beheerder', owner)), /\/beheerder\/bronnen\/brave\/test/);
  assert.equal((await post(base, '/beheerder/bronnen/brave/test', owner)).status, 404);
});

// --- Accounts ---------------------------------------------------------------------------------------

test('blokkeren: inloggen kan niet meer en een open sessie stopt meteen; deblokkeren maakt het ongedaan', async (t) => {
  const { base, db, owner, anna } = await site(t);
  assert.equal((await get(base, '/dashboard', anna)).status, 200);

  const blocked = await post(base, '/beheerder/accounts/2/blokkeren', owner);
  assert.equal(blocked.headers.get('location'), '/beheerder?melding=geblokkeerd#accounts');
  assert.equal((await get(base, '/dashboard', anna)).headers.get('location'), '/inloggen');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = 2').get().n, 0);

  // Met het goede wachtwoord: de melding dat het account geblokkeerd is, en geen sessie.
  const refused = await login(base, ANNA.email, ANNA.wachtwoord);
  assert.equal(refused.status, 403);
  assert.match(await refused.text(), /Dit account is geblokkeerd door de beheerder van deze site/);
  assert.equal(sessionCookie(refused), undefined);
  // Met een fout wachtwoord: de gewone melding, die niets verraadt.
  const wrong = await login(base, ANNA.email, 'niet het goede wachtwoord');
  assert.equal(wrong.status, 401);
  assert.doesNotMatch(await wrong.text(), /geblokkeerd/);

  const page = await textOf(await get(base, '/beheerder', owner));
  assert.match(page, /Geblokkeerd/);
  assert.match(page, /\/beheerder\/accounts\/2\/deblokkeren/);

  await post(base, '/beheerder/accounts/2/deblokkeren', owner);
  assert.equal((await login(base, ANNA.email, ANNA.wachtwoord)).headers.get('location'), '/dashboard');
  assert.deepEqual(codes(db).filter((code) => /account|blocked/.test(code)), ['account_unblocked', 'blocked_login', 'account_blocked']);
  assert.match(listEvents(db).map((event) => event.text).join('\n'), /De beheerder heeft account #2 geblokkeerd\./);
});

test('een sessie die nog in de database staat, werkt niet meer voor een geblokkeerd account', async (t) => {
  const { base, db, anna } = await site(t);
  db.prepare('UPDATE users SET blocked_at = ? WHERE id = 2').run(Date.now()); // de sessies blijven hier staan
  assert.ok(db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = 2').get().n > 0);
  assert.equal((await get(base, '/dashboard', anna)).headers.get('location'), '/inloggen');
});

test('je kunt je eigen account niet blokkeren, en een onbekend account bestaat niet', async (t) => {
  const { base, db, owner } = await site(t);
  const self = await post(base, '/beheerder/accounts/1/blokkeren', owner);
  assert.equal(self.status, 400);
  assert.match(await self.text(), /Je kunt je eigen beheerdersaccount niet blokkeren/);
  assert.equal((await post(base, '/beheerder/accounts/999/blokkeren', owner)).status, 404);
  assert.equal((await post(base, '/beheerder/accounts/abc/blokkeren', owner)).status, 404);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users WHERE blocked_at IS NOT NULL').get().n, 0);
  assert.equal((await get(base, '/beheerder', owner)).status, 200); // nog steeds binnen
});

// --- Losse functies ---------------------------------------------------------------------------------

test('accountOverview en recentScans: aantallen en datums, nooit de zoekopdracht', () => {
  const db = openDatabase(':memory:');
  const now = Date.now();
  const add = db.prepare('INSERT INTO users (name, email, password_hash, created_at, email_confirmed_at) VALUES (?, ?, ?, ?, ?)');
  add.run('Anna de Vries', 'anna@example.com', 'x', now - 30 * 86400000, now);
  add.run('Bram', 'bram@example.com', 'x', now - 1000, null);
  db.prepare("INSERT INTO scans (user_id, kind, ran_at, found_count, new_count, detail) VALUES (1, 'web', ?, 3, 1, '\"Anna de Vries\" Utrecht')").run(now);
  blockAccount(db, 2, now);

  const overview = accountOverview(db, { now });
  assert.deepEqual(overview.counts, { total: 2, confirmed: 1, unconfirmed: 1, blocked: 1, recent: 1 });
  assert.deepEqual(overview.accounts.map((account) => account.id), [2, 1]);
  assert.equal(overview.accounts[1].last_scan_at, now);
  assert.ok(!JSON.stringify(overview).includes('Anna de Vries')); // geen namen

  const scans = recentScans(db);
  assert.deepEqual(scans, [{ user_id: 1, kind: 'web', ran_at: now, found_count: 3, new_count: 1 }]);
});

test('braveCost en de opmaak', () => {
  assert.deepEqual(braveCost(0), { usd: 0, afterCreditUsd: 0 });
  assert.deepEqual(braveCost(1000), { usd: 5, afterCreditUsd: 0 });
  assert.deepEqual(braveCost(3000), { usd: 15, afterCreditUsd: 10 });
  assert.equal(format.usd(10), '$10,00');
  assert.equal(format.duration(30 * 1000), 'minder dan een minuut');
  assert.equal(format.duration(61 * 60 * 1000), '1 uur');
  assert.equal(format.duration((2 * 24 + 3) * 60 * 60 * 1000), '2 dagen en 3 uur');
  assert.equal(format.ms(850), '850 ms');
  assert.equal(format.ms(1500), '1,5 s');
  assert.equal(format.bytes(2 * 1024 * 1024), '2 MB');
});

test('de privacyverklaring zegt wat de beheerder ziet', async (t) => {
  const { base } = await startServer(t);
  const text = await textOf(await get(base, '/privacy'));
  assert.match(text, /<h2>Wat de beheerder ziet<\/h2>/);
  assert.match(text, /Je naam, je woonplaats, je telefoonnummer, je zoekopdrachten\s+en wat er over jou gevonden is, staan er niet op/);
  assert.match(text, /Over de databrokers staan er alleen totalen: bij hoeveel\s+accounts er gekeken is en of dat lukte, niet bij wie er iets gevonden is/);
  assert.match(text, /Het technische logboek van de site: maximaal 30 dagen/);
});

test('de opmaak telt enkelvoud en meervoud', () => {
  assert.equal(format.count(1, 'open sessie', 'open sessies'), '1 open sessie');
  assert.equal(format.count(0, 'open sessie', 'open sessies'), '0 open sessies');
  assert.equal(format.count(1200, 'melding', 'meldingen'), '1.200 meldingen');
});
