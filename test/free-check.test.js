// Tests voor de site zoals die draait zonder HIBP-sleutel, maar met de gratis dienst
// XposedOrNot: de controle op de startpagina, het dashboard en de privacyverklaring.
// Er wordt niets echt verstuurd: de tests gebruiken nep-fetches voor beide diensten.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBreachCheck } from '../src/breach-check.js';
import { createHibp } from '../src/hibp.js';
import { createXon } from '../src/xon.js';
import {
  alertText, fakeXonFetch, jsonResponse, registerConfirmed, send, startServer, xonFound,
} from './helpers.js';

// De zichtbare tekst van een pagina: zonder tags, met enkele spaties en zonder
// spatie voor leestekens.
const READABLE = (html) => html
  .replace(/<[^>]+>/g, ' ')
  .replace(/\s+/g, ' ')
  .replace(/\s+([.,;:)])/g, '$1');

const check = (base, email) => send(base, '/controle', { method: 'POST', fields: { email } });

// Alles wat er in alle tabellen staat, als één tekst.
function everythingInDatabase(db) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
  return tables.map(({ name }) => JSON.stringify(db.prepare(`SELECT * FROM ${name}`).all())).join('\n');
}

// De site zoals hij draait zonder eigen HIBP-sleutel, met de gratis dienst aan. HIBP geeft voor
// zijn testadressen altijd het lek "Gawker". Alles wat er verstuurd wordt, onthouden we.
function freeSite(xonAnswers = {}) {
  const xonFetch = fakeXonFetch(xonAnswers);
  const hibpUrls = [];
  const hibpFetch = async (url) => {
    hibpUrls.push(url);
    return jsonResponse(200, [{ Name: 'Gawker', Title: 'Gawker', BreachDate: '2010-12-11', DataClasses: ['Passwords'] }]);
  };
  const logs = [];
  const hibp = createBreachCheck({
    hibp: createHibp({ fetchImpl: hibpFetch, minIntervalMs: 0 }),
    xon: createXon({ fetchImpl: xonFetch.impl, minIntervalMs: 0, log: (line) => logs.push(line) }),
  });
  return { hibp, xonFetch, hibpUrls, logs };
}

const withLekken = (...names) => ({ email: () => jsonResponse(200, xonFound(...names)) });
const nietGevonden = { email: () => jsonResponse(404, { Error: 'Not found', email: null }) };

// --- De startpagina ---------------------------------------------------------------------

test('met de gratis dienst werkt de startpagina voor echte adressen, zonder testmodus', async (t) => {
  const { hibp } = freeSite();
  const { base } = await startServer(t, { hibp });

  const html = await (await send(base, '/')).text();
  assert.doesNotMatch(html, /Testmodus/);
  assert.match(READABLE(html), /Het adres gaat naar XposedOrNot, wij tonen wat zij terugsturen/);
  assert.doesNotMatch(READABLE(html), /Het adres gaat naar Have I Been Pwned/);
});

test('een echt adres wordt opgezocht bij XposedOrNot, met XposedOrNot als bron', async (t) => {
  const { hibp, hibpUrls } = freeSite(withLekken('LinkedIn', 'Adobe', 'Datingsite', 'Verborgen'));
  const { base } = await startServer(t, { hibp });

  const response = await check(base, 'iemand@example.com');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const html = await response.text();
  const text = READABLE(html);

  // Twee lekken, de nieuwste eerst. De gevoelige en de niet-doorzoekbare zijn er niet bij.
  assert.match(text, /Dit adres staat in 2 bekende datalekken/);
  assert.ok(text.indexOf('Adobe') < text.indexOf('LinkedIn'));
  assert.doesNotMatch(text, /Datingsite|Verborgen/);
  assert.match(text, /Gelekt op 4 oktober 2013 · 152\.445\.165 accounts/);
  assert.match(text, /E-mailadressen Wachtwoorden/); // in het Nederlands

  // De bron is XposedOrNot en niet Have I Been Pwned.
  assert.match(text, /Bron: XposedOrNot\. Uit voorzorg tonen we geen gevoelige lekken/);
  assert.doesNotMatch(html, /haveibeenpwned\.com|Have I Been Pwned|CC BY/);
  assert.equal(hibpUrls.length, 0);

  // Een lek met een verwijzing krijgt een link; zonder verwijzing is er geen link.
  assert.match(html, /href="https:\/\/example\.com\/adobe"[^>]*rel="noopener noreferrer">Meer over dit datalek<\/a>/);
  assert.doesNotMatch(html, /example\.com\/linkedin/);
  assert.equal(html.match(/Meer over dit datalek/g).length, 1); // LinkedIn heeft geen link, ook geen lege
  assert.doesNotMatch(html, /href=""/);
});

test('een adres dat nergens in staat, geeft goed nieuws met XposedOrNot als bron', async (t) => {
  const { hibp } = freeSite(nietGevonden);
  const { base } = await startServer(t, { hibp });

  const text = READABLE(await (await check(base, 'veilig@example.com')).text());
  assert.match(text, /Goed nieuws: geen datalek gevonden/);
  assert.match(text, /XposedOrNot kent veilig@example\.com niet uit een bekend datalek/);
  assert.match(text, /Bron: XposedOrNot\./);
});

