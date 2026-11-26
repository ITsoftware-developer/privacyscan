// Tests voor zoeken in datalekken, je zoekgegevens en de resultatenpagina.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ScanError } from '../src/scan-error.js';
import {
  ADOBE, ANNA, GAWKER, alertText, fakeHibp, register, registerConfirmed, send, sessionCookie, startServer,
} from './helpers.js';

const BRAM = { ...ANNA, naam: 'Bram Bakker', email: 'bram@example.com' };

function scan(base, cookie, extra = {}) {
  return send(base, '/scan/datalekken', { method: 'POST', cookie, ...extra });
}

function count(db, table) {
  return db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
}

test('zonder inloggen kun je niet zoeken en geen resultaten zien', async (t) => {
  const hibp = fakeHibp({ breaches: [ADOBE] });
  const { base } = await startServer(t, { hibp });

  for (const [path, method] of [
    ['/scan/datalekken', 'POST'], ['/resultaten', 'GET'], ['/profiel', 'GET'], ['/profiel', 'POST'],
  ]) {
    const response = await send(base, path, { method });
    assert.equal(response.status, 303, `${method} ${path}`);
    assert.equal(response.headers.get('location'), '/inloggen');
  }
  assert.deepEqual(hibp.calls, []);
});

test('zoeken kan pas als je e-mailadres bevestigd is', async (t) => {
  const hibp = fakeHibp({ breaches: [ADOBE] });
  const { base } = await startServer(t, { hibp });
  const cookie = sessionCookie(await register(base));

  const response = await scan(base, cookie);
  assert.equal(response.status, 403);
  assert.match(await response.text(), /Bevestig eerst je e-mailadres/);
  assert.deepEqual(hibp.calls, []); // er is niets naar HIBP gestuurd

  const dashboard = await (await send(base, '/dashboard', { cookie })).text();
  assert.doesNotMatch(dashboard, /Zoek in datalekken/);
  assert.match(dashboard, /Bevestig eerst je e-mailadres/);
});

test('een scan zoekt alleen het adres van je eigen account, ook als je zelf een ander meestuurt', async (t) => {
  const hibp = fakeHibp({ breaches: [] });
  const { base, mailer } = await startServer(t, { hibp });
  const cookie = await registerConfirmed(base, mailer);

  await scan(base, cookie, { fields: { email: 'ander@example.com', adres: 'ander@example.com', q: 'iemand anders' } });
  assert.deepEqual(hibp.calls, [ANNA.email]);
});

test('een scan bewaart de datalekken en toont ze, met bronvermelding', async (t) => {
  const hibp = fakeHibp({ breaches: [GAWKER, ADOBE] });
  const { db, base, mailer } = await startServer(t, { hibp });
  const cookie = await registerConfirmed(base, mailer);

  const response = await scan(base, cookie);
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), '/resultaten?gescand=datalekken');

  // Een bevestigd adres is van jou, dus deze datalekken zijn meteen "mine".
  const rows = db.prepare('SELECT source_key, status, kind FROM findings ORDER BY source_key').all();
  assert.deepEqual(rows.map((r) => [r.source_key, r.status, r.kind]), [
    ['Adobe', 'mine', 'breach'], ['Gawker', 'mine', 'breach'],
  ]);

  const page = await send(base, '/resultaten?gescand=datalekken', { cookie });
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Gecontroleerd: 2 datalekken gevonden, waarvan 2 nieuw\./);
  assert.match(html, /Gelekt op 4 oktober 2013/);
  assert.match(html, /152\.445\.165 accounts/);
  assert.match(html, /<li>Wachtwoorden<\/li>/); // de soorten gegevens staan in het Nederlands
  assert.ok(html.indexOf('Adobe') < html.indexOf('Gawker'), 'het nieuwste lek staat bovenaan');
  assert.match(html, /href="https:\/\/haveibeenpwned\.com\/PwnedWebsites#Adobe"[^>]*rel="noopener noreferrer"/);
  // HIBP vraagt om een zichtbare vermelding met een link (licentie CC BY 4.0).
  assert.match(html, /Bron: <a href="https:\/\/haveibeenpwned\.com"[^>]*>Have I Been Pwned<\/a>/);
  assert.match(html, /CC BY 4\.0/);
});

