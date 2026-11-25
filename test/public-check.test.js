// Tests voor de openbare e-mailcontrole op de startpagina, zoals Have I Been Pwned die
// ook heeft: iedereen mag een adres intypen, en we tonen alleen in welke bekende lekken
// het zat. Er wordt niets echt naar HIBP gestuurd: de tests gebruiken een nepversie.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dataClassLabel } from '../src/data-classes.js';
import { createHibp } from '../src/hibp.js';
import { ScanError } from '../src/scan-error.js';
import {
  ADOBE, GAWKER, alertText, fakeHibp, fakeSearch, registerConfirmed, send, startServer,
} from './helpers.js';

// De zichtbare tekst van een pagina: zonder tags, met enkele spaties en zonder
// spatie voor leestekens.
const READABLE = (html) => html
  .replace(/<[^>]+>/g, ' ')
  .replace(/\s+/g, ' ')
  .replace(/\s+([.,;:)])/g, '$1');

const check = (base, email, extra = {}) => send(base, '/controle', { method: 'POST', fields: { email }, ...extra });

const count = (db, table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;

// Alles wat er in alle tabellen staat, als één tekst. Zo vinden we een adres ook in een
// tabel die er later bijkomt.
function everythingInDatabase(db) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
  return tables.map(({ name }) => JSON.stringify(db.prepare(`SELECT * FROM ${name}`).all())).join('\n');
}

// --- De pagina ---------------------------------------------------------------------

test('de startpagina is de controle zelf, zonder dat je hoeft in te loggen', async (t) => {
  const { base } = await startServer(t, { hibp: fakeHibp() });

  const response = await send(base, '/');
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<form method="post" action="\/controle"/);
  assert.match(html, /<input id="email" name="email" type="email"/);
  assert.match(READABLE(html), /Het adres dat je intypt, bewaren we niet/);
  assert.match(html, /href="\/inloggen"/);
  assert.match(html, /href="\/registreren"/);

  // En dezelfde pagina staat ook op /controle, voor de link in de voettekst.
  const direct = await send(base, '/controle');
  assert.equal(direct.status, 200);
  assert.match(await direct.text(), /action="\/controle"/);
});

test('de pagina zegt dat je hier geen mensen op naam kunt zoeken', async (t) => {
  const { base } = await startServer(t, { hibp: fakeHibp() });
  const text = READABLE(await (await send(base, '/')).text());
  assert.match(text, /Geen zoekvak voor namen/);
  assert.match(text, /alleen controleren of een e-mailadres in een bekend datalek voorkomt/);
});

// --- Controleren ---------------------------------------------------------------------

test('een bezoeker ziet in welke lekken een adres zit, met bronvermelding', async (t) => {
  const hibp = fakeHibp({ breaches: [GAWKER, ADOBE] });
  const { base } = await startServer(t, { hibp });

  const response = await check(base, '  Iemand@Example.COM ');
  assert.equal(response.status, 200);
  assert.deepEqual(hibp.calls, ['iemand@example.com']); // spaties en hoofdletters eraf

  const html = await response.text();
  const text = READABLE(html);
  assert.match(text, /Dit adres staat in 2 bekende datalekken/);
  assert.match(text, /iemand@example\.com kwam voor in de lekken hieronder/);
  assert.match(text, /Gelekt op 4 oktober 2013/);
  assert.match(text, /152\.445\.165 accounts/);
  assert.match(html, /<li>Wachtwoorden<\/li>/); // de soorten gegevens staan in het Nederlands
  assert.ok(html.indexOf('Adobe') < html.indexOf('Gawker'), 'het nieuwste lek staat bovenaan');
  assert.match(html, /href="https:\/\/haveibeenpwned\.com\/PwnedWebsites#Adobe"[^>]*rel="noopener noreferrer"/);
  assert.match(text, /Wat kun je doen\?/);
  assert.match(text, /Bron: Have I Been Pwned \(gegevens onder licentie CC BY 4\.0\)/);
});

test('één lek wordt in het enkelvoud gemeld', async (t) => {
  const { base } = await startServer(t, { hibp: fakeHibp({ breaches: [ADOBE] }) });
  assert.match(READABLE(await (await check(base, 'iemand@example.com')).text()), /Dit adres staat in 1 bekend datalek\b/);
});