test('het adres wordt nergens bewaard of gelogd, en gaat alleen naar de aanvraag waar het hoort', async (t) => {
  const written = [];
  for (const name of ['log', 'warn', 'error', 'info']) {
    t.mock.method(console, name, (...args) => written.push(args.join(' ')));
  }
  const secret = 'geheim.persoon@example.com';
  const { hibp, xonFetch, logs } = freeSite(withLekken('Adobe'));
  const { db, base } = await startServer(t, { hibp });

  const response = await check(base, secret);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('location'), null);

  assert.doesNotMatch(everythingInDatabase(db), /geheim\.persoon|geheim%2Epersoon/);
  for (const line of [...written, ...logs]) assert.doesNotMatch(line, /geheim|example\.com/);
  const withAddress = xonFetch.calls.filter((call) => call.url.includes('geheim'));
  assert.equal(withAddress.length, 1);
  assert.match(withAddress[0].url, /\/v1\/check-email\/geheim\.persoon%40example\.com$/);
});

test('een bezoeker kan met de limiet per IP-adres niet meer aanvragen doen dan XposedOrNot toestaat', async (t) => {
  const { hibp, xonFetch } = freeSite(nietGevonden);
  const { base } = await startServer(t, { hibp, checkLimit: 2 });

  assert.equal((await check(base, 'een@example.com')).status, 200);
  assert.equal((await check(base, 'twee@example.com')).status, 200);
  assert.equal((await check(base, 'drie@example.com')).status, 429);

  assert.equal(xonFetch.count('/v1/check-email/'), 2);
});

// --- Het testadres en fouten ---------------------------------------------------------------

test('de testadressen van HIBP werken ook met de gratis dienst aan, en gaan naar HIBP', async (t) => {
  const { hibp, xonFetch, hibpUrls } = freeSite();
  const { base } = await startServer(t, { hibp });

  const response = await check(base, 'multiple-breaches@hibp-integration-tests.com');
  assert.equal(response.status, 200);
  const text = READABLE(await response.text());
  assert.match(text, /Gawker/);
  assert.match(text, /Bron: Have I Been Pwned \(gegevens onder licentie CC BY 4\.0\)/);
  assert.equal(hibpUrls.length, 1);
  assert.equal(xonFetch.calls.length, 0);
});

test('te veel aanvragen bij de gratis dienst geeft een vaste melding zonder details', async (t) => {
  const { hibp } = freeSite({ email: () => jsonResponse(429, { retry_after: 3600, reset_time: '2026-11-25T20:00:00Z' }) });
  const { base } = await startServer(t, { hibp });

  const response = await check(base, 'iemand@example.com');
  assert.equal(response.status, 429);
  const html = await response.text();
  assert.match(alertText(html), /staat maar een beperkt aantal controles per uur toe/);
  assert.doesNotMatch(html, /retry_after|reset_time|3600|Have I Been Pwned/);
});

test('een onverwacht antwoord geeft een algemene melding, en alleen de beheerder leest de rest', async (t) => {
  const written = [];
  t.mock.method(console, 'error', (...args) => written.push(args.join(' ')));
  const { hibp, logs } = freeSite({ email: () => jsonResponse(200, { iets: 'anders' }) });
  const { base } = await startServer(t, { hibp });

  const response = await check(base, 'iemand@example.com');
  assert.equal(response.status, 502);
  const html = await response.text();
  assert.match(alertText(html), /XposedOrNot gaf een onverwacht antwoord/);
  assert.doesNotMatch(html, /iets|velden|HIBP_API_KEY/);

  // In het logboek staat wat er mis was, zonder het adres.
  assert.match(logs.join('\n'), /onverwacht formaat/);
  for (const line of [...written, ...logs]) assert.doesNotMatch(line, /iemand|example\.com/);
});

// --- Het dashboard --------------------------------------------------------------------------

