// Tests voor het opbouwen van de zoekopdracht, het opschonen van resultaten en de zoekdiensten
// (de demo en Brave Search, die hier met een nep-fetch getest wordt en niets naar buiten stuurt).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ScanError } from '../src/scan-error.js';
import { jsonResponse } from './helpers.js';
import {
  buildQuery, cleanName, cleanResults, createBraveSearch, createDemoSearch, createSearch, parseCity,
  parseStorageRights,
} from '../src/search.js';

// Een zoekopdracht bestaat uit hooguit twee stukken tekst tussen aanhalingstekens.
// Wat erin staat is gewoon tekst; er staat niets buiten dat een zoekdienst als
// operator (OR, -, site:) zou kunnen lezen.
const ONLY_QUOTED_PHRASES = /^"[^"]+"( "[^"]+")?$/;

test('cleanName houdt letters, spaties, apostrofs, punten en streepjes over', () => {
  assert.equal(cleanName('Anna de Vries'), 'Anna de Vries');
  assert.equal(cleanName("Jan van 't Hoff"), "Jan van 't Hoff");
  assert.equal(cleanName('Zoë Müller-Łukasz'), 'Zoë Müller-Łukasz');
  assert.equal(cleanName('  Anna \t\n de   Vries  '), 'Anna de Vries');
  assert.equal(cleanName('St. Anna'), 'St. Anna');
});

test('cleanName haalt aanhalingstekens, zoekoperatoren en vreemde tekens weg', () => {
  assert.equal(cleanName('Anna "de" Vries'), 'Anna de Vries');
  assert.equal(cleanName('Anna -Vries'), 'Anna Vries'); // geen "sluit dit woord uit"
  assert.equal(cleanName('-Anna --Vries'), 'Anna Vries');
  assert.equal(cleanName('Anna site:evil.example (de)'), 'Anna site evil.example de');
  assert.equal(cleanName('Anna 😀 Vries'), 'Anna Vries');
  assert.equal(cleanName('<b>Anna</b>'), 'b Anna b');
});

test('cleanName kapt af op de maximale lengte en kan tegen lege invoer', () => {
  assert.equal(cleanName('a'.repeat(200)).length, 80);
  assert.equal(cleanName('a'.repeat(200), 10), 'a'.repeat(10));
  assert.equal(cleanName(null), '');
  assert.equal(cleanName(undefined), '');
  assert.equal(cleanName(42), '');
});

test('buildQuery zet naam en woonplaats tussen aanhalingstekens', () => {
  assert.equal(buildQuery({ name: 'Anna de Vries', city: 'Utrecht' }), '"Anna de Vries" "Utrecht"');
  assert.equal(buildQuery({ name: 'Anna de Vries', city: null }), '"Anna de Vries"');
  assert.equal(buildQuery({ name: 'Anna de Vries', city: '' }), '"Anna de Vries"');
  assert.equal(buildQuery({ name: 'Anna de Vries' }), '"Anna de Vries"');
});

test('buildQuery: een naam of woonplaats kan geen zoekoperator of tweede zoekterm worden', () => {
  const evil = [
    { name: 'Anna de Vries', city: 'OR Jan Jansen' },
    { name: 'Anna de Vries', city: 'Ut" OR "Jan Jansen' },
    { name: 'Anna de Vries', city: '-Utrecht' },
    { name: 'Anna de Vries', city: 'Utrecht site:evil.example' },
    { name: 'Anna" OR "Jan Jansen', city: 'Utrecht' },
    { name: '"Anna de Vries" -Vries filetype:pdf', city: null },
  ];
  for (const input of evil) {
    const query = buildQuery(input);
    assert.match(query, ONLY_QUOTED_PHRASES, JSON.stringify(input));
  }
  // Wat er van een "woonplaats" als OR Jan Jansen overblijft, is één zin die ook op de pagina moet staan.
  assert.equal(buildQuery({ name: 'Anna de Vries', city: 'OR Jan Jansen' }), '"Anna de Vries" "OR Jan Jansen"');
});

test('buildQuery geeft niets terug als er te weinig letters in de naam zitten', () => {
  for (const name of ['', ' ', 'A', '1234', '--', '"', '😀😀', null, undefined]) {
    assert.equal(buildQuery({ name, city: 'Utrecht' }), null, String(name));
  }
  assert.equal(buildQuery({ name: 'Li', city: null }), '"Li"');
});