test('geen lekken: goed nieuws, maar met de kanttekening dat het geen garantie is', async (t) => {
  const { base } = await startServer(t, { hibp: fakeHibp({ breaches: [] }) });

  const response = await check(base, 'veilig@example.com');
  assert.equal(response.status, 200);
  const text = READABLE(await response.text());
  assert.match(text, /Goed nieuws: geen datalek gevonden/);
  assert.match(text, /Have I Been Pwned kent veilig@example\.com niet uit een bekend datalek/);
  assert.match(text, /Dat is geen garantie/);
  assert.doesNotMatch(text, /Wat kun je doen/);
  assert.match(text, /Bron: Have I Been Pwned/); // de bron staat er ook als er niets is
});

test('we tonen nooit de gelekte gegevens zelf, alleen naam, datum, aantal en soorten', async (t) => {
  const lek = { ...ADOBE, password: 'geheim-wachtwoord-123', passwords: ['hunter2'], email: 'slachtoffer@example.com' };
  const { base } = await startServer(t, { hibp: fakeHibp({ breaches: [lek] }) });

  const html = await (await check(base, 'iemand@example.com')).text();
  assert.doesNotMatch(html, /geheim-wachtwoord-123|hunter2|slachtoffer@example\.com/);
});

test('gevoelige datalekken worden nooit getoond, ook niet als de bron ze meestuurt', async (t) => {
  const geheim = { ...ADOBE, name: 'Geheim', title: 'Geheim lek', isSensitive: true };
  const hibp = fakeHibp({ breaches: [geheim, GAWKER] });
  const { base } = await startServer(t, { hibp });

  let text = READABLE(await (await check(base, 'iemand@example.com')).text());
  assert.match(text, /Dit adres staat in 1 bekend datalek/);
  assert.doesNotMatch(text, /Geheim lek/);
  assert.match(text, /Gawker/);

  // Zijn ze allemaal gevoelig, dan tonen we niets, en tellen ze ook niet mee.
  hibp.breaches = [geheim];
  text = READABLE(await (await check(base, 'iemand@example.com')).text());
  assert.match(text, /geen datalek gevonden/);
  assert.doesNotMatch(text, /Geheim lek/);
  assert.match(text, /geen gevoelige lekken, zoals die van datingsites/); // dat zeggen we er eerlijk bij
});

test('tekst van buiten wordt als gewone tekst getoond, ook het adres zelf', async (t) => {
  const vies = { ...ADOBE, title: '<img src=x onerror=alert(1)>', description: '<script>alert(2)</script>' };
  const { base } = await startServer(t, { hibp: fakeHibp({ breaches: [vies] }) });

  const evil = '"><script>alert(3)</script>@example.com';
  const html = await (await check(base, evil)).text();
  assert.doesNotMatch(html, /<img src=x|<script>alert/);
  assert.ok(html.includes('&lt;script&gt;alert(3)&lt;/script&gt;@example.com'));
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
});

test('een controle zoekt nooit op naam op het web', async (t) => {
  const search = fakeSearch({ results: [] });
  const { base } = await startServer(t, { hibp: fakeHibp({ breaches: [] }), search });

  await check(base, 'iemand@example.com', {
    fields: { email: 'iemand@example.com', naam: 'Anna de Vries', q: 'iemand anders', woonplaats: 'Utrecht' },
  });
  assert.deepEqual(search.calls, []);
});

test('ongeldige adressen geven een nette fout en gaan niet naar HIBP', async (t) => {
  const hibp = fakeHibp({ breaches: [ADOBE] });
  const { base } = await startServer(t, { hibp });

  for (const bad of ['', '   ', 'geen-adres', 'a@b', 'spatie in@example.com', `${'x'.repeat(400)}@example.com`]) {
    const response = await check(base, bad);
    assert.equal(response.status, 400, JSON.stringify(bad));
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const html = await response.text();
    assert.equal(alertText(html), 'Vul een geldig e-mailadres in.');
    assert.doesNotMatch(html, /x{255}/); // een enorme invoer sturen we niet helemaal terug
  }

  // Zonder veld, en met twee velden tegelijk (dan is het geen adres meer).
  assert.equal((await send(base, '/controle', { method: 'POST', fields: {} })).status, 400);
  const twice = await send(base, '/controle', {
    method: 'POST', fields: [['email', 'a@example.com'], ['email', 'b@example.com']],
  });
  assert.equal(twice.status, 400);
  assert.deepEqual(hibp.calls, []);
});

