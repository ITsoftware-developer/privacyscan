// Tests voor `npm run controleer` (scripts/controleer-bronnen.js): de proef met de echte bronnen.
// Hier met nagemaakte antwoorden, want de tests sturen niets naar buiten. Wat telt: de uitkomst is
// duidelijk, en er komt nooit een sleutel, zoekopdracht met een naam of e-mailadres in de uitvoer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runChecks } from '../scripts/controleer-bronnen.js';
import { fakeBraveFetch, fakeXonFetch, jsonResponse, xonFound } from './helpers.js';

const KEY = 'BSA-test-sleutel-0123456789';
const OWN = 'iemand.eigen@voorbeeld.nl';

const BRAVE_OK = {
  type: 'search',
  web: {
    type: 'search',
    results: [
      { title: 'Domtoren - Utrecht', url: 'https://example.org/domtoren', description: 'De Domtoren in Utrecht.' },
      { title: 'Utrecht bezienswaardigheden', url: 'https://example.net/utrecht', description: 'Wat te doen in Utrecht.' },
    ],
  },
};
const braveOk = (headers = {}) => () => new Response(JSON.stringify(BRAVE_OK), {
  status: 200, headers: { 'content-type': 'application/json', ...headers },
});

// Eén nep-fetch voor allebei de diensten: hij kijkt naar het adres waar de aanvraag heen gaat.
function setup({ brave = braveOk(), xon = {} } = {}) {
  const braveFake = fakeBraveFetch(brave);
  const xonFake = fakeXonFetch(xon);
  const hosts = [];
  const fetchImpl = async (url, init) => {
    const { hostname } = new URL(String(url));
    hosts.push(hostname);
    if (hostname === 'api.search.brave.com') return braveFake.impl(url, init);
    if (hostname === 'api.xposedornot.com') return xonFake.impl(String(url), init);
    throw new Error(`onverwachte host: ${hostname}`);
  };
  return { braveFake, xonFake, hosts, fetchImpl };
}

async function run(options = {}, { env = { BRAVE_API_KEY: KEY }, argv = [] } = {}) {
  const fakes = setup(options);
  const lines = [];
  const logs = [];
  const problems = await runChecks({
    env,
    argv,
    fetchImpl: fakes.fetchImpl,
    out: (line) => lines.push(line),
    braveOptions: { minIntervalMs: 0, log: (line) => logs.push(String(line)) },
    xonOptions: { minIntervalMs: 0, log: (line) => logs.push(String(line)) },
  });
  return { ...fakes, problems, lines, logs, text: lines.join('\n') };
}

// Nergens in de uitvoer of de logregels staat een sleutel of een adres van jou.
function assertClean(result, extra = []) {
  for (const geheim of [KEY, OWN, 'controle@example.com', ...extra]) {
    assert.ok(!result.text.includes(geheim), `"${geheim}" staat in de uitvoer`);
    assert.ok(!result.logs.some((line) => line.includes(geheim)), `"${geheim}" staat in het logboek`);
  }
}

test('alles in orde: beide bronnen werken, 0 problemen, en de uitvoer zegt dat', async () => {
  const result = await run({ brave: braveOk({ 'x-ratelimit-remaining': '1, 998' }) });

  assert.equal(result.problems, 0);
  assert.match(result.text, /Brave Search \(zoeken op het web\)\n  OK: de sleutel werkt en 2 resultaten zijn gelezen\./);
  assert.match(result.text, /Aanvragen die Brave nog toestaat \(per seconde, per maand\): 1, 998\./);
  assert.match(result.text, /XposedOrNot \(datalekken, gratis\)\n  OK: de lijst met bekende lekken is gelezen \(\d+ lekken\)\./);
  assert.match(result.text, /OK: het antwoord op een controle van een adres is gelezen/);
  assert.match(result.text, /Alles wat is ingesteld werkt\./);
  assertClean(result);
});