test('opnieuw zoeken zet niets dubbel en meldt alleen wat nieuw is', async (t) => {
  const hibp = fakeHibp({ breaches: [ADOBE, GAWKER] });
  const { db, base, mailer } = await startServer(t, { hibp });
  const cookie = await registerConfirmed(base, mailer);

  await scan(base, cookie);
  hibp.breaches = [ADOBE, GAWKER, { ...ADOBE, name: 'Dropbox', title: 'Dropbox', breachDate: '2012-07-01' }];
  await scan(base, cookie);

  assert.equal(count(db, 'findings'), 3);
  const html = await (await send(base, '/resultaten?gescand=datalekken', { cookie })).text();
  assert.match(html, /Gecontroleerd: 3 datalekken gevonden, waarvan 1 nieuw\./);

  await scan(base, cookie);
  const third = await (await send(base, '/resultaten?gescand=datalekken', { cookie })).text();
  assert.match(third, /Gecontroleerd: 3 datalekken gevonden\./); // niets nieuws, dus geen "waarvan"
  assert.equal(count(db, 'scans'), 1); // per soort wordt alleen de laatste scan bewaard
});

test('geen datalekken: een geruststellende maar eerlijke melding', async (t) => {
  const hibp = fakeHibp({ breaches: [] });
  const { base, mailer } = await startServer(t, { hibp });
  const cookie = await registerConfirmed(base, mailer);

  await scan(base, cookie);
  const html = await (await send(base, '/resultaten?gescand=datalekken', { cookie })).text();
  assert.match(html, /Goed nieuws/);
  assert.match(html, /geen garantie/);
  assert.match(html, /<span class="badge badge-ok">0 gevonden<\/span>/);
});

test('de resultatenpagina zonder scan nodigt uit om te zoeken, en meldingen komen niet uit het niets', async (t) => {
  const { base, mailer } = await startServer(t, { hibp: fakeHibp() });
  const cookie = await registerConfirmed(base, mailer);

  // Ook een verzonnen ?gescand=... toont geen melding als er nooit gescand is.
  const html = await (await send(base, '/resultaten?gescand=datalekken', { cookie })).text();
  assert.match(html, /Je hebt nog niet gezocht/);
  assert.doesNotMatch(html, /alert-ok/);

  const other = await (await send(base, '/resultaten?gescand=iets-anders', { cookie })).text();
  assert.doesNotMatch(other, /alert-ok/);
});

test('problemen met HIBP geven een nette melding, zonder technische details', async (t) => {
  const hibp = fakeHibp();
  const { base, mailer } = await startServer(t, { hibp, scanLimit: 100 }); // de uurlimiet doet hier niet mee
  const cookie = await registerConfirmed(base, mailer);

  const cases = [
    ['no_key', 503, /HIBP-sleutel nodig/],
    ['bad_key', 502, /accepteerde de sleutel niet/],
    ['rate_limited', 429, /even te wachten/],
    ['busy', 429, /veel controles tegelijk/],
    ['unavailable', 502, /niet bereikbaar/],
    ['unexpected', 502, /onverwacht antwoord/],
    ['iets-nieuws', 502, /onverwacht antwoord/], // een code die we nog niet kennen
  ];
  for (const [code, status, expected] of cases) {
    hibp.error = new ScanError(code);
    const response = await scan(base, cookie);
    assert.equal(response.status, status, code);
    const html = await response.text();
    assert.match(alertText(html), expected, code);
    assert.doesNotMatch(html, /ScanError|stack|node_modules/);
  }
});

