// Tests voor de hele site zonder zoekdienst, en met Brave Search (nagebootst: er gaat niets naar
// buiten). De site verzint niets zonder zoekdienst, houdt zich aan de bewaartermijn van een dienst
// die bewaren niet toestaat, en lekt geen sleutel of zoekopdracht.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WEB_RESULT_MS } from '../src/retention.js';
import { createBraveSearch } from '../src/search.js';
import {
  ADOBE, ANNA, alertText, fakeBraveFetch, fakeHibp, jsonResponse, registerConfirmed, send, startServer,
} from './helpers.js';

const KEY = 'BSA-test-sleutel-0123456789';

const FOTOGRAAF = {
  title: 'Anna de Vries - Fotograaf in Utrecht',
  url: 'https://example.org/anna',
  description: 'Anna de Vries uit <strong>Utrecht</strong>. Bel 06 12 34 56 78 of mail anna@example.com.',
};
const LINKEDIN = {
  title: 'Anna de Vries | LinkedIn',
  url: 'https://nl.linkedin.com/in/anna-de-vries',
  description: 'Anna de Vries, projectleider. Utrecht en omgeving.',
};
const TELEFOONBOEK = {
  title: 'Anna de Vries in Utrecht - Telefoonboek',
  url: 'https://www.telefoonboek.nl/anna-de-vries',
  description: 'Anna de Vries, 3512 AB Utrecht, tel. 020 123 45 67',
};
const LEDENLIJST = {
  title: 'Ledenlijst 2025',
  url: 'https://example.net/ledenlijst.pdf',
  description: 'Leden: Anna de Vries, Amsterdam.',
};
const FOUR = [FOTOGRAAF, LINKEDIN, TELEFOONBOEK, LEDENLIJST];

const braveAnswer = (...results) => () => jsonResponse(200, { type: 'search', web: { type: 'search', results } });

// De hele site met Brave als zoekdienst (nagebootst). `storageRights` zet de bewaartermijn uit.
async function setupBrave(t, { answer = braveAnswer(...FOUR), storageRights = false, ...options } = {}) {
  const fetchFake = fakeBraveFetch(answer);
  const logs = [];
  const search = createBraveSearch({
    apiKey: KEY, fetchImpl: fetchFake.impl, minIntervalMs: 0, retainsResults: storageRights,
    log: (line) => logs.push(String(line)),
  });
  const hibp = options.hibp ?? fakeHibp({ breaches: [ADOBE] });
  const server = await startServer(t, { ...options, hibp, search });
  const cookie = await registerConfirmed(server.base, server.mailer);
  return { ...server, search, fetchFake, logs, cookie, hibp };
}

async function setupNoSearch(t, options = {}) {
  const hibp = options.hibp ?? fakeHibp({ breaches: [ADOBE] });
  const server = await startServer(t, { ...options, hibp, search: null });
  const cookie = await registerConfirmed(server.base, server.mailer);
  return { ...server, cookie, hibp };
}