test('de proef stuurt een neutrale zoekopdracht naar Brave, de sleutel in de header en niets anders', async () => {
  const result = await run();

  assert.equal(result.braveFake.calls.length, 1);
  const { url, init } = result.braveFake.calls[0];
  assert.equal(new URL(url).searchParams.get('q'), '"Domtoren" "Utrecht"');
  assert.equal(init.headers['X-Subscription-Token'], KEY);
  assert.ok(!url.includes(KEY));
  // XposedOrNot: de lijst en één adres, dus twee aanvragen.
  assert.equal(result.xonFake.calls.length, 2);
  assert.deepEqual([...new Set(result.hosts)].sort(), ['api.search.brave.com', 'api.xposedornot.com']);
});

test('zonder BRAVE_API_KEY wordt Brave overgeslagen, zonder aanvraag en zonder dat het een probleem is', async () => {
  const result = await run({}, { env: {} });

  assert.equal(result.problems, 0);
  assert.equal(result.braveFake.calls.length, 0);
  assert.match(result.text, /Overgeslagen: er staat geen BRAVE_API_KEY in je \.env/);
  assert.match(result.text, /Zonder zoekdienst zoekt de site niet op het web/);
  for (const leeg of ['', '   ']) {
    const again = await run({}, { env: { BRAVE_API_KEY: leeg } });
    assert.equal(again.braveFake.calls.length, 0, JSON.stringify(leeg));
  }
});

test('met je eigen adres wordt dat bij XposedOrNot gecontroleerd, en het adres staat nergens in de uitvoer', async () => {
  const gevonden = await run({ xon: { email: () => jsonResponse(200, xonFound('Adobe')) } }, { argv: [OWN] });
  assert.equal(gevonden.problems, 0);
  assert.match(gevonden.text, /je eigen adres is gecontroleerd: het staat in 1 bekend lek/);
  assert.ok(gevonden.xonFake.calls.some((call) => call.url.includes(encodeURIComponent(OWN))));
  assert.doesNotMatch(gevonden.text, /Tip: geef je eigen adres mee/);
  assertClean(gevonden);

  const nergens = await run({ xon: { email: () => jsonResponse(404, { Error: 'Not found' }) } }, { argv: [OWN] });
  assert.equal(nergens.problems, 0);
  assert.match(nergens.text, /XposedOrNot kent het niet uit een lek/);
  assertClean(nergens);
});

test('een argument dat geen e-mailadres is, wordt genegeerd', async () => {
  const result = await run({}, { argv: ['--verbose', 'geen-adres', 'x@y'] });
  assert.equal(result.problems, 0);
  assert.ok(result.xonFake.calls.every((call) => !call.url.includes('geen-adres')));
  assert.match(result.text, /met een voorbeeldadres/);
});

// --- Brave laat het afweten --------------------------------------------------------------------

const BRAVE_FOUTEN = [
  ['401', () => jsonResponse(401, {}), /Probleem: Brave weigert de sleutel/],
  ['403', () => jsonResponse(403, {}), /Probleem: Brave weigert de sleutel/],
  ['429', () => jsonResponse(429, {}), /Probleem: Brave staat geen aanvragen meer toe .*tegoed of de limiet is op/],
  ['402', () => jsonResponse(402, {}), /Probleem: Brave staat geen aanvragen meer toe/],
  ['500', () => jsonResponse(500, {}), /Probleem: Brave is niet bereikbaar/],
  ['geen JSON', () => new Response('<html>nee</html>', { status: 200 }), /Probleem: Brave gaf een antwoord dat de koppeling niet kan lezen/],
  ['verkeerde vorm', () => jsonResponse(200, { web: { results: 'nee' } }), /Probleem: Brave gaf een antwoord dat de koppeling niet kan lezen/],
];

for (const [naam, answer, melding] of BRAVE_FOUTEN) {
  test(`Brave ${naam}: een duidelijk probleem, afsluiten met een fout, en geen sleutel in de uitvoer`, async () => {
    const result = await run({ brave: answer });
    assert.equal(result.problems, 1);
    assert.match(result.text, melding);
    assert.match(result.text, /Er is 1 probleem gevonden\. Los dat op en draai dit script opnieuw\./);
    assert.doesNotMatch(result.text, /Alles wat is ingesteld werkt/);
    assertClean(result);
  });
}

test('een antwoord van Brave zonder één bruikbaar resultaat telt als probleem', async () => {
  const result = await run({ brave: () => jsonResponse(200, { type: 'search', web: { type: 'search', results: [] } }) });
  assert.equal(result.problems, 1);
  assert.match(result.text, /zonder één bruikbaar resultaat/);
});

