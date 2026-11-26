// Tests voor zoeken op het web naar je eigen naam en het beoordelen van de resultaten.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ADOBE, ANNA, CLUB, GIDS, NAAMGENOOT, alertText, fakeHibp, fakeSearch, register, registerConfirmed,
  send, sessionCookie, startServer,
} from './helpers.js';

const BRAM = { ...ANNA, naam: 'Bram Bakker', email: 'bram@example.com' };
const THREE = [CLUB, GIDS, NAAMGENOOT];

function scan(base, cookie, extra = {}) {
  return send(base, '/scan/web', { method: 'POST', cookie, ...extra });
}

function choose(base, cookie, id, status, extra = {}) {
  return send(base, `/resultaten/${id}`, { method: 'POST', cookie, fields: { status }, ...extra });
}

function page(base, cookie, path = '/resultaten') {
  return send(base, path, { cookie }).then((response) => response.text());
}

function count(db, table) {
  return db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
}

// [adres, status] van alle webresultaten, op volgorde van aanmaken.
function statuses(db, userId) {
  const sql = `SELECT source_key, status FROM findings WHERE kind = 'web'${userId ? ' AND user_id = ?' : ''} ORDER BY id`;
  const rows = userId ? db.prepare(sql).all(userId) : db.prepare(sql).all();
  return rows.map((row) => [row.source_key, row.status]);
}

function idOf(db, url, userId = 1) {
  return db.prepare("SELECT id FROM findings WHERE kind = 'web' AND source_key = ? AND user_id = ?").get(url, userId).id;
}

// Het formulier met de drie keuzeknoppen van één resultaat.
function formFor(html, id) {
  return html.match(new RegExp(`<form method="post" action="/resultaten/${id}"[\\s\\S]*?</form>`))?.[0];
}

// De knop met deze waarde binnen een formulier.
function button(form, value) {
  return form.match(new RegExp(`<button[^>]*value="${value}"[^>]*>[^<]*</button>`))?.[0];
}

async function setup(t, { results = THREE, ...options } = {}) {
  const search = options.search ?? fakeSearch({ results, isDemo: options.isDemo });
  const hibp = options.hibp ?? fakeHibp();
  const server = await startServer(t, { hibp, ...options, search });
  const cookie = await registerConfirmed(server.base, server.mailer);
  return { ...server, search, hibp, cookie };
}

// --- Toegang -----------------------------------------------------------------

test('zonder inloggen kun je niet zoeken en niets beoordelen', async (t) => {
  const search = fakeSearch({ results: THREE });
  const { base } = await startServer(t, { search });

  for (const path of ['/scan/web', '/resultaten/1']) {
    const response = await send(base, path, { method: 'POST', fields: { status: 'mine' } });
    assert.equal(response.status, 303, path);
    assert.equal(response.headers.get('location'), '/inloggen');
  }
  assert.deepEqual(search.calls, []);
});

test('zoeken op het web kan pas als je e-mailadres bevestigd is', async (t) => {
  const search = fakeSearch({ results: THREE });
  const { base } = await startServer(t, { search });
  const cookie = sessionCookie(await register(base));

  const response = await scan(base, cookie);
  assert.equal(response.status, 403);
  assert.match(await response.text(), /Bevestig eerst je e-mailadres/);
  assert.deepEqual(search.calls, []); // er is niets naar de zoekdienst gestuurd

  const dashboard = await page(base, cookie, '/dashboard');
  assert.doesNotMatch(dashboard, /action="\/scan\/web"/);
  assert.match(dashboard, /Bevestig eerst je e-mailadres\. Daarna kun je hier zoeken/);
});