test('parseCity: geldige woonplaatsen, leeg en ongeldig', () => {
  assert.deepEqual(parseCity('  Utrecht '), { city: 'Utrecht' });
  assert.deepEqual(parseCity('Bergen   op Zoom'), { city: 'Bergen op Zoom' });
  assert.deepEqual(parseCity("'s-Hertogenbosch"), { city: "'s-Hertogenbosch" });
  assert.deepEqual(parseCity(''), { city: null });
  assert.deepEqual(parseCity(undefined), { city: null });
  for (const bad of ['Utrecht 3584', '<b>x</b>', '"Utrecht"', '-Utrecht', 'a/b', 'x'.repeat(61)]) {
    assert.match(parseCity(bad).error, /alleen letters/, bad);
  }
});

test('cleanResults haalt tags weg, ontsmet adressen en laat dubbelen vallen', () => {
  const results = cleanResults([
    { title: '<b>Hoi</b> &amp; dag', url: 'https://example.org/a', snippet: '<i>tekst</i> met <script>x</script>' },
    { title: 'dubbel', url: 'https://example.org/a', snippet: 'nog een keer' },
    { title: 'js', url: 'javascript:alert(1)' },
    { title: 'data', url: 'data:text/html,<script>alert(1)</script>' },
    { title: 'ftp', url: 'ftp://example.org/bestand' },
    { title: 'wachtwoord', url: 'https://gebruiker:geheim@example.org/' },
    { title: 'geen adres', url: 'dit is geen adres' },
    { title: 'zonder adres' },
    { url: 42 },
    null,
    'tekst',
    { title: '', url: 'http://example.org/zonder-titel', snippet: undefined },
  ]);

  assert.deepEqual(results, [
    { title: 'Hoi & dag', url: 'https://example.org/a', snippet: 'tekst met x' },
    { title: 'http://example.org/zonder-titel', url: 'http://example.org/zonder-titel', snippet: '' },
  ]);
});

test('cleanResults behandelt hetzelfde adres in verschillende schrijfwijzen als één', () => {
  const results = cleanResults([
    { title: 'een', url: 'https://EXAMPLE.org' },
    { title: 'twee', url: 'https://example.org/' },
  ]);
  assert.equal(results.length, 1);
  assert.equal(results[0].url, 'https://example.org/');
});

test('cleanResults kapt titels, teksten en adressen af en houdt hooguit max resultaten over', () => {
  const [long] = cleanResults([{ title: 't'.repeat(500), url: 'https://example.org/', snippet: 's'.repeat(2000) }]);
  assert.ok(long.title.length <= 200);
  assert.ok(long.snippet.length <= 400);

  assert.deepEqual(cleanResults([{ title: 'x', url: `https://example.org/${'a'.repeat(2100)}` }]), []);

  const many = Array.from({ length: 30 }, (_, i) => ({ title: `t${i}`, url: `https://example.org/${i}` }));
  assert.equal(cleanResults(many).length, 20);
  assert.equal(cleanResults(many, 5).length, 5);
  assert.equal(cleanResults(many)[0].title, 't0'); // de volgorde van de zoekdienst blijft
});

test('cleanResults tegen iets wat geen lijst is', () => {
  for (const value of [undefined, null, 'tekst', 42, {}, { length: 3 }]) {
    assert.deepEqual(cleanResults(value), []);
  }
});

test('de demo-zoekdienst verzint vijf resultaten op voorbeelddomeinen en stuurt niets naar buiten', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('de demo mag het netwerk niet gebruiken');
  });
  const demo = createDemoSearch();
  const results = await demo.search({ query: '"Anna de Vries" "Utrecht"', name: 'Anna de Vries', city: 'Utrecht' });

  assert.equal(demo.isDemo, true);
  assert.equal(results.length, 5);
  assert.ok(results.every((r) => r.title.includes('Anna de Vries') || r.title.includes('Anna')));
  assert.ok(results.some((r) => r.title.includes('Utrecht')), 'de woonplaats komt in een resultaat terug');
  for (const { url } of results) {
    assert.match(new URL(url).hostname, /^example\.(org|net|com)$/, url);
  }
  assert.equal(fetchMock.mock.callCount(), 0);

  // Wat de demo teruggeeft, komt ongeschonden door cleanResults.
  assert.equal(cleanResults(results).length, 5);
});