// --- Het adres wordt nergens bewaard -------------------------------------------------------

test('het adres wordt nergens bewaard: niet in de database, niet in een logboek, niet in de URL', async (t) => {
  const logs = [];
  for (const method of ['log', 'info', 'warn', 'error', 'debug']) {
    t.mock.method(console, method, (...args) => logs.push(args.join(' ')));
  }
  const { db, base } = await startServer(t, { hibp: fakeHibp({ breaches: [ADOBE] }) });

  const response = await check(base, 'geheim.adres@example.com');
  assert.equal(response.status, 200);
  await response.text();

  // Er is niets van een gebruiker of scan; alleen een teller met een hash van het IP-adres.
  for (const table of ['users', 'sessions', 'email_confirmations', 'findings', 'scans']) {
    assert.equal(count(db, table), 0, table);
  }
  assert.equal(count(db, 'rate_limits'), 1);
  assert.match(db.prepare('SELECT id FROM rate_limits').get().id, /^[0-9a-f]{64}$/);
  assert.doesNotMatch(everythingInDatabase(db), /geheim\.adres|example\.com/);

  assert.deepEqual(logs.filter((line) => /geheim\.adres/.test(line)), []);

  // Geen doorverwijzing met het adres erin, en de pagina blijft niet in de cache van de browser.
  assert.equal(response.headers.get('location'), null);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('ook bij een fout van HIBP komt het adres nergens terecht', async (t) => {
  const logs = [];
  for (const method of ['log', 'info', 'warn', 'error', 'debug']) {
    t.mock.method(console, method, (...args) => logs.push(args.join(' ')));
  }
  const hibp = fakeHibp({ error: new ScanError('bad_key') });
  const { db, base } = await startServer(t, { hibp });

  await check(base, 'geheim.adres@example.com');
  hibp.error = new Error('onverwacht');
  assert.equal((await check(base, 'geheim.adres@example.com')).status, 500);

  assert.ok(logs.length > 0); // de beheerder krijgt wel iets te lezen
  assert.deepEqual(logs.filter((line) => /geheim\.adres/.test(line)), []);
  assert.doesNotMatch(everythingInDatabase(db), /geheim\.adres/);
});

test('een adres in de adresbalk wordt genegeerd', async (t) => {
  const hibp = fakeHibp({ breaches: [ADOBE] });
  const { base } = await startServer(t, { hibp });

  for (const path of ['/controle?email=spion%40example.com', '/?email=spion%40example.com']) {
    const response = await send(base, path);
    assert.equal(response.status, 200, path);
    assert.doesNotMatch(await response.text(), /spion/, path);
  }
  assert.deepEqual(hibp.calls, []);
});

// --- Misbruik ---------------------------------------------------------------------------------

test('te veel controles vanaf één IP-adres worden even tegengehouden, welk adres ook', async (t) => {
  const hibp = fakeHibp({ breaches: [] });
  const { base } = await startServer(t, { hibp, checkLimit: 2 });

  assert.equal((await check(base, 'een@example.com')).status, 200);
  assert.equal((await check(base, 'twee@example.com')).status, 200);
  const blocked = await check(base, 'drie@example.com');
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get('cache-control'), 'no-store');
  assert.match(alertText(await blocked.text()), /al een paar keer gecontroleerd/);
  assert.deepEqual(hibp.calls, ['een@example.com', 'twee@example.com']); // het derde ging niet naar HIBP

  assert.equal((await send(base, '/')).status, 200); // de pagina zelf blijft bereikbaar
});

test('een typfout of een storing bij HIBP telt niet mee voor de limiet', async (t) => {
  const hibp = fakeHibp({ breaches: [] });
  const { base } = await startServer(t, { hibp, checkLimit: 2 });

  for (let i = 0; i < 3; i += 1) assert.equal((await check(base, 'kapot')).status, 400);

  hibp.error = new ScanError('unavailable');
  for (let i = 0; i < 3; i += 1) assert.equal((await check(base, 'goed@example.com')).status, 502);

  hibp.error = null;
  assert.equal((await check(base, 'goed@example.com')).status, 200);
  assert.equal((await check(base, 'goed@example.com')).status, 200);
  assert.equal((await check(base, 'goed@example.com')).status, 429);
});

test('een controle vanaf een andere website wordt geweigerd (CSRF)', async (t) => {
  const hibp = fakeHibp({ breaches: [ADOBE] });
  const { base } = await startServer(t, { hibp });

  const crossSite = await check(base, 'iemand@example.com', { origin: 'https://kwaad.example', fetchSite: 'cross-site' });
  assert.equal(crossSite.status, 403);

  // Zonder Origin en Sec-Fetch-Site is het geen browser.
  const noHeaders = await check(base, 'iemand@example.com', { origin: null, fetchSite: null });
  assert.equal(noHeaders.status, 403);

  assert.deepEqual(hibp.calls, []); // onze aanvragen bij HIBP zijn niet te gebruiken door andere sites
});

// --- Als het misgaat -----------------------------------------------------------------------------

test('fouten van Have I Been Pwned geven een nette melding zonder technische details', async (t) => {
  t.mock.method(console, 'error', () => {}); // houd de testuitvoer schoon
  const cases = [
    ['bad_key', 502, /De controle is nu niet beschikbaar/],
    ['rate_limited', 429, /vraagt om even te wachten/],
    ['busy', 429, /Er lopen al veel controles tegelijk/],
    ['unavailable', 502, /nu niet bereikbaar/],
    ['unexpected', 502, /onverwacht antwoord/],
    ['iets_nieuws', 502, /onverwacht antwoord/], // een onbekende code geeft de algemene melding
  ];
  for (const [code, status, pattern] of cases) {
    const { base } = await startServer(t, { hibp: fakeHibp({ error: new ScanError(code) }) });
    const response = await check(base, 'iemand@example.com');
    assert.equal(response.status, status, code);
    const html = await response.text();
    assert.match(alertText(html), pattern, code);
    assert.doesNotMatch(html, /HIBP_API_KEY|\.env|iets_nieuws/, code);
  }
});

test('de beheerder leest in de terminal wat er met de sleutel mis is, zonder adres', async (t) => {
  const errors = [];
  t.mock.method(console, 'error', (...args) => errors.push(args.join(' ')));
  const { base } = await startServer(t, { hibp: fakeHibp({ error: new ScanError('bad_key') }) });

  assert.equal((await check(base, 'iemand@example.com')).status, 502);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /HIBP_API_KEY/);
  assert.doesNotMatch(errors[0], /iemand/);
});