test('zoeken en beoordelen vanaf een andere website wordt geweigerd (CSRF)', async (t) => {
  const { db, base, search, cookie } = await setup(t);
  const cross = { fetchSite: 'cross-site', origin: 'https://andere-site.example' };

  assert.equal((await scan(base, cookie, cross)).status, 403);
  assert.deepEqual(search.calls, []);

  await scan(base, cookie);
  assert.equal((await choose(base, cookie, 1, 'mine', cross)).status, 403);
  assert.deepEqual(statuses(db).map(([, status]) => status), ['new', 'new', 'new']);
});

// --- De zoekopdracht ----------------------------------------------------------

test('de zoekopdracht komt uit je account; wat je zelf meestuurt wordt genegeerd', async (t) => {
  const { base, search, cookie } = await setup(t);

  const fields = {
    q: 'iemand anders', query: 'iemand anders', naam: 'Jan Jansen', name: 'Jan Jansen', woonplaats: 'Rotterdam', city: 'Rotterdam',
  };
  assert.equal((await scan(base, cookie, { fields })).status, 303);
  assert.deepEqual(search.calls, [{ query: '"Anna de Vries"', name: 'Anna de Vries', city: '' }]);
  assert.equal((await scan(base, cookie, { fields: { ...fields, woonplaats: 'Rotterdam' } })).status, 303);

  // Je woonplaats wijzig je alleen via je profiel.
  await send(base, '/profiel', { method: 'POST', cookie, fields: { woonplaats: 'Utrecht' } });
  search.calls.length = 0;
  await scan(base, cookie, { fields });
  assert.deepEqual(search.calls, [{ query: '"Anna de Vries" "Utrecht"', name: 'Anna de Vries', city: 'Utrecht' }]);
});

test('via je woonplaats of naam kun je de zoekopdracht niet verbreden naar iemand anders', async (t) => {
  const { db, base, search, cookie } = await setup(t, { scanLimit: 100 });

  for (const woonplaats of ['OR Jan Jansen', 'Ut OR Jan Jansen', "Jan 't Hoen"]) {
    await send(base, '/profiel', { method: 'POST', cookie, fields: { woonplaats } });
    await scan(base, cookie);
  }
  db.prepare('UPDATE users SET name = ?, city = NULL').run('Anna" OR "Jan Jansen');
  await scan(base, cookie);

  assert.equal(search.calls.length, 4);
  for (const { query } of search.calls) {
    assert.match(query, /^"[^"]+"( "[^"]+")?$/, query);
  }
  assert.equal(search.calls[0].query, '"Anna de Vries" "OR Jan Jansen"');
  assert.equal(search.calls[3].query, '"Anna OR Jan Jansen"');
});

test('een te korte naam geeft een melding en er wordt niets verstuurd', async (t) => {
  const { db, base, search, cookie } = await setup(t);
  db.prepare("UPDATE users SET name = '1'").run();

  const response = await scan(base, cookie);
  assert.equal(response.status, 400);
  assert.match(alertText(await response.text()), /te weinig letters/);
  assert.deepEqual(search.calls, []);
  assert.equal(count(db, 'findings'), 0);
});

// --- Resultaten bewaren en tonen -----------------------------------------------