test('een sleutel die er niet goed uitziet geeft een melding zonder de sleutel zelf te noemen', async () => {
  const slecht = 'GEHEIM"SLEUTEL met spaties';
  const result = await run({}, { env: { BRAVE_API_KEY: slecht } });

  assert.equal(result.problems, 1);
  assert.equal(result.braveFake.calls.length, 0);
  assert.match(result.text, /Probleem: BRAVE_API_KEY ziet er niet goed uit/);
  assertClean(result, ['GEHEIM', 'SLEUTEL']);
});

test('de tellers van Brave worden alleen getoond als het getallen zijn', async () => {
  const vreemd = await run({ brave: braveOk({ 'x-ratelimit-remaining': '<script>alert(1)</script>' }) });
  assert.doesNotMatch(vreemd.text, /script|Aanvragen die Brave nog toestaat/);
  const zonder = await run({ brave: braveOk() });
  assert.doesNotMatch(zonder.text, /Aanvragen die Brave nog toestaat/);
  assert.equal(zonder.problems, 0);
});

// --- XposedOrNot laat het afweten --------------------------------------------------------------

test('XposedOrNot dat de limiet meldt: twee problemen worden apart genoemd en geteld', async () => {
  const result = await run({ xon: { email: () => jsonResponse(429, {}), list: () => jsonResponse(429, {}) } });

  assert.equal(result.problems, 2);
  assert.match(result.text, /Probleem met de lijst met lekken: XposedOrNot staat geen aanvragen meer toe/);
  assert.match(result.text, /Probleem bij het controleren van een adres: XposedOrNot staat geen aanvragen meer toe/);
  assert.match(result.text, /Er zijn 2 problemen gevonden/);
  assertClean(result);
});

test('een lijst van XposedOrNot in een formaat dat we niet kennen telt als probleem, en de rest loopt door', async () => {
  // Het adres staat in geen enkel lek (404), dus de adrescontrole heeft de lijst niet nodig en slaagt.
  const result = await run({ xon: { list: () => jsonResponse(200, { iets: 'anders' }), email: () => jsonResponse(404, {}) } });

  assert.equal(result.problems, 1);
  assert.match(result.text, /Probleem met de lijst met lekken: XposedOrNot gaf een antwoord dat de koppeling niet kan lezen/);
  assert.match(result.text, /Brave Search[\s\S]*OK: de sleutel werkt/); // Brave is niet geraakt
  assert.ok(result.logs.some((line) => /onverwacht formaat/.test(line))); // de beheerder ziet wat er mis was
});

test('staat het adres wel in een lek en is de lijst onleesbaar, dan zijn er twee problemen: de lijst is nodig om het lek te tonen', async () => {
  const result = await run({ xon: { list: () => jsonResponse(200, { iets: 'anders' }) } });
  assert.equal(result.problems, 2);
  assert.match(result.text, /Probleem met de lijst met lekken/);
  assert.match(result.text, /Probleem bij het controleren van een adres/);
});

test('een storing bij XposedOrNot (HTTP 500) is "niet bereikbaar"', async () => {
  const result = await run({ xon: { email: () => jsonResponse(500, {}), list: () => jsonResponse(500, {}) } });
  assert.equal(result.problems, 2);
  assert.match(result.text, /XposedOrNot is niet bereikbaar/);
});

test('een fout van de fetch zelf (geen internet) is "niet bereikbaar", voor allebei de diensten', async () => {
  const lines = [];
  const problems = await runChecks({
    env: { BRAVE_API_KEY: KEY },
    fetchImpl: async () => { throw new TypeError('fetch failed'); },
    out: (line) => lines.push(line),
    braveOptions: { minIntervalMs: 0, log: () => {} },
    xonOptions: { minIntervalMs: 0, log: () => {} },
  });
  const text = lines.join('\n');
  assert.equal(problems, 3); // Brave, de lijst en de adrescontrole
  assert.match(text, /Brave is niet bereikbaar/);
  assert.match(text, /XposedOrNot is niet bereikbaar/);
  assert.ok(!text.includes(KEY));
});