test('op het dashboard zoekt een bevestigd adres ook via XposedOrNot, en de resultaten noemen die bron', async (t) => {
  const { hibp, xonFetch, hibpUrls } = freeSite(withLekken('Adobe', 'LinkedIn', 'Datingsite'));
  const { db, base, mailer } = await startServer(t, { hibp });
  const cookie = await registerConfirmed(base, mailer);

  const dashboard = await (await send(base, '/dashboard', { cookie })).text();
  assert.match(READABLE(dashboard), /in bekende datalekken zit, via XposedOrNot/);
  assert.match(READABLE(dashboard), /Gratis via XposedOrNot: maximaal 25 controles per uur en 100 per dag/);
  assert.match(dashboard, /action="\/scan\/datalekken"/);
  assert.doesNotMatch(dashboard, /HIBP-sleutel nodig/);

  const scan = await send(base, '/scan/datalekken', { method: 'POST', cookie });
  assert.equal(scan.status, 303);
  assert.match(xonFetch.calls[0].url, /\/v1\/check-email\/anna%40example\.com$/);
  assert.equal(hibpUrls.length, 0);

  const results = await (await send(base, '/resultaten?gescand=datalekken', { cookie })).text();
  const text = READABLE(results);
  assert.match(text, /Gecontroleerd: 2 datalekken gevonden, waarvan 2 nieuw/);
  assert.match(text, /Bron: XposedOrNot\./);
  assert.doesNotMatch(results, /haveibeenpwned\.com|Have I Been Pwned|CC BY|Datingsite/);
  assert.match(results, /href="https:\/\/example\.com\/adobe"[^>]*>Meer over dit datalek<\/a>/);
  assert.doesNotMatch(results, /example\.com\/linkedin/);
  assert.equal(results.match(/Meer over dit datalek/g).length, 1); // LinkedIn heeft geen link, ook geen lege
  assert.doesNotMatch(results, /href=""/);

  // Opgeslagen: de bron en de link (of geen link), en alleen de gewone lekken.
  const rows = db.prepare("SELECT source_key, url, details FROM findings WHERE kind = 'breach' ORDER BY source_key").all();
  assert.deepEqual(rows.map((row) => [row.source_key, row.url]), [
    ['Adobe', 'https://example.com/adobe'],
    ['LinkedIn', null],
  ]);
  const details = JSON.parse(rows[0].details);
  assert.equal(details.source, 'xon');
  assert.equal(details.isSensitive, false);
  assert.equal('url' in details, false); // de link staat in zijn eigen kolom
});

test('op het dashboard noemt het goede nieuws de bron die gezocht heeft', async (t) => {
  const { hibp } = freeSite(nietGevonden);
  const { base, mailer } = await startServer(t, { hibp });
  const cookie = await registerConfirmed(base, mailer);

  await send(base, '/scan/datalekken', { method: 'POST', cookie });
  const results = READABLE(await (await send(base, '/resultaten?gescand=datalekken', { cookie })).text());

  assert.match(results, /Goed nieuws: XposedOrNot kent dit e-mailadres niet uit een datalek/);
  assert.match(results, /XposedOrNot kent je e-mailadres niet uit een datalek\. Dat is geen garantie/);
  assert.match(results, /Bron: XposedOrNot\./);
});

test('op het dashboard legt de melding bij te veel aanvragen uit wat de grens is', async (t) => {
  const { hibp } = freeSite({ email: () => jsonResponse(429, {}) });
  const { base, mailer } = await startServer(t, { hibp });
  const cookie = await registerConfirmed(base, mailer);

  const scan = await send(base, '/scan/datalekken', { method: 'POST', cookie });
  assert.equal(scan.status, 429);
  assert.match(READABLE(await scan.text()), /XposedOrNot staat maar 25 controles per uur en 100 per dag toe/);
});

test('oude resultaten uit de tijd dat er alleen HIBP was, blijven kloppen', async (t) => {
  const { hibp } = freeSite();
  const { db, base, mailer } = await startServer(t, { hibp });
  const cookie = await registerConfirmed(base, mailer);
  const user = db.prepare('SELECT id FROM users').get();
  // Zo werden resultaten bewaard voordat er een bron bij stond: zonder "source".
  db.prepare(`INSERT INTO findings (user_id, kind, source_key, title, url, details, status, found_at, updated_at)
    VALUES (?, 'breach', 'Adobe', 'Adobe', 'https://haveibeenpwned.com/PwnedWebsites#Adobe',
    '{"breachDate":"2013-10-04","pwnCount":1,"dataClasses":["Passwords"],"description":""}', 'mine', 1, 1)`).run(user.id);
  db.prepare("INSERT INTO scans (user_id, kind, ran_at, found_count, new_count, detail) VALUES (?, 'breach', 1, 1, 1, NULL)").run(user.id);

  const results = await (await send(base, '/resultaten', { cookie })).text();
  assert.match(results, /href="https:\/\/haveibeenpwned\.com\/PwnedWebsites#Adobe"[^>]*>Meer over dit datalek bij Have I Been Pwned<\/a>/);
  // De bron van dit lek is HIBP, en die van het adres nu XposedOrNot: allebei staan ze genoemd.
  assert.match(READABLE(results), /Bron: XposedOrNot en Have I Been Pwned \(gegevens onder licentie CC BY 4\.0\)\./);
});

// --- De privacyverklaring --------------------------------------------------------------------

test('de privacyverklaring zegt dat adressen naar XposedOrNot gaan', async (t) => {
  const { hibp } = freeSite();
  const { base } = await startServer(t, { hibp });

  const text = READABLE(await (await send(base, '/privacy')).text());
  assert.match(text, /sturen we je e-mailadres naar XposedOrNot \(xposedornot\.com\)\. Zij zoeken het adres op/);
  assert.match(text, /Als je op de startpagina een e-mailadres controleert, sturen we ook dat adres naar XposedOrNot, op dezelfde manier/);
  assert.doesNotMatch(text, /e-mailadres naar Have I Been Pwned/);
  // Het wachtwoord controleren we nog steeds bij Have I Been Pwned (zonder je adres).
  assert.match(text, /via Have I Been Pwned\. Daarbij gaan alleen de eerste 5 tekens van een hash/);
});