test('een scan bewaart de resultaten als "nog te beoordelen" en toont ze met uitleg', async (t) => {
  const { db, base, cookie } = await setup(t);

  const response = await scan(base, cookie);
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), '/resultaten?gescand=web#web');
  assert.deepEqual(statuses(db), THREE.map(({ url }) => [url, 'new']));

  const html = await page(base, cookie, '/resultaten?gescand=web');
  assert.match(html, /Gezocht: 3 mogelijke vermeldingen gevonden, waarvan 3 nieuw\. Beoordeel ze hieronder: het zegt niet dat ze over jou gaan\./);
  assert.match(html, /<span class="badge">3 mogelijke vermeldingen<\/span>/);
  // Het zijn mogelijke vermeldingen, geen vondsten: pas jouw "Dit ben ik" maakt er iets van jou van.
  assert.match(html, /Dit zijn <strong>mogelijke<\/strong> vermeldingen van jou, geen bewijs dat ze over jou gaan\./);
  assert.match(html, /pas bij "Dit ben ik"\s+beschouwen we een resultaat als van jou/);
  assert.match(html, /Laatst gezocht op [^<]+ naar <code>&#34;Anna de Vries&#34;<\/code>/);
  assert.match(html, /Nog te beoordelen: 3\./);

  // Op de volgorde van de zoekdienst, met een link die veilig opent en de volledige url erbij.
  assert.ok(html.indexOf(CLUB.title) < html.indexOf(GIDS.title));
  assert.ok(html.indexOf(GIDS.title) < html.indexOf(NAAMGENOOT.title));
  assert.match(html, new RegExp(`<a href="${CLUB.url}" target="_blank" rel="noopener noreferrer nofollow">${CLUB.title}</a>`));
  assert.match(html, new RegExp(`<p class="finding-link">${CLUB.url}</p>`));
  assert.match(html, /Anna de Vries werd tweede bij de clubkampioenschappen\./);

  // Bij elk resultaat dezelfde drie keuzes, en nog geen enkele is gekozen.
  for (let id = 1; id <= 3; id += 1) {
    const form = formFor(html, id);
    assert.ok(form, `formulier voor ${id}`);
    assert.match(button(form, 'mine'), />Dit ben ik</);
    assert.match(button(form, 'not_mine'), />Dit ben ik niet</);
    assert.match(button(form, 'unknown'), />Weet ik niet</);
    assert.doesNotMatch(form, /is-active|aria-pressed="true"/);
  }
});

test('de resultatenpagina zonder webscan nodigt uit om te zoeken', async (t) => {
  const { base, search, cookie } = await setup(t);

  const html = await page(base, cookie);
  assert.match(html, /Je hebt nog niet gezocht\. Dat doe je op je <a href="\/dashboard">dashboard<\/a>/);
  assert.doesNotMatch(html, /class="choices"/);
  assert.deepEqual(search.calls, []);

  // Een melding komt alleen als er ook echt gezocht is, en nooit uit de adresbalk zelf.
  assert.doesNotMatch(await page(base, cookie, '/resultaten?gescand=web'), /Gezocht:/);
  assert.doesNotMatch(await page(base, cookie, '/resultaten?gescand=<script>alert(1)</script>'), /<script>alert/);
});

test('een zoekdienst die niets vindt geeft een eerlijke melding', async (t) => {
  const { base, cookie } = await setup(t, { results: [] });

  assert.equal((await scan(base, cookie)).status, 303);
  const html = await page(base, cookie, '/resultaten?gescand=web');
  assert.match(html, /De zoekdienst vond niets bij deze zoekopdracht\./);
  assert.doesNotMatch(html, /mogelijke vermelding(en)?<\/span>/); // geen telling van niets
  assert.doesNotMatch(html, /class="choices"/);

  const dashboard = await page(base, cookie, '/dashboard');
  assert.match(dashboard, /Laatst gezocht op/);
  assert.doesNotMatch(dashboard, /te beoordelen/);
});

test('opnieuw zoeken houdt je keuzes en meldt alleen wat nieuw is', async (t) => {
  const search = fakeSearch({ results: [CLUB, GIDS] });
  const { db, base, cookie } = await setup(t, { search });
  await scan(base, cookie);
  await choose(base, cookie, idOf(db, CLUB.url), 'mine');

  search.results = [{ ...CLUB, title: 'Nieuwe titel van de club' }, GIDS, NAAMGENOOT];
  await scan(base, cookie);

  assert.deepEqual(statuses(db), [[CLUB.url, 'mine'], [GIDS.url, 'new'], [NAAMGENOOT.url, 'new']]);
  assert.equal(count(db, 'findings'), 3);
  const html = await page(base, cookie, '/resultaten?gescand=web');
  assert.match(html, /Gezocht: 3 mogelijke vermeldingen gevonden, waarvan 1 nieuw\./);
  assert.match(html, /Nieuwe titel van de club/);
  assert.match(formFor(html, idOf(db, CLUB.url)), /is-active/);
});