test('een onverwachte fout tijdens het zoeken geeft de algemene foutpagina', async (t) => {
  t.mock.method(console, 'error', () => {});
  const hibp = fakeHibp({ error: new Error('geheime details uit de code') });
  const { base, mailer } = await startServer(t, { hibp });
  const cookie = await registerConfirmed(base, mailer);

  const response = await scan(base, cookie);
  assert.equal(response.status, 500);
  const html = await response.text();
  assert.match(html, /Er ging iets mis/);
  assert.ok(!html.includes('geheime details'));
});

test('te vaak zoeken wordt even tegengehouden', async (t) => {
  const hibp = fakeHibp({ breaches: [ADOBE] });
  const { base, mailer } = await startServer(t, { hibp, scanLimit: 2 });
  const cookie = await registerConfirmed(base, mailer);

  assert.equal((await scan(base, cookie)).status, 303);
  assert.equal((await scan(base, cookie)).status, 303);
  const blocked = await scan(base, cookie);
  assert.equal(blocked.status, 429);
  assert.match(alertText(await blocked.text()), /al een paar keer gezocht/);
  assert.equal(hibp.calls.length, 2);
});

test('zoeken vanaf een andere website wordt geweigerd (CSRF)', async (t) => {
  const hibp = fakeHibp({ breaches: [ADOBE] });
  const { base, mailer } = await startServer(t, { hibp });
  const cookie = await registerConfirmed(base, mailer);

  const response = await scan(base, cookie, { fetchSite: 'cross-site', origin: 'https://andere-site.example' });
  assert.equal(response.status, 403);
  assert.deepEqual(hibp.calls, []);
});

test('het dashboard toont de zoekknop, of vraagt om een sleutel', async (t) => {
  const hibp = fakeHibp({ breaches: [ADOBE, GAWKER] });
  const { base, mailer } = await startServer(t, { hibp });
  const cookie = await registerConfirmed(base, mailer);

  let html = await (await send(base, '/dashboard', { cookie })).text();
  assert.match(html, /action="\/scan\/datalekken"/);
  assert.match(html, /Zoek in datalekken/);
  assert.match(html, /Daarvoor sturen we dit e-mailadres naar hen/); // eerlijk over wat er verstuurd wordt
  assert.doesNotMatch(html, /Laatst gecontroleerd/);

  await scan(base, cookie);
  html = await (await send(base, '/dashboard', { cookie })).text();
  assert.match(html, /<span class="badge badge-warn">2 gevonden<\/span>/);
  assert.match(html, /Laatst gecontroleerd op/);
  assert.match(html, /href="\/resultaten#datalekken"/);

  hibp.hasKey = false;
  html = await (await send(base, '/dashboard', { cookie })).text();
  assert.doesNotMatch(html, /action="\/scan\/datalekken"/);
  assert.match(html, /HIBP-sleutel nodig/);
  assert.match(html, /account-exists@hibp-integration-tests\.com/);
});

test('je woonplaats opslaan, wijzigen en leegmaken', async (t) => {
  const { db, base, mailer } = await startServer(t, { hibp: fakeHibp() });
  const cookie = await registerConfirmed(base, mailer);
  const city = () => db.prepare('SELECT city FROM users').get().city;
  const save = (woonplaats) => send(base, '/profiel', { method: 'POST', cookie, fields: { woonplaats } });

  const form = await (await send(base, '/profiel', { cookie })).text();
  assert.match(form, /Anna de Vries/);
  assert.match(form, /anna@example\.com/);
  assert.match(form, /name="woonplaats"/);

  const saved = await save('  Utrecht ');
  assert.equal(saved.status, 303);
  assert.equal(saved.headers.get('location'), '/profiel?opgeslagen#woonplaats');
  assert.equal(city(), 'Utrecht');
  assert.match(await (await send(base, '/profiel?opgeslagen', { cookie })).text(), /Je woonplaats is opgeslagen/);
  assert.match(await (await send(base, '/profiel', { cookie })).text(), /value="Utrecht"/);

  for (const name of ["'s-Hertogenbosch", 'Bergen op Zoom', 'Sint-Oedenrode', 'Zoë-stad', 'St. Anna']) {
    assert.equal((await save(name)).status, 303, name);
    assert.equal(city(), name);
  }

  assert.equal((await save('')).status, 303);
  assert.equal(city(), null);
});