test('de demo-zoekdienst werkt ook zonder woonplaats', async () => {
  const results = await createDemoSearch().search({ query: '"Bram Bakker"', name: 'Bram Bakker', city: '' });
  assert.equal(results.length, 5);
  assert.ok(results.every((r) => !r.title.includes(' in ')));
});

test('createSearch: geen instelling is geen zoekdienst, en wat we niet kennen weigeren we', () => {
  assert.equal(createSearch(), null);        // zonder zoekdienst zoekt de app niet, en verzint hij niets
  assert.equal(createSearch(''), null);
  assert.equal(createSearch('  '), null);
  assert.equal(createSearch('none'), null);
  assert.equal(createSearch('demo').isDemo, true);
  assert.equal(createSearch('DEMO').name, 'demo');
  assert.throws(() => createSearch('google'), /Onbekende zoekdienst "google"/);
  assert.throws(() => createSearch('google'), /"brave", "demo" of "none"/);
});

test('createSearch kiest Brave zodra er een sleutel is, tenzij je zelf iets anders kiest', () => {
  assert.equal(createSearch('', { braveKey: SLEUTEL }).id, 'brave');     // automatisch
  assert.equal(createSearch('brave', { braveKey: SLEUTEL }).id, 'brave');
  assert.equal(createSearch('Brave', { braveKey: SLEUTEL }).id, 'brave');
  assert.equal(createSearch('demo', { braveKey: SLEUTEL }).isDemo, true); // een bewuste keuze wint
  assert.equal(createSearch('none', { braveKey: SLEUTEL }), null);
  // Brave kiezen zonder sleutel kan niet: de server stopt dan met een duidelijke melding.
  assert.throws(() => createSearch('brave'), /BRAVE_API_KEY/);
  assert.throws(() => createSearch('brave', { braveKey: '  ' }), /BRAVE_API_KEY/);
});

test('Brave mag standaard geen resultaten bewaren, behalve met opslagrechten', () => {
  assert.equal(createSearch('brave', { braveKey: SLEUTEL }).retainsResults, false);
  assert.equal(createSearch('brave', { braveKey: SLEUTEL, storageRights: true }).retainsResults, true);
  assert.equal(createDemoSearch().retainsResults, true); // de demo verzint alles: daar valt niets te schenden
});

test('parseStorageRights: leeg en uit is nee, aan is ja, en een typfout stopt de server', () => {
  for (const nee of [undefined, null, '', ' ', 'off', 'OFF', 'false', '0', 'uit', 'nee']) {
    assert.equal(parseStorageRights(nee), false, String(nee));
  }
  for (const ja of ['on', 'ON', ' on ', 'true', '1', 'aan', 'ja']) {
    assert.equal(parseStorageRights(ja), true, ja);
  }
  for (const fout of ['onn', 'maybe', 'yes please', '2']) {
    assert.throws(() => parseStorageRights(fout), /BRAVE_STORAGE_RIGHTS moet "on" of "off" zijn/, fout);
  }
});

// --- Brave Search ---------------------------------------------------------------------------
// Alles met een nep-fetch: deze tests sturen niets naar het internet. Hoe Brave in het echt
// antwoordt, controleer je met `npm run controleer` (zie de README).

const SLEUTEL = 'BSA-test-sleutel-0123456789';
const QUERY = '"Anna de Vries" "Utrecht"';

const BRAVE_ANSWER = {
  type: 'search',
  query: { original: QUERY },
  web: {
    type: 'search',
    results: [
      { title: 'Anna de Vries - Fotograaf', url: 'https://example.org/anna', description: 'Fotograaf in <strong>Utrecht</strong>.' },
      { title: 'Clubuitslagen', url: 'https://example.net/club', description: 'Anna de Vries werd tweede.', extra: 'wordt genegeerd' },
    ],
  },
};

// Een nep-fetch voor Brave. Hij onthoudt elke aanvraag (calls) en antwoordt met `answer`.
function fakeBraveFetch(answer = () => jsonResponse(200, BRAVE_ANSWER)) {
  const fake = {
    calls: [],
    async impl(url, init) {
      fake.calls.push({ url: String(url), init });
      return answer(url, init);
    },
  };
  return fake;
}