test('resultaten van de zoekdienst worden opgeschoond en veilig getoond', async (t) => {
  const results = [
    { title: '<img src=x onerror=alert(1)>', url: 'https://example.org/een', snippet: '<script>alert(2)</script>' },
    { title: '&lt;script&gt;alert(3)&lt;/script&gt;', url: 'https://example.org/twee', snippet: 'a < b en <b>vet</b>' },
    { title: 'Gevaarlijk adres', url: 'javascript:alert(4)', snippet: 'x' },
    { title: 'Met wachtwoord', url: 'https://gebruiker:geheim@example.org/drie', snippet: 'x' },
    { title: 'Een bestandsoverdracht', url: 'ftp://example.org/vier', snippet: 'x' },
    { title: 'Dubbel', url: 'https://example.org/een', snippet: 'x' },
    { title: 'Aanhalingstekens', url: 'https://example.org/"><script>alert(5)</script>', snippet: 'x' },
  ];
  const { db, base, cookie } = await setup(t, { results });

  await scan(base, cookie);
  const urls = statuses(db).map(([url]) => url);
  assert.equal(urls.length, 3);
  assert.ok(urls.every((url) => url.startsWith('https://example.org/')));
  assert.ok(!urls.some((url) => url.includes('geheim') || url.includes('javascript')));

  const html = await page(base, cookie, '/resultaten?gescand=web');
  for (const gevaar of ['<img src=x', '<script>alert', 'javascript:alert', 'geheim', 'ftp://', 'onerror=alert']) {
    assert.ok(!html.includes(gevaar), `de pagina bevat ${gevaar}`);
  }
  assert.ok(html.includes('&lt;script&gt;alert(3)&lt;/script&gt;'), 'tekst die op een tag lijkt, wordt als tekst getoond');
});

// --- Je keuze per resultaat -----------------------------------------------------

test('je keuze per resultaat wordt bewaard en zichtbaar gemaakt', async (t) => {
  const { db, base, cookie } = await setup(t);
  await scan(base, cookie);

  const response = await choose(base, cookie, 1, 'mine');
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), '/resultaten#resultaat-1');
  await choose(base, cookie, 2, 'not_mine');
  await choose(base, cookie, 3, 'unknown');
  assert.deepEqual(statuses(db), [[CLUB.url, 'mine'], [GIDS.url, 'not_mine'], [NAAMGENOOT.url, 'unknown']]);

  const html = await page(base, cookie);
  for (const [id, chosen] of [[1, 'mine'], [2, 'not_mine'], [3, 'unknown']]) {
    const form = formFor(html, id);
    for (const value of ['mine', 'not_mine', 'unknown']) {
      const active = value === chosen;
      assert.equal(/is-active/.test(button(form, value)), active, `${id}: ${value}`);
      assert.match(button(form, value), new RegExp(`aria-pressed="${active}"`), `${id}: ${value}`);
    }
  }
  assert.match(html, /1 resultaat door jou bevestigd als "Dit ben ik"\./);
  assert.doesNotMatch(html, /Nog te beoordelen/);
});

test('je mag van gedachten veranderen', async (t) => {
  const { db, base, cookie } = await setup(t);
  await scan(base, cookie);

  await choose(base, cookie, 1, 'mine');
  assert.match(await page(base, cookie), /1 resultaat door jou bevestigd als "Dit ben ik"\./);
  await choose(base, cookie, 1, 'not_mine');
  assert.equal(statuses(db)[0][1], 'not_mine');
  const html = await page(base, cookie);
  assert.match(html, /0 resultaten door jou bevestigd als "Dit ben ik"\./);
  assert.match(html, /Nog te beoordelen: 2\./);
});