test('een woonplaats met vreemde tekens wordt geweigerd en niet opgeslagen', async (t) => {
  const { db, base, mailer } = await startServer(t, { hibp: fakeHibp() });
  const cookie = await registerConfirmed(base, mailer);
  await send(base, '/profiel', { method: 'POST', cookie, fields: { woonplaats: 'Utrecht' } });

  for (const bad of ['<b>Utrecht</b>', 'Utrecht 3584', '"Utrecht" OR site:x', '-Utrecht', 'Ut/recht', 'x'.repeat(61)]) {
    const response = await send(base, '/profiel', { method: 'POST', cookie, fields: { woonplaats: bad } });
    assert.equal(response.status, 400, bad);
    const html = await response.text();
    assert.match(alertText(html), /alleen letters/);
    assert.ok(!html.includes('<b>Utrecht</b>'), 'de invoer wordt niet als HTML teruggegeven');
  }
  assert.equal(db.prepare('SELECT city FROM users').get().city, 'Utrecht'); // ongewijzigd
});

test('resultaten zijn alleen van jezelf', async (t) => {
  const hibp = fakeHibp({ breaches: (email) => (email === ANNA.email ? [ADOBE] : [GAWKER]) });
  const { base, mailer } = await startServer(t, { hibp });
  const anna = await registerConfirmed(base, mailer);
  const bram = await registerConfirmed(base, mailer, BRAM);

  await scan(base, anna);
  await scan(base, bram);
  assert.deepEqual(hibp.calls, [ANNA.email, BRAM.email]);

  const annaPage = await (await send(base, '/resultaten', { cookie: anna })).text();
  const bramPage = await (await send(base, '/resultaten', { cookie: bram })).text();
  assert.match(annaPage, /Adobe/);
  assert.doesNotMatch(annaPage, /Gawker/);
  assert.match(bramPage, /Gawker/);
  assert.doesNotMatch(bramPage, /Adobe/);
});

test('tekst van HIBP wordt veilig getoond, ook als hij tags bevat', async (t) => {
  const evil = {
    ...ADOBE,
    title: '<img src=x onerror=alert(1)>',
    description: '<script>alert(2)</script>',
    dataClasses: ['<b>Wachtwoorden</b>'],
  };
  const { base, mailer } = await startServer(t, { hibp: fakeHibp({ breaches: [evil] }) });
  const cookie = await registerConfirmed(base, mailer);
  await scan(base, cookie);

  const html = await (await send(base, '/resultaten', { cookie })).text();
  assert.ok(!html.includes('<img src=x'));
  assert.ok(!html.includes('<script>alert(2)'));
  assert.ok(!html.includes('<b>Wachtwoorden'));
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
});

test('account verwijderen wist ook de resultaten, en alleen die van jou', async (t) => {
  const hibp = fakeHibp({ breaches: [ADOBE, GAWKER] });
  const { db, base, mailer } = await startServer(t, { hibp });
  const anna = await registerConfirmed(base, mailer);
  const bram = await registerConfirmed(base, mailer, BRAM);
  await scan(base, anna);
  await scan(base, bram);
  await register(base, { ...ANNA, email: 'carla@example.com' }); // met een openstaande bevestigingslink
  assert.equal(count(db, 'findings'), 4);

  const response = await send(base, '/account/verwijderen', {
    method: 'POST', cookie: anna, fields: { wachtwoord: ANNA.wachtwoord },
  });
  assert.equal(response.status, 303);

  assert.deepEqual(db.prepare('SELECT DISTINCT user_id FROM findings').all().length, 1);
  assert.equal(count(db, 'findings'), 2);
  assert.equal(count(db, 'scans'), 1);
  assert.equal(count(db, 'email_confirmations'), 1); // alleen nog die van Carla
  assert.match(await (await send(base, '/resultaten', { cookie: bram })).text(), /Gawker/);
});