const post = (base, cookie, path, fields) => send(base, path, { method: 'POST', cookie, fields });
const getText = async (base, cookie, path) => (await send(base, path, { cookie })).text();
const count = (db, table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
const webRows = (db) => db.prepare("SELECT * FROM findings WHERE kind = 'web' ORDER BY id").all();
const idOf = (db, url) => db.prepare("SELECT id FROM findings WHERE kind = 'web' AND url = ?").get(url).id;

// De leesbare tekst van een pagina.
const readable = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

// Niets van de sleutel of de zoekopdracht mag in een pagina of een logregel staan.
function assertNoLeaks(texts, { query = false } = {}) {
  for (const text of texts) {
    assert.ok(!text.includes(KEY), 'de sleutel staat in de uitvoer');
    if (query) assert.ok(!/Anna de Vries/.test(text), 'de zoekopdracht staat in de uitvoer');
  }
}

// --- Zonder zoekdienst -------------------------------------------------------------------------

test('zonder zoekdienst zegt het dashboard dat eerlijk en is er geen knop om op het web te zoeken', async (t) => {
  const { base, cookie } = await setupNoSearch(t);
  const html = await getText(base, cookie, '/dashboard');
  const text = readable(html);

  assert.match(text, /Er is geen zoekdienst ingesteld/);
  assert.match(text, /BRAVE_API_KEY/);
  assert.doesNotMatch(html, /action="\/scan\/web"/);
  assert.doesNotMatch(text, /Voorbeeldstand|demo/i);
  // De rest werkt gewoon.
  assert.match(html, /action="\/scan\/datalekken"/);
  assert.match(html, /action="\/scan\/deep"/);
});

test('zonder zoekdienst geeft "zoek op het web" een duidelijke fout en bewaart het niets', async (t) => {
  const { base, cookie, db } = await setupNoSearch(t);
  const response = await post(base, cookie, '/scan/web');

  assert.equal(response.status, 503);
  assert.match(alertText(await response.text()), /Er is geen zoekdienst ingesteld/);
  assert.equal(webRows(db).length, 0);
  assert.equal(count(db, 'scans'), 0); // er is niets gezocht, dus ook niets "laatst gezocht"
});

test('zonder zoekdienst zegt de Deep Scan "niet beschikbaar" bij het web, en doet de rest wel', async (t) => {
  const { base, cookie, db, hibp } = await setupNoSearch(t);
  const response = await post(base, cookie, '/scan/deep');
  assert.equal(response.status, 303);

  const run = JSON.parse(db.prepare('SELECT steps FROM scan_runs').get().steps);
  const web = run.find((step) => step.id === 'web');
  assert.equal(web.status, 'unavailable');
  assert.deepEqual(web.sources, []);
  assert.match(web.note, /Er is geen zoekdienst ingesteld/);
  assert.ok(!web.demo);

  const breaches = run.find((step) => step.id === 'datalekken');
  assert.equal(breaches.status, 'done'); // de datalekken zijn wel gecontroleerd
  assert.equal(hibp.calls.length, 1);
  assert.equal(webRows(db).length, 0);

  const text = readable(await getText(base, cookie, '/resultaten?gescand=deep'));
  assert.match(text, /Niet beschikbaar/);
  assert.doesNotMatch(text, /Voltooid \(demo\)/);
});

test('zonder zoekdienst toont de resultatenpagina geen nepresultaten en zegt hij wat er mis is', async (t) => {
  const { base, cookie } = await setupNoSearch(t);
  const text = readable(await getText(base, cookie, '/resultaten'));

  assert.match(text, /Op het web/);
  assert.match(text, /Er is geen zoekdienst ingesteld\. Daarom zoeken we niet op het web, en verzinnen we ook niets/);
  assert.doesNotMatch(text, /Voorbeeldresultaten/);
  assert.doesNotMatch(text, /Je hebt nog niet gezocht\. Dat doe je op je dashboard\.\s*$/);
});

test('zonder zoekdienst staat de zoekdienst op de bronnenpagina als "niet ingesteld", niet als actief', async (t) => {
  const { base } = await setupNoSearch(t);
  const text = readable(await (await send(base, '/bronnen')).text());

  const index = text.indexOf('Zoekdienst voor het web');
  assert.ok(index > -1, 'de zoekdienst staat niet in het register');
  assert.match(text.slice(index, index + 400), /Niet ingesteld/);
});

test('de beheerder van een openbare site zonder zoekdienst krijgt dezelfde eerlijke fout', async (t) => {
  const { base, cookie, db } = await setupNoSearch(t, { production: true, ownerEmail: ANNA.email });
  const response = await post(base, cookie, '/scan/web');

  assert.equal(response.status, 503);
  assert.match(alertText(await response.text()), /Er is geen zoekdienst ingesteld/);
  assert.equal(webRows(db).length, 0);
});

// --- Met Brave ---------------------------------------------------------------------------------

test('Brave: één aanvraag met de sleutel in de header, en alleen je naam in de zoekopdracht', async (t) => {
  const { base, cookie, fetchFake } = await setupBrave(t);
  assert.equal((await post(base, cookie, '/profiel', { woonplaats: 'Utrecht' })).status, 303);
  const response = await post(base, cookie, '/scan/web');
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), '/resultaten?gescand=web#web');

  assert.equal(fetchFake.calls.length, 1);
  const { url, init } = fetchFake.calls[0];
  assert.equal(new URL(url).searchParams.get('q'), '"Anna de Vries" "Utrecht"');
  assert.equal(init.headers['X-Subscription-Token'], KEY);

  // Er gaat niets anders mee dan naam en woonplaats (in de zoekopdracht) en de vaste instellingen:
  // geen e-mailadres, geen wachtwoord, geen sleutel in de URL.
  assert.deepEqual([...new URL(url).searchParams.keys()].sort(),
    ['count', 'country', 'q', 'safesearch', 'text_decorations']);
  const sent = decodeURIComponent(`${url} ${JSON.stringify(init.headers)}`);
  assert.ok(!sent.includes('anna@example.com'), 'het e-mailadres gaat naar de zoekdienst');
  assert.ok(!sent.includes(ANNA.wachtwoord), 'het wachtwoord gaat naar de zoekdienst');
  assert.ok(!url.includes(KEY), 'de sleutel staat in de URL');
  assert.deepEqual(Object.keys(init.headers).sort(), ['Accept', 'User-Agent', 'X-Subscription-Token']);
});