function brave(options = {}) {
  const logs = [];
  const fetchFake = options.fetch ?? fakeBraveFetch();
  const search = createBraveSearch({
    apiKey: SLEUTEL, fetchImpl: fetchFake.impl, minIntervalMs: 0, log: (line) => logs.push(line), ...options.config,
  });
  return { search, logs, fetchFake };
}

const ask = (search) => search.search({ query: QUERY, name: 'Anna de Vries', city: 'Utrecht' });

test('Brave: de aanvraag is een GET met de sleutel in de header en de zoekopdracht als q', async () => {
  const { search, fetchFake } = brave();
  const results = await ask(search);

  assert.equal(fetchFake.calls.length, 1);
  const { url, init } = fetchFake.calls[0];
  const parsed = new URL(url);
  assert.equal(`${parsed.origin}${parsed.pathname}`, 'https://api.search.brave.com/res/v1/web/search');
  assert.equal(parsed.searchParams.get('q'), QUERY);          // met de aanhalingstekens erin
  assert.equal(parsed.searchParams.get('count'), '20');
  assert.equal(parsed.searchParams.get('country'), 'NL');
  assert.equal(parsed.searchParams.get('safesearch'), 'moderate');
  assert.equal(parsed.searchParams.get('text_decorations'), 'false');
  assert.equal(init.headers['X-Subscription-Token'], SLEUTEL);
  assert.equal(init.headers.Accept, 'application/json');
  assert.equal(init.redirect, 'error');                       // een omleiding volgen we niet: de sleutel gaat niet mee naar elders
  assert.ok(init.signal instanceof AbortSignal);              // er is een tijdslimiet
  assert.equal(init.method, undefined);                       // GET
  assert.ok(!url.includes(SLEUTEL), 'de sleutel staat nooit in de URL');

  assert.deepEqual(results, [
    { title: 'Anna de Vries - Fotograaf', url: 'https://example.org/anna', snippet: 'Fotograaf in <strong>Utrecht</strong>.' },
    { title: 'Clubuitslagen', url: 'https://example.net/club', snippet: 'Anna de Vries werd tweede.' },
  ]);
  // De opschoning (tags weg, alleen http/https) doet scanWeb met cleanResults.
  assert.equal(cleanResults(results)[0].snippet, 'Fotograaf in Utrecht .');
});

test('Brave: zonder resultaten is er een lege lijst, en een onbegrijpelijk antwoord is een fout', async () => {
  const empty = (body) => brave({ fetch: fakeBraveFetch(() => jsonResponse(200, body)) }).search;
  // Brave laat "web" weg als er niets gevonden is, of geeft een lege lijst.
  assert.deepEqual(await ask(empty({ type: 'search', query: { original: QUERY } })), []);
  assert.deepEqual(await ask(empty({ query: { original: QUERY }, mixed: {} })), []);
  assert.deepEqual(await ask(empty({ type: 'search', web: { type: 'search', results: [] } })), []);
  assert.deepEqual(await ask(empty({ type: 'search', web: {} })), []);

  // Alles wat niet op een zoekantwoord lijkt, melden we als fout. "Niets gevonden" zeggen terwijl we
  // het antwoord niet begrijpen, zou een leugen zijn.
  for (const body of [{}, [], 'tekst', 42, null, { web: null }, { web: 'x' }, { web: [] }, { web: { results: 'x' } }, { web: { results: {} } }]) {
    await assert.rejects(ask(empty(body)), { code: 'unexpected' }, JSON.stringify(body));
  }
});

test('Brave: resultaten zonder titel, adres of beschrijving komen door, en cleanResults gooit de kapotte weg', async () => {
  const kapot = { web: { results: [{ title: 'A', url: 'https://example.org/a' }, null, 'x', { title: 'B' }, { url: 'javascript:alert(1)', title: 'C' }] } };
  const { search } = brave({ fetch: fakeBraveFetch(() => jsonResponse(200, kapot)) });
  const results = await ask(search);
  assert.equal(results.length, 5);
  assert.deepEqual(cleanResults(results).map((r) => r.url), ['https://example.org/a']);
});