test('een ongeldige keuze verandert niets', async (t) => {
  const { db, base, cookie } = await setup(t);
  await scan(base, cookie);

  for (const status of ['', 'new', 'verwijderen', 'MINE', ' mine', 'mine ', 'constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    const response = await choose(base, cookie, 1, status);
    assert.equal(response.status, 400, JSON.stringify(status));
    assert.match(await response.text(), /Onbekende keuze/);
  }
  const zonder = await send(base, '/resultaten/1', { method: 'POST', cookie, fields: { iets: 'anders' } });
  assert.equal(zonder.status, 400);
  assert.deepEqual(statuses(db).map(([, status]) => status), ['new', 'new', 'new']);
});

test('een resultaat dat niet bestaat geeft een nette 404 en verandert niets', async (t) => {
  const { db, base, cookie } = await setup(t);
  await scan(base, cookie);

  for (const id of ['0', '4', '999', 'abc', '-1', '1.5', '1e3', '%20', '01x', '1'.repeat(30)]) {
    const response = await choose(base, cookie, id, 'mine');
    assert.equal(response.status, 404, id);
    assert.match(await response.text(), /Resultaat niet gevonden/);
  }
  assert.deepEqual(statuses(db).map(([, status]) => status), ['new', 'new', 'new']);
});

// --- Alleen van jezelf -----------------------------------------------------------

test('webresultaten zijn alleen van jezelf', async (t) => {
  const search = fakeSearch({ results: ({ name }) => (name === 'Anna de Vries' ? [CLUB] : [GIDS]) });
  const { base, mailer } = await startServer(t, { hibp: fakeHibp(), search });
  const anna = await registerConfirmed(base, mailer);
  const bram = await registerConfirmed(base, mailer, BRAM);

  await scan(base, anna);
  await scan(base, bram);
  assert.deepEqual(search.calls.map((call) => call.query), ['"Anna de Vries"', '"Bram Bakker"']);

  const annaPage = await page(base, anna);
  const bramPage = await page(base, bram);
  assert.match(annaPage, new RegExp(CLUB.title));
  assert.doesNotMatch(annaPage, new RegExp(GIDS.title));
  assert.match(bramPage, new RegExp(GIDS.title));
  assert.doesNotMatch(bramPage, new RegExp(CLUB.title));
});

test('je kunt het resultaat van een ander niet beoordelen, en een datalek ook niet', async (t) => {
  const search = fakeSearch({ results: ({ name }) => (name === 'Anna de Vries' ? [CLUB] : [GIDS]) });
  const hibp = fakeHibp({ breaches: [ADOBE] });
  const { db, base, mailer } = await startServer(t, { hibp, search });
  const anna = await registerConfirmed(base, mailer);
  const bram = await registerConfirmed(base, mailer, BRAM);
  await scan(base, anna);
  await scan(base, bram);
  await send(base, '/scan/datalekken', { method: 'POST', cookie: anna });

  const annaClub = idOf(db, CLUB.url, 1);
  const breach = db.prepare("SELECT id, status FROM findings WHERE kind = 'breach'").get();
  assert.equal(breach.status, 'mine');

  // Bram probeert het resultaat van Anna, en Anna probeert haar eigen datalek.
  assert.equal((await choose(base, bram, annaClub, 'not_mine')).status, 404);
  assert.equal((await choose(base, anna, breach.id, 'not_mine')).status, 404);
  assert.deepEqual(statuses(db, 1), [[CLUB.url, 'new']]);
  assert.equal(db.prepare('SELECT status FROM findings WHERE id = ?').get(breach.id).status, 'mine');

  // Hun eigen resultaten kunnen ze wel beoordelen.
  assert.equal((await choose(base, anna, annaClub, 'mine')).status, 303);
  assert.equal((await choose(base, bram, idOf(db, GIDS.url, 2), 'not_mine')).status, 303);
  assert.deepEqual(statuses(db, 1), [[CLUB.url, 'mine']]);
  assert.deepEqual(statuses(db, 2), [[GIDS.url, 'not_mine']]);
});

test('account verwijderen wist ook de webresultaten en scans, en alleen die van jou', async (t) => {
  const search = fakeSearch({ results: THREE });
  const { db, base, mailer } = await startServer(t, { hibp: fakeHibp(), search });
  const anna = await registerConfirmed(base, mailer);
  const bram = await registerConfirmed(base, mailer, BRAM);
  await scan(base, anna);
  await scan(base, bram);
  assert.equal(count(db, 'findings'), 6);
  assert.equal(count(db, 'scans'), 2);

  const response = await send(base, '/account/verwijderen', {
    method: 'POST', cookie: anna, fields: { wachtwoord: ANNA.wachtwoord },
  });
  assert.equal(response.status, 303);

  assert.equal(count(db, 'findings'), 3);
  assert.equal(count(db, 'scans'), 1);
  assert.deepEqual(db.prepare('SELECT DISTINCT user_id FROM findings').all().map((row) => row.user_id), [2]);
  assert.match(await page(base, bram), new RegExp(CLUB.title));
});

// --- Storingen en grenzen --------------------------------------------------------

test('een storing bij de zoekdienst geeft een nette melding zonder details', async (t) => {
  const search = fakeSearch({ error: new Error('401 Unauthorized voor https://zoek.example/?key=geheim123') });
  const { db, base, cookie } = await setup(t, { search });

  const response = await scan(base, cookie);
  assert.equal(response.status, 502);
  const html = await response.text();
  assert.match(alertText(html), /De zoekdienst gaf een fout/);
  assert.ok(!html.includes('geheim123') && !html.includes('Unauthorized'));
  assert.equal(search.calls.length, 1);
  assert.equal(count(db, 'findings'), 0);
  assert.equal(count(db, 'scans'), 0); // een mislukte poging telt niet als "gezocht"
});

test('een onverwachte fout bij het opslaan geeft de algemene foutpagina, zonder details', async (t) => {
  t.mock.method(console, 'error', () => {});
  const { db, base, cookie } = await setup(t);
  db.exec('DROP TABLE scans'); // zo gaat er na het zoeken iets onverwachts mis

  const response = await scan(base, cookie);
  assert.equal(response.status, 500);
  const html = await response.text();
  assert.match(html, /Er ging iets mis/);
  assert.ok(!html.includes('no such table'));
});

test('een zoekdienst die rommel teruggeeft, geeft een lege lijst en geen fout', async (t) => {
  for (const results of [null, 'tekst', 42, { length: 2 }]) {
    const { db, base, cookie } = await setup(t, { results, scanLimit: 100 });
    assert.equal((await scan(base, cookie)).status, 303);
    assert.equal(count(db, 'findings'), 0);
  }
});

test('op een openbare site (production) staat zoeken op naam uit', async (t) => {
  const search = fakeSearch({ results: THREE });
  const { db, base, mailer } = await startServer(t, { hibp: fakeHibp(), search, production: true });
  const cookie = await registerConfirmed(base, mailer);

  const response = await scan(base, cookie);
  assert.equal(response.status, 403);
  assert.match(alertText(await response.text()), /Zoeken op naam staat uit op een openbare site/);
  assert.deepEqual(search.calls, []);
  assert.equal(count(db, 'findings'), 0);

  const dashboard = await page(base, cookie, '/dashboard');
  assert.doesNotMatch(dashboard, /action="\/scan\/web"/);
  assert.match(dashboard, /Zoeken op je naam staat uit op een openbare site/);
});

test('zoeken op het web heeft een eigen limiet, los van de datalekken', async (t) => {
  const { base, search, hibp, cookie } = await setup(t, { scanLimit: 2, hibp: fakeHibp({ breaches: [ADOBE] }) });

  assert.equal((await scan(base, cookie)).status, 303);
  assert.equal((await scan(base, cookie)).status, 303);
  const blocked = await scan(base, cookie);
  assert.equal(blocked.status, 429);
  assert.match(alertText(await blocked.text()), /al een paar keer gezocht/);
  assert.equal(search.calls.length, 2);

  // De datalekken hebben hun eigen teller.
  const breach = await send(base, '/scan/datalekken', { method: 'POST', cookie });
  assert.equal(breach.status, 303);
  assert.equal(hibp.calls.length, 1);
});

test('de limiet geldt per account, niet voor iedereen samen', async (t) => {
  const search = fakeSearch({ results: THREE });
  const { base, mailer } = await startServer(t, { hibp: fakeHibp(), search, scanLimit: 1 });
  const anna = await registerConfirmed(base, mailer);
  const bram = await registerConfirmed(base, mailer, BRAM);

  assert.equal((await scan(base, anna)).status, 303);
  assert.equal((await scan(base, anna)).status, 429);
  assert.equal((await scan(base, bram)).status, 303);
});

// --- Het dashboard -----------------------------------------------------------------

test('de kaart "Waar sta je online?" volgt je voortgang', async (t) => {
  const { base, cookie } = await setup(t, { isDemo: true });

  let html = await page(base, cookie, '/dashboard');
  assert.match(html, /We zoeken op jouw naam, <strong>Anna de Vries<\/strong>\./);
  assert.match(html, /<a href="\/profiel">Woonplaats toevoegen<\/a>/);
  assert.match(html, /Voorbeeldstand: dit is de demo\. Je krijgt nepdata en er gaat niets naar buiten\./);
  assert.match(html, /action="\/scan\/web"/);
  assert.doesNotMatch(html, /Laatst gezocht/);

  await send(base, '/profiel', { method: 'POST', cookie, fields: { woonplaats: 'Utrecht' } });
  html = await page(base, cookie, '/dashboard');
  assert.match(html, /<strong>Anna de Vries<\/strong> en <strong>Utrecht<\/strong>/);
  assert.match(html, /Woonplaats wijzigen/);

  await scan(base, cookie);
  html = await page(base, cookie, '/dashboard');
  assert.match(html, /<span class="badge badge-warn">3 te beoordelen<\/span>/);
  assert.match(html, /Laatst gezocht op/);
  assert.match(html, /href="\/resultaten#web"/);

  for (const id of [1, 2, 3]) await choose(base, cookie, id, 'not_mine');
  html = await page(base, cookie, '/dashboard');
  assert.match(html, /<span class="badge badge-ok">Beoordeeld<\/span>/);
  assert.doesNotMatch(html, /te beoordelen/);
});

test('een echte zoekdienst is eerlijk over wat er verstuurd wordt, en toont geen demo-label', async (t) => {
  const { base, cookie } = await setup(t, { isDemo: false });

  const dashboard = await page(base, cookie, '/dashboard');
  assert.match(dashboard, /Daarvoor sturen we je naam als zoekopdracht naar\s+nep\./);
  assert.match(dashboard, /Wat we vinden zijn mogelijke vermeldingen: jij beoordeelt of ze van jou zijn\./);
  assert.doesNotMatch(dashboard, /Voorbeeldstand/);

  await scan(base, cookie);
  const html = await page(base, cookie, '/resultaten?gescand=web');
  assert.doesNotMatch(html, /Voorbeeldresultaten/);
});

test('bij een demo-zoekdienst staat er duidelijk dat het nepdata is', async (t) => {
  const { base, cookie } = await setup(t, { isDemo: true });
  await scan(base, cookie);

  const html = await page(base, cookie, '/resultaten?gescand=web');
  assert.match(html, /<strong>Voorbeeldresultaten\.<\/strong> Dit is de demo: nepdata om te laten zien hoe het werkt/);
  assert.match(html, /Er is niets naar buiten gestuurd/);
});