test('Brave: resultaten worden bewaard als mogelijke overeenkomst, zonder HTML, met een einddatum van 30 minuten', async (t) => {
  const { base, cookie, db } = await setupBrave(t);
  await post(base, cookie, '/profiel', { woonplaats: 'Utrecht' });
  const before = Date.now();
  await post(base, cookie, '/scan/web');
  const after = Date.now();

  const rows = webRows(db);
  assert.equal(rows.length, 4);
  for (const row of rows) {
    assert.equal(row.source_id, 'brave');
    assert.equal(row.status, 'new');
    assert.ok(row.expires_at >= before + WEB_RESULT_MS && row.expires_at <= after + WEB_RESULT_MS, 'einddatum ≈ nu + 30 min');
    assert.ok(!row.details.includes('<strong>'), 'HTML in het fragment');
  }
  // Hoe zeker het is dat het over jou gaat, per resultaat. Volle naam en woonplaats is nog steeds maar
  // "gemiddeld": een naamgenoot in dezelfde plaats is mogelijk. Alleen het bevestigde e-mailadres van
  // het account in de tekst is een sterke aanwijzing.
  const byUrl = Object.fromEntries(rows.map((row) => [row.url, row.confidence]));
  assert.deepEqual(byUrl, {
    [FOTOGRAAF.url]: 'hoog',        // het e-mailadres van het account staat erin
    [LINKEDIN.url]: 'gemiddeld',    // naam + woonplaats
    [TELEFOONBOEK.url]: 'gemiddeld',
    [LEDENLIJST.url]: 'laag',       // wel de naam, niet de woonplaats
  });
  const fotograaf = rows.find((row) => row.url === FOTOGRAAF.url);
  const snippet = JSON.parse(fotograaf.details).snippet;
  assert.ok(snippet.includes('Anna de Vries uit Utrecht'), snippet);
  assert.ok(!/[<>]/.test(snippet), snippet);
});

test('een resultaat zonder je naam in titel of fragment krijgt geen overeenkomst, en wordt toch getoond', async (t) => {
  const zonderNaam = { title: 'Ledenlijst 2025', url: 'https://example.net/leden', description: 'Leden: A. de Vries, Utrecht.' };
  const { base, cookie, db } = await setupBrave(t, { answer: braveAnswer(zonderNaam) });
  await post(base, cookie, '/scan/web');

  assert.equal(webRows(db)[0].confidence, 'geen');
  const text = readable(await getText(base, cookie, '/resultaten?gescand=web'));
  assert.match(text, /Ledenlijst 2025/);
  assert.match(text, /Geen overeenkomst in titel of fragment/);
});