test('een onverwachte fout geeft de algemene foutpagina, zonder details', async (t) => {
  t.mock.method(console, 'error', () => {});
  const { base } = await startServer(t, { hibp: fakeHibp({ error: new Error('geheime details uit de server') }) });

  const response = await check(base, 'iemand@example.com');
  assert.equal(response.status, 500);
  const html = await response.text();
  assert.match(html, /Er ging iets mis/);
  assert.doesNotMatch(html, /geheime details|iemand@example\.com/);
});

test('zonder eigen sleutel werken alleen de testadressen, en de pagina zegt dat eerlijk', async (t) => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    return new Response(JSON.stringify([{ Name: 'Adobe', Title: 'Adobe', BreachDate: '2013-10-04', DataClasses: ['Passwords'] }]), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  };
  const { base } = await startServer(t, { hibp: createHibp({ fetchImpl, minIntervalMs: 0 }) });

  const home = READABLE(await (await send(base, '/')).text());
  assert.match(home, /Testmodus\. Deze site heeft nog geen eigen sleutel van Have I Been Pwned/);
  assert.match(home, /multiple-breaches@hibp-integration-tests\.com/);

  const other = await check(base, 'iemand@example.com');
  assert.equal(other.status, 503);
  assert.match(alertText(await other.text()), /Deze site kan nu alleen testadressen controleren/);
  assert.deepEqual(urls, []); // er is niets naar HIBP gestuurd

  const testAddress = await check(base, 'multiple-breaches@hibp-integration-tests.com');
  assert.equal(testAddress.status, 200);
  assert.match(READABLE(await testAddress.text()), /Dit adres staat in 1 bekend datalek/);
  assert.equal(urls.length, 1);
});