test('Brave: elke fout krijgt een vaste soort, en de details blijven bij de beheerder', async () => {
  const cases = [
    [401, 'bad_key'], [403, 'bad_key'], [402, 'rate_limited'], [429, 'rate_limited'],
    [500, 'unavailable'], [502, 'unavailable'], [503, 'unavailable'], [504, 'unavailable'],
    [400, 'unexpected'], [404, 'unexpected'], [422, 'unexpected'], [418, 'unexpected'],
  ];
  for (const [status, code] of cases) {
    const { search } = brave({ fetch: fakeBraveFetch(() => jsonResponse(status, { error: 'iets met geheime details' })) });
    await assert.rejects(ask(search), (error) => {
      assert.ok(error instanceof ScanError, `${status}: een ScanError`);
      assert.equal(error.code, code, String(status));
      assert.equal(error.message, code); // geen details in de melding
      return true;
    }, String(status));
  }
});

test('Brave: een netwerkfout, een time-out of een omleiding is "niet bereikbaar"', async () => {
  for (const failure of [new TypeError('fetch failed'), new DOMException('timeout', 'TimeoutError'), new Error('ECONNRESET')]) {
    const { search } = brave({ fetch: fakeBraveFetch(() => { throw failure; }) });
    await assert.rejects(ask(search), { code: 'unavailable' }, failure.message);
  }
});

test('Brave: een antwoord dat geen JSON is, is een onverwacht antwoord', async () => {
  const { search } = brave({ fetch: fakeBraveFetch(() => new Response('<html>Gateway</html>', { status: 200 })) });
  await assert.rejects(ask(search), { code: 'unexpected' });
});

test('Brave: de sleutel en de zoekopdracht komen nergens in een logregel of foutmelding', async () => {
  for (const status of [401, 429, 400]) {
    const { search, logs } = brave({ fetch: fakeBraveFetch(() => jsonResponse(status, { echo: QUERY, key: SLEUTEL })) });
    const error = await ask(search).catch((caught) => caught);
    for (const text of [...logs, error.message, String(error.stack).split('\n')[0]]) {
      assert.ok(!text.includes(SLEUTEL), `${status}: de sleutel staat in ${text}`);
      assert.ok(!text.includes('Anna de Vries'), `${status}: de naam staat in ${text}`);
      assert.ok(!text.includes('Utrecht'), `${status}: de woonplaats staat in ${text}`);
    }
    if (status !== 400) assert.ok(logs.length >= 1, `${status}: de beheerder krijgt wel een hint`);
  }
  // En bij een geslaagde zoekopdracht wordt er helemaal niets gelogd.
  const ok = brave();
  await ask(ok.search);
  assert.deepEqual(ok.logs, []);
});

test('Brave: een sleutel moet er als een sleutel uitzien', () => {
  assert.throws(() => createBraveSearch({}), /BRAVE_API_KEY/);
  assert.throws(() => createBraveSearch({ apiKey: '' }), /BRAVE_API_KEY/);
  assert.throws(() => createBraveSearch({ apiKey: '   ' }), /BRAVE_API_KEY/);
  for (const slecht of ['kort', 'met spatie in', '"aanhalingstekens-eromheen"', 'regel\neinde-0123456789', 'x'.repeat(201)]) {
    assert.throws(() => createBraveSearch({ apiKey: slecht }), /ziet er niet goed uit/, slecht);
  }
  // Spaties eromheen (een slordige kopie) zijn geen probleem.
  assert.doesNotThrow(() => createBraveSearch({ apiKey: `  ${SLEUTEL}  ` }));
});

test('Brave: de aanvragen krijgen een pauze, zodat we onder de limiet per seconde blijven', async () => {
  const klok = t0();
  const { search } = brave({ config: { minIntervalMs: 60 } });
  await ask(search);
  await ask(search);
  assert.ok(Date.now() - klok >= 55, 'de tweede aanvraag wacht even');
});

const t0 = () => Date.now();

test('Brave: het is een echte bron (geen demo) met een naam en een adres', () => {
  const { search } = brave();
  assert.equal(search.isDemo, false);
  assert.equal(search.id, 'brave');
  assert.equal(search.label, 'Brave Search');
  assert.equal(search.url, 'https://search.brave.com');
});