test('Brave: de resultatenpagina toont mogelijke overeenkomsten, gemaskeerde gegevens en het soort site', async (t) => {
  const { base, cookie } = await setupBrave(t);
  await post(base, cookie, '/profiel', { woonplaats: 'Utrecht' });
  await post(base, cookie, '/scan/web');
  const html = await getText(base, cookie, '/resultaten?gescand=web');
  const text = readable(html);

  // Wat voor soort site het lijkt.
  assert.match(text, /Sociale media/);
  assert.match(text, /Mogelijke personenzoeksite of telefoongids/);
  assert.match(text, /Openbaar document \(PDF\)/);
  // Gemaskeerde gegevens, met "jouw adres" erbij.
  assert.match(text, /Telefoonnummer \(mobiel\): \+31 6 •••• 5678/);
  assert.match(text, /Telefoonnummer \(vast\): \+31 •• •••• 4567/);
  assert.match(text, /E-mailadres: a•••@example\.com · komt overeen met het e-mailadres van je account/);
  assert.match(text, /Mogelijk een postcode: 35•• AB/);
  assert.match(text, /Het is een gok op basis van het uiterlijk\. Of het van jou is, bepaal jij\./);
  // Een mogelijke overeenkomst, geen zekerheid; en alles nog te beoordelen.
  assert.match(text, /Mogelijke overeenkomst|Sterke overeenkomst|Zwakke overeenkomst/);
  assert.match(text, /Dit zijn mogelijke vermeldingen van je naam, geen bewijs dat ze over jou gaan/);
  assert.match(text, /Nog te beoordelen: 4/);
  // De bewaartermijn staat er, en er is niets van een demo.
  assert.match(text, /De zoekdienst staat niet toe dat we resultaten bewaren\. Deze resultaten blijven zichtbaar tot uiterlijk \d{2}:\d{2}/);
  assert.doesNotMatch(text, /Voorbeeldresultaten|demo/i);
  // De sleutel staat nergens.
  assertNoLeaks([html]);
});

test('Brave: het dashboard zegt wat er naar Brave gaat en dat resultaten maar kort blijven staan', async (t) => {
  const { base, cookie } = await setupBrave(t);
  const html = await getText(base, cookie, '/dashboard');
  const text = readable(html);

  assert.match(text, /sturen we je naam als zoekopdracht naar Brave Search/);
  assert.match(text, /staat niet toe dat we resultaten bewaren, dus ze blijven 30 minuten zichtbaar/);
  assert.match(html, /action="\/scan\/web"/);
  assert.doesNotMatch(text, /Er is geen zoekdienst ingesteld|Voorbeeldstand/);
  assertNoLeaks([html]);
});

test('Brave: na een half uur zijn de resultaten weg, je keuze blijft, en een nieuwe zoekronde past hem weer toe', async (t) => {
  const { base, cookie, db, fetchFake } = await setupBrave(t);
  await post(base, cookie, '/scan/web');
  const clubId = idOf(db, LINKEDIN.url);
  assert.equal((await post(base, cookie, `/resultaten/${clubId}`, { status: 'mine' })).status, 303);

  // Dertig minuten later: de resultaten zijn verlopen (de opruimtimer is nog niet langs geweest).
  db.prepare('UPDATE findings SET expires_at = ?').run(Date.now() - 1000);
  const expired = readable(await getText(base, cookie, '/resultaten'));
  assert.match(expired, /De resultaten van die zoekopdracht zijn verlopen/);
  assert.match(expired, /Wat je eerder koos \(Dit ben ik, Dit ben ik niet\), onthouden we/);
  assert.doesNotMatch(expired, /Fotograaf in Utrecht|Ledenlijst 2025/);

  // Een verlopen resultaat kun je niet meer beoordelen.
  assert.equal((await post(base, cookie, `/resultaten/${clubId}`, { status: 'not_mine' })).status, 404);
  assert.equal(db.prepare('SELECT status FROM web_choices').get().status, 'mine');

  // Opnieuw zoeken: dezelfde vier resultaten, en wat je koos geldt nog.
  assert.equal((await post(base, cookie, '/scan/web')).status, 303);
  assert.equal(fetchFake.calls.length, 2);
  const text = readable(await getText(base, cookie, '/resultaten?gescand=web'));
  assert.match(text, /1 resultaat door jou bevestigd als "Dit ben ik"/);
  assert.match(text, /Nog te beoordelen: 3/);
  const rows = webRows(db);
  assert.equal(rows.find((row) => row.url === LINKEDIN.url).status, 'mine');
  assert.equal(rows.filter((row) => row.status === 'new').length, 3);
});

test('Brave met opslagrechten: resultaten krijgen geen einddatum en er staat geen bewaartermijn bij', async (t) => {
  const { base, cookie, db } = await setupBrave(t, { storageRights: true });
  await post(base, cookie, '/scan/web');

  assert.ok(webRows(db).every((row) => row.expires_at === null));
  const text = readable(await getText(base, cookie, '/resultaten?gescand=web'));
  assert.doesNotMatch(text, /blijven zichtbaar tot uiterlijk/);
  assert.doesNotMatch(readable(await getText(base, cookie, '/dashboard')), /30 minuten zichtbaar/);
});