test('met een eigen sleutel staat er geen testmodus-melding', async (t) => {
  const { base } = await startServer(t, { hibp: fakeHibp({ hasKey: true }) });
  assert.doesNotMatch(await (await send(base, '/')).text(), /Testmodus/);
});

// --- Naast de rest van de site -------------------------------------------------------------

test('ingelogd kun je ook een ander adres controleren, zonder dat het bij je account komt', async (t) => {
  const hibp = fakeHibp({ breaches: [ADOBE] });
  const { db, base, mailer } = await startServer(t, { hibp });
  const cookie = await registerConfirmed(base, mailer);

  assert.equal((await send(base, '/', { cookie })).headers.get('location'), '/dashboard');
  const page = await send(base, '/controle', { cookie });
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Naar je dashboard/);
  assert.doesNotMatch(html, /href="\/registreren"/);

  const response = await check(base, 'familie@example.com', { cookie });
  assert.equal(response.status, 200);
  assert.deepEqual(hibp.calls, ['familie@example.com']);
  assert.equal(count(db, 'findings'), 0);
  assert.equal(count(db, 'scans'), 0);
  assert.doesNotMatch(everythingInDatabase(db), /familie@example\.com/);
});

test('op een openbare site (production) werkt de controle ook, en zoeken op naam blijft uit', async (t) => {
  const search = fakeSearch({ results: [] });
  const hibp = fakeHibp({ breaches: [ADOBE] });
  const { base, mailer } = await startServer(t, { hibp, search, production: true });

  const response = await check(base, 'iemand@example.com');
  assert.equal(response.status, 200);
  assert.match(READABLE(await response.text()), /Dit adres staat in 1 bekend datalek/);

  const cookie = await registerConfirmed(base, mailer);
  assert.equal((await send(base, '/scan/web', { method: 'POST', cookie })).status, 403);
  assert.deepEqual(search.calls, []);
});

test('de pagina heeft dezelfde beveiligingsheaders als de rest van de site', async (t) => {
  const { base } = await startServer(t, { hibp: fakeHibp({ breaches: [] }) });

  for (const response of [await send(base, '/'), await check(base, 'iemand@example.com')]) {
    assert.match(response.headers.get('content-security-policy'), /default-src 'self'/);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('referrer-policy'), 'same-origin');
  }
});

test('het dashboard verwijst naar de controle en belooft geen verwijderfase meer', async (t) => {
  const hibp = fakeHibp({ breaches: [ADOBE] });
  const { base, mailer } = await startServer(t, { hibp });
  const cookie = await registerConfirmed(base, mailer);

  const dashboard = await (await send(base, '/dashboard', { cookie })).text();
  assert.match(dashboard, /<a href="\/controle">Een ander e-mailadres controleren<\/a>/);
  assert.doesNotMatch(dashboard, /Verwijderverzoeken|Fase 3|laten verwijderen/);

  await send(base, '/scan/datalekken', { method: 'POST', cookie });
  const results = await (await send(base, '/resultaten?gescand=datalekken', { cookie })).text();
  assert.doesNotMatch(results, /fase 3|AVG-verwijderverzoek|verwijderfase/i);
});

// --- Kleine hulpfuncties -------------------------------------------------------------------------

test('de soorten gegevens staan in het Nederlands, onbekende blijven zoals HIBP ze noemt', () => {
  assert.equal(dataClassLabel('Passwords'), 'Wachtwoorden');
  assert.equal(dataClassLabel('Email addresses'), 'E-mailadressen');
  assert.equal(dataClassLabel('Een nieuwe soort'), 'Een nieuwe soort');
  // Een naam als "constructor" geeft geen onderdeel van JavaScript terug.
  assert.equal(dataClassLabel('constructor'), 'constructor');
  assert.equal(dataClassLabel('__proto__'), '__proto__');
});