test('Brave: de Deep Scan noemt Brave als bron en de bewaartermijn, en het is geen demo', async (t) => {
  const { base, cookie, db } = await setupBrave(t);
  await post(base, cookie, '/scan/deep');

  const run = JSON.parse(db.prepare('SELECT steps FROM scan_runs').get().steps);
  const web = run.find((step) => step.id === 'web');
  assert.equal(web.status, 'done');
  assert.deepEqual(web.sources, ['brave']);
  assert.ok(!web.demo);
  assert.equal(web.found, 4);
  assert.match(web.note, /4 mogelijke vermeldingen gevonden/);
  assert.match(web.note, /blijven 30 minuten zichtbaar, jouw keuzes blijven/);
});

// --- Als Brave het laat afweten ----------------------------------------------------------------

const BRAVE_FOUTEN = [
  ['401 → de sleutel is niet geaccepteerd', () => jsonResponse(401, { error: 'x' }), 502, /accepteerde de sleutel niet\. Controleer BRAVE_API_KEY/],
  ['403 → de sleutel is niet geaccepteerd', () => jsonResponse(403, { error: 'x' }), 502, /accepteerde de sleutel niet/],
  ['429 → de limiet of het tegoed is op', () => jsonResponse(429, { error: 'x' }), 429, /geen aanvragen meer toe: de limiet of het tegoed is op/],
  ['402 → het tegoed is op', () => jsonResponse(402, { error: 'x' }), 429, /limiet of het tegoed is op/],
  ['500 → Brave is er niet', () => jsonResponse(500, { error: 'x' }), 502, /De zoekdienst is nu niet bereikbaar/],
  ['geen JSON → onverwacht antwoord', () => new Response('<html>oeps</html>', { status: 200 }), 502, /onverwacht antwoord/],
  ['verkeerde vorm → onverwacht antwoord', () => jsonResponse(200, { web: { results: 'nee' } }), 502, /onverwacht antwoord/],
];

for (const [naam, answer, status, melding] of BRAVE_FOUTEN) {
  test(`Brave ${naam}: een nette melding, niets bewaard, en geen sleutel of naam in pagina of logboek`, async (t) => {
    const { base, cookie, db, logs } = await setupBrave(t, { answer });
    const response = await post(base, cookie, '/scan/web');
    const html = await response.text();

    assert.equal(response.status, status);
    assert.match(alertText(html), melding);
    assert.equal(webRows(db).length, 0);
    assert.equal(count(db, 'scans'), 0); // geen "laatst gezocht" na een mislukte poging
    assertNoLeaks([html, ...logs], { query: true });
    assert.ok(!logs.some((line) => line.includes(KEY)));
  });
}

test('Brave die faalt tijdens de Deep Scan: die stap staat als "niet toegankelijk", de rest loopt door', async (t) => {
  const { base, cookie, db, logs } = await setupBrave(t, { answer: () => jsonResponse(429, { error: 'x' }) });
  await post(base, cookie, '/scan/deep');

  const run = JSON.parse(db.prepare('SELECT steps FROM scan_runs').get().steps);
  const web = run.find((step) => step.id === 'web');
  assert.equal(web.status, 'unreachable');
  assert.match(web.note, /De zoekdienst staat nu geen aanvragen meer toe/);
  assert.equal(run.find((step) => step.id === 'datalekken').status, 'done');
  assert.equal(webRows(db).length, 0);
  const text = readable(await getText(base, cookie, '/resultaten?gescand=deep'));
  assert.match(text, /Niet toegankelijk/);
  assertNoLeaks([text, ...logs], { query: true });
});

test('Brave die niets vindt: dat zeggen we, zonder iets te verzinnen', async (t) => {
  const { base, cookie, db } = await setupBrave(t, { answer: () => jsonResponse(200, { type: 'search', query: { original: 'x' } }) });
  const response = await post(base, cookie, '/scan/web');
  assert.equal(response.status, 303);

  assert.equal(webRows(db).length, 0);
  const text = readable(await getText(base, cookie, '/resultaten?gescand=web'));
  assert.match(text, /De zoekdienst vond niets bij deze zoekopdracht/);
  assert.doesNotMatch(text, /expired|verlopen/);
});
