// Tests voor de gratis bron XposedOrNot, voor de keuze tussen die bron en Have I Been
// Pwned, en voor de schakelaar FREE_BREACH_CHECK. Er wordt niets echt verstuurd: de
// tests geven de client een nep-fetch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBreachCheck, parseFreeBreachCheck } from '../src/breach-check.js';
import { createHibp } from '../src/hibp.js';
import { SOURCES, sourceById, sourceHost } from '../src/sources.js';
import { createXon, normalizeXonBreach } from '../src/xon.js';
import {
  XON_LIST as LIST, fakeXonFetch as fakeFetch, jsonResponse as json, xonFound as found, xonRaw as raw,
} from './helpers.js';

const ADDRESS = 'anna+test@example.com';

function xonWith(fetcher, extra = {}) {
  const logs = [];
  const xon = createXon({
    fetchImpl: fetcher.impl, minIntervalMs: 0, log: (line) => logs.push(line), ...extra,
  });
  return { xon, logs };
}

async function codeOf(promise) {
  try {
    await promise;
  } catch (error) {
    return error.code;
  }
  return 'geen fout';
}

// --- Een lek uit de lijst ---------------------------------------------------------------

test('maakt van een lek uit de lijst dezelfde kleine gegevens als bij HIBP', () => {
  assert.deepEqual(normalizeXonBreach(raw('Adobe')), {
    name: 'Adobe',
    title: 'Adobe',
    domain: 'adobe.com',
    breachDate: '2013-10-04',
    pwnCount: 152445165,
    dataClasses: ['Email addresses', 'Passwords'],
    description: 'In 2013 lekten de gegevens van Adobe & meer.', // zonder tags
    isSensitive: false,
    source: 'xon',
    url: 'https://example.com/adobe',
  });
});

test('gevoelige lekken, en lekken die zelf niet doorzoekbaar heten, tonen we nooit', () => {
  assert.equal(normalizeXonBreach(raw('A')).isSensitive, false);
  assert.equal(normalizeXonBreach(raw('A', { sensitive: true })).isSensitive, true);
  assert.equal(normalizeXonBreach(raw('A', { searchable: false })).isSensitive, true);
});

test('alleen een lek dat uitdrukkelijk "niet gevoelig" heet, wordt getoond', () => {
  // Weten we het niet, dan tonen we het niet: de vlag ontbreekt, is leeg of is geen echte false.
  for (const value of [undefined, null, 'false', 0, 'nee', []]) {
    assert.equal(normalizeXonBreach(raw('A', { sensitive: value })).isSensitive, true, String(value));
  }
  const zonderVlag = raw('A');
  delete zonderVlag.sensitive;
  assert.equal(normalizeXonBreach(zonderVlag).isSensitive, true);
  // Zonder de vlag "searchable" is er niets aan de hand; alleen een echte false telt.
  const zonderSearchable = raw('A');
  delete zonderSearchable.searchable;
  assert.equal(normalizeXonBreach(zonderSearchable).isSensitive, false);
  assert.equal(normalizeXonBreach(raw('A', { searchable: 'false' })).isSensitive, false);
});

test('een link nemen we alleen over als het een https-link is', () => {
  assert.equal(normalizeXonBreach(raw('A', { referenceURL: 'javascript:alert(1)' })).url, null);
  assert.equal(normalizeXonBreach(raw('A', { referenceURL: 'http://example.com/a' })).url, null);
  assert.equal(normalizeXonBreach(raw('A', { referenceURL: 'data:text/html,hoi' })).url, null);
  assert.equal(normalizeXonBreach(raw('A', { referenceURL: '' })).url, null);
  assert.equal(normalizeXonBreach(raw('A', { referenceURL: 42 })).url, null);
  assert.equal(normalizeXonBreach(raw('A', { referenceURL: 'https://example.com/ok' })).url, 'https://example.com/ok');
});

test('onzin in de lijst geeft lege velden en geen fout', () => {
  assert.equal(normalizeXonBreach(null), null);
  assert.equal(normalizeXonBreach({}), null);
  assert.equal(normalizeXonBreach({ breachID: '  ' }), null);
  assert.equal(normalizeXonBreach({ breachID: 42 }), null);

  const kaal = normalizeXonBreach({ breachID: 'Kaal', breachedDate: 'ooit', exposedRecords: 'veel', exposedData: 'alles' });
  assert.equal(kaal.breachDate, null);
  assert.equal(kaal.pwnCount, null);
  assert.deepEqual(kaal.dataClasses, []);
  assert.equal(kaal.description, '');
  assert.equal(kaal.isSensitive, true); // we kennen de vlag niet, dus we tonen het lek niet
  assert.equal(kaal.url, null);
  assert.deepEqual(
    normalizeXonBreach({ breachID: 'X', exposedData: ['Passwords', 5, null, '<b>Namen</b>'] }).dataClasses,
    ['Passwords', 'Namen'],
  );
});

// --- Een adres opzoeken -----------------------------------------------------------------

test('vraagt XposedOrNot met het goede adres, zonder sleutel, en met een user-agent', async () => {
  const fetcher = fakeFetch();
  const { xon } = xonWith(fetcher);

  await xon.breachesFor(ADDRESS);

  const [first] = fetcher.calls;
  // Het adres is gecodeerd (+ en @).
  assert.equal(first.url, 'https://api.xposedornot.com/v1/check-email/anna%2Btest%40example.com');
  assert.match(first.init.headers['user-agent'], /^Privacyscan/);
  assert.deepEqual(Object.keys(first.init.headers).sort(), ['accept', 'user-agent']);
  // Het adres gaat alleen naar de ene aanvraag waar het hoort, en niet naar de lijst.
  for (const call of fetcher.calls.filter((item) => item.url.includes('/v1/breaches'))) {
    assert.doesNotMatch(call.url, /anna|example\.com/);
  }
});

test('geeft de lekken uit het antwoord, met de gegevens uit de lijst', async () => {
  const fetcher = fakeFetch({ email: () => json(200, found('LinkedIn', 'Adobe')) });
  const { xon } = xonWith(fetcher);

  const breaches = await xon.breachesFor(ADDRESS);

  assert.deepEqual(breaches.map((item) => item.name), ['LinkedIn', 'Adobe']);
  assert.equal(breaches[0].breachDate, '2012-06-05');
  assert.equal(breaches[0].pwnCount, 164611595);
  assert.equal(breaches[0].url, null);            // geen verwijzing bekend
  assert.equal(breaches[1].url, 'https://example.com/adobe');
  assert.ok(breaches.every((item) => item.source === 'xon'));
});

test('begrijpt de verschillende vormen van de lijst met namen', async () => {
  const shapes = [
    { breaches: [['Adobe', 'LinkedIn']] },               // zo staat het in de handleiding
    { breaches: ['Adobe', 'LinkedIn'] },                 // een gewone lijst
    { breaches: [['Adobe'], ['LinkedIn']] },
    { breaches: [['Adobe', 'adobe', 'LinkedIn', '', 7, null]] }, // dubbel, leeg en onzin
  ];
  for (const body of shapes) {
    const { xon } = xonWith(fakeFetch({ email: () => json(200, body) }));
    assert.deepEqual((await xon.breachesFor(ADDRESS)).map((item) => item.name), ['Adobe', 'LinkedIn'], JSON.stringify(body));
  }
  // Hoofdletters maken niet uit bij het vinden van het lek in de lijst.
  const { xon } = xonWith(fakeFetch({ email: () => json(200, found('ADOBE')) }));
  assert.deepEqual((await xon.breachesFor(ADDRESS)).map((item) => item.name), ['Adobe']);
});

test('een adres dat nergens in staat, geeft een lege lijst en haalt de lijst niet op', async () => {
  const answers = [
    () => json(404, { Error: 'Not found', email: null }),
    () => json(200, { Error: 'Not found', email: null }),
    () => json(200, { breaches: null, email: 'x@example.com' }),
    () => json(200, { breaches: [], email: 'x@example.com', status: 'success' }),
    () => json(200, { breaches: [[]], email: 'x@example.com', status: 'success' }),
  ];
  for (const email of answers) {
    const fetcher = fakeFetch({ email });
    const { xon } = xonWith(fetcher);
    assert.deepEqual(await xon.breachesFor(ADDRESS), []);
    assert.equal(fetcher.count('/v1/breaches'), 0);
  }
});

test('gevoelige lekken en lekken die niet in de lijst staan, komen er nooit uit', async () => {
  const fetcher = fakeFetch({ email: () => json(200, found('Adobe', 'Datingsite', 'Verborgen', 'NieuwLekZonderGegevens')) });
  const { xon } = xonWith(fetcher);

  const breaches = await xon.breachesFor(ADDRESS);

  assert.deepEqual(breaches.map((item) => item.name), ['Adobe']);
});

// --- De lijst met alle lekken -------------------------------------------------------------

test('de lijst met lekken halen we één keer per dag op, en nooit met een adres erin', async () => {
  let clock = 1_000_000;
  const fetcher = fakeFetch();
  const { xon } = xonWith(fetcher, { now: () => clock });

  await xon.breachesFor('een@example.com');
  await xon.breachesFor('twee@example.com');
  await xon.breachesFor('drie@example.com');
  assert.equal(fetcher.count('/v1/breaches'), 1);
  assert.equal(fetcher.count('/v1/check-email/'), 3);

  clock += 23 * 60 * 60 * 1000;
  await xon.breachesFor('vier@example.com');
  assert.equal(fetcher.count('/v1/breaches'), 1);

  clock += 2 * 60 * 60 * 1000; // ruim een dag later
  await xon.breachesFor('vijf@example.com');
  assert.equal(fetcher.count('/v1/breaches'), 2);
});

test('gelijktijdige controles delen één aanvraag voor de lijst', async () => {
  const fetcher = fakeFetch();
  const { xon } = xonWith(fetcher);

  await Promise.all([xon.breachesFor('a@example.com'), xon.breachesFor('b@example.com'), xon.breachesFor('c@example.com')]);

  assert.equal(fetcher.count('/v1/breaches'), 1);
});

test('een onbekend lek: misschien is het net toegevoegd, dus de lijst wordt vernieuwd (niet te vaak)', async () => {
  let clock = 5_000_000;
  let withNew = false;
  const fetcher = fakeFetch({
    email: () => json(200, found('Adobe', 'Splinternieuw')),
    list: () => json(200, { exposedBreaches: [...LIST.exposedBreaches, ...(withNew ? [raw('Splinternieuw')] : [])] }),
  });
  const { xon } = xonWith(fetcher, { now: () => clock });

  // Eerste keer: de lijst kent het lek niet, en we hebben hem net opgehaald.
  assert.deepEqual((await xon.breachesFor(ADDRESS)).map((item) => item.name), ['Adobe']);
  assert.equal(fetcher.count('/v1/breaches'), 1);

  // Vijf minuten later: nog steeds geen nieuwe aanvraag voor de lijst.
  clock += 5 * 60 * 1000;
  withNew = true;
  assert.deepEqual((await xon.breachesFor(ADDRESS)).map((item) => item.name), ['Adobe']);
  assert.equal(fetcher.count('/v1/breaches'), 1);

  // Een kwartier later wel, en nu staat het lek erin.
  clock += 11 * 60 * 1000;
  assert.deepEqual((await xon.breachesFor(ADDRESS)).map((item) => item.name), ['Adobe', 'Splinternieuw']);
  assert.equal(fetcher.count('/v1/breaches'), 2);
});

test('lukt het vernieuwen van de lijst niet, dan gebruiken we de oude, en proberen we het niet meteen weer', async () => {
  let clock = 9_000_000;
  let broken = false;
  const fetcher = fakeFetch({
    list: () => (broken ? json(500, 'stuk') : json(200, LIST)),
  });
  const { xon } = xonWith(fetcher, { now: () => clock });

  await xon.breachesFor(ADDRESS);
  assert.equal(fetcher.count('/v1/breaches'), 1);

  broken = true;
  clock += 25 * 60 * 60 * 1000; // de lijst is verouderd
  assert.deepEqual((await xon.breachesFor(ADDRESS)).map((item) => item.name), ['Adobe']);
  assert.equal(fetcher.count('/v1/breaches'), 2); // een mislukte poging

  clock += 60 * 1000; // een minuut later: nog niet opnieuw proberen
  await xon.breachesFor(ADDRESS);
  assert.equal(fetcher.count('/v1/breaches'), 2);

  clock += 5 * 60 * 1000; // na een paar minuten wel
  await xon.breachesFor(ADDRESS);
  assert.equal(fetcher.count('/v1/breaches'), 3);
});

test('zonder lijst tonen we niets: we weten dan niet welke lekken gevoelig zijn', async () => {
  const cases = [
    ['500', () => json(500, 'stuk'), 'unavailable'],
    ['503', () => json(503, 'stuk'), 'unavailable'],
    ['429', () => json(429, { retry_after: 60 }), 'rate_limited'],
    ['404', () => json(404, {}), 'unexpected'],
    ['geen JSON', () => json(200, 'dit is geen json'), 'unexpected'],
    ['andere vorm', () => json(200, { iets: 'anders' }), 'unexpected'],
    ['geen lijst', () => json(200, { exposedBreaches: 'nee' }), 'unexpected'],
  ];
  for (const [label, list, code] of cases) {
    const { xon } = xonWith(fakeFetch({ list }));
    assert.equal(await codeOf(xon.breachesFor(ADDRESS)), code, label);
  }
});

test('een lijst zonder de vlag "sensitive" kunnen we niet gebruiken, en dan zeggen we niets over lekken', async () => {
  const withoutFlag = () => {
    const entry = (name) => {
      const lek = raw(name);
      delete lek.sensitive;
      return lek;
    };
    return json(200, { exposedBreaches: [entry('Adobe'), entry('LinkedIn'), entry('Datingsite')], status: 'success' });
  };
  const emptyList = () => json(200, { exposedBreaches: [], status: 'success' });
  const nonsense = () => json(200, { exposedBreaches: [null, 7, 'tekst', {}] });
  const renamed = () => json(200, { exposedBreaches: [{ id: 'Adobe', isSensitive: false }, { id: 'LinkedIn', isSensitive: false }] });

  for (const [label, list] of [['zonder vlag', withoutFlag], ['leeg', emptyList], ['onzin', nonsense], ['andere veldnamen', renamed]]) {
    const { xon, logs } = xonWith(fakeFetch({ list, email: () => json(200, found('Adobe', 'LinkedIn')) }));
    // Geen "goed nieuws" en geen lekken: een fout, met een regel voor de beheerder.
    assert.equal(await codeOf(xon.breachesFor(ADDRESS)), 'unexpected', label);
    assert.match(logs.join('\n'), /de lijst met lekken is niet bruikbaar/, label);
  }
});

test('lekken die niet in de lijst staan, worden voor de beheerder geteld, zonder naam of adres', async () => {
  const { xon, logs } = xonWith(fakeFetch({ email: () => json(200, found('Adobe', 'GeheimLek', 'NogEenGeheimLek')) }));
  assert.deepEqual((await xon.breachesFor(ADDRESS)).map((item) => item.name), ['Adobe']);
  assert.deepEqual(logs, ['XposedOrNot noemde 2 lek(ken) die niet in hun lijst staan; die tonen we niet.']);
});

test('een lijst met onzin erin geeft alleen de goede lekken', async () => {
  const list = () => json(200, { exposedBreaches: [null, 7, 'tekst', {}, raw('Adobe')] });
  const { xon } = xonWith(fakeFetch({ list }));
  assert.deepEqual((await xon.breachesFor(ADDRESS)).map((item) => item.name), ['Adobe']);
});

// --- Fouten --------------------------------------------------------------------------------

test('fouten van XposedOrNot worden codes zonder technische details', async () => {
  const cases = [
    ['429', () => json(429, { retry_after: 3600, reset_time: 'later' }), 'rate_limited'],
    ['500', () => json(500, 'stuk'), 'unavailable'],
    ['502', () => json(502, 'stuk'), 'unavailable'],
    ['503', () => json(503, 'stuk'), 'unavailable'],
    ['403', () => json(403, 'nee'), 'unexpected'],
    ['418', () => json(418, 'thee'), 'unexpected'],
    ['geen JSON', () => json(200, 'dit is geen json'), 'unexpected'],
    ['andere vorm', () => json(200, { iets: 'anders' }), 'unexpected'],
    ['een lijst als antwoord', () => json(200, []), 'unexpected'],
    ['een getal als antwoord', () => json(200, '7'), 'unexpected'],
  ];
  for (const [label, email, code] of cases) {
    const { xon } = xonWith(fakeFetch({ email }));
    assert.equal(await codeOf(xon.breachesFor(ADDRESS)), code, label);
  }
});

test('geen internet geeft "niet bereikbaar"', async () => {
  const fetchImpl = async () => { throw new TypeError('fetch failed'); };
  const xon = createXon({ fetchImpl, minIntervalMs: 0, log: () => {} });
  assert.equal(await codeOf(xon.breachesFor(ADDRESS)), 'unavailable');
});

test('als er te veel tegelijk wordt gevraagd, zegt de client "druk" in plaats van te wachten', async () => {
  const fetcher = fakeFetch({ email: () => json(404, {}) });
  const { xon } = xonWith(fetcher, { minIntervalMs: 10_000, maxWaitMs: 100 });

  const results = await Promise.allSettled([xon.breachesFor('a@example.com'), xon.breachesFor('b@example.com')]);

  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].reason.code, 'busy');
  assert.equal(fetcher.calls.length, 1);
});

test('het logboek voor de beheerder bevat nooit een e-mailadres', async () => {
  const secret = 'geheim.adres@example.com';
  const bad = [
    { email: () => json(200, { iets: 'anders' }) },
    { email: () => json(403, 'nee') },
    { email: () => json(200, 'geen json') },
    { list: () => json(200, { iets: 'anders' }) },
    { list: () => json(418, 'thee') },
  ];
  for (const overrides of bad) {
    const { xon, logs } = xonWith(fakeFetch(overrides));
    await codeOf(xon.breachesFor(secret));
    assert.ok(logs.length > 0, JSON.stringify(Object.keys(overrides)));
    for (const line of logs) assert.doesNotMatch(line, /geheim|example\.com|%40/);
  }
});

// --- Kiezen tussen HIBP en XposedOrNot ----------------------------------------------------

function chooser({ apiKey, withXon = true } = {}) {
  const hibpFetch = fakeFetch({ email: () => json(200, []) });
  const xonFetch = fakeFetch();
  // HIBP gebruikt een andere URL; deze nep-fetch geeft voor elk adres één lek.
  const hibpImpl = async (url, init) => {
    hibpFetch.calls.push({ url, init });
    return json(200, [{ Name: 'HibpLek', Title: 'HibpLek', BreachDate: '2020-01-01', DataClasses: ['Passwords'] }]);
  };
  const hibp = createHibp({ apiKey, fetchImpl: hibpImpl, minIntervalMs: 0 });
  const { xon } = xonWith(xonFetch);
  const check = createBreachCheck({ hibp, xon: withXon ? xon : null });
  return { check, hibpFetch, xonFetch };
}

test('met een eigen HIBP-sleutel gaat elk adres naar HIBP, en nooit naar XposedOrNot', async () => {
  const { check, hibpFetch, xonFetch } = chooser({ apiKey: 'ab12'.repeat(8) });

  assert.equal(check.hasKey, true);
  assert.equal(check.sourceFor('iemand@example.com'), 'hibp');
  assert.deepEqual(check.emailSources, ['hibp']);
  assert.deepEqual((await check.breachesFor('iemand@example.com')).map((item) => item.name), ['HibpLek']);
  assert.equal(hibpFetch.calls.length, 1);
  assert.equal(xonFetch.calls.length, 0);
});

test('zonder sleutel gaat een echt adres naar XposedOrNot, en een testadres naar HIBP', async () => {
  const { check, hibpFetch, xonFetch } = chooser();

  assert.equal(check.hasKey, true); // elk adres kan nu gecontroleerd worden
  assert.equal(check.hasKeyFor('iemand@example.com'), true);
  assert.equal(check.sourceFor('iemand@example.com'), 'xon');
  assert.equal(check.sourceFor('Multiple-Breaches@HIBP-Integration-Tests.com'), 'hibp');
  assert.deepEqual(check.emailSources, ['xon']);

  assert.deepEqual((await check.breachesFor('iemand@example.com')).map((item) => item.name), ['Adobe']);
  assert.equal(hibpFetch.calls.length, 0);

  assert.deepEqual((await check.breachesFor('multiple-breaches@hibp-integration-tests.com')).map((item) => item.name), ['HibpLek']);
  assert.equal(hibpFetch.calls.length, 1);
  assert.equal(xonFetch.count('/v1/check-email/'), 1); // alleen voor het echte adres
});

test('zonder sleutel en zonder gratis dienst werken alleen de testadressen', async () => {
  const { check, hibpFetch, xonFetch } = chooser({ withXon: false });

  assert.equal(check.hasKey, false);
  assert.equal(check.hasKeyFor('iemand@example.com'), false);
  assert.equal(check.sourceFor('iemand@example.com'), null);
  assert.equal(check.sourceFor('account-exists@hibp-integration-tests.com'), 'hibp');
  assert.deepEqual(check.emailSources, ['hibp']);

  assert.equal(await codeOf(check.breachesFor('iemand@example.com')), 'no_key');
  assert.equal(hibpFetch.calls.length, 0);
  assert.equal(xonFetch.calls.length, 0);
});

// --- De schakelaar FREE_BREACH_CHECK ------------------------------------------------------

test('FREE_BREACH_CHECK: leeg is aan op je eigen computer en uit op een openbare site', () => {
  for (const value of [undefined, null, '', '   ']) {
    assert.equal(parseFreeBreachCheck(value, { production: false }), true);
    assert.equal(parseFreeBreachCheck(value, { production: true }), false);
  }
  assert.equal(parseFreeBreachCheck(undefined), true); // zonder instellingen: je eigen computer
});

test('FREE_BREACH_CHECK: aan en uit, op de manieren die je kunt verwachten', () => {
  for (const value of ['on', 'ON', 'true', '1', 'aan', 'Ja', ' on ']) {
    assert.equal(parseFreeBreachCheck(value, { production: true }), true, value);
  }
  for (const value of ['off', 'OFF', 'false', '0', 'uit', 'Nee', ' off ']) {
    assert.equal(parseFreeBreachCheck(value, { production: false }), false, value);
  }
});

test('FREE_BREACH_CHECK: een typfout stopt de server met een duidelijke melding', () => {
  for (const value of ['onn', 'misschien', '2', 'xposedornot']) {
    assert.throws(() => parseFreeBreachCheck(value), /FREE_BREACH_CHECK moet "on" of "off" zijn/, value);
  }
});

// --- De bronnen ------------------------------------------------------------------------------

test('wat we niet kennen, is Have I Been Pwned (zo blijven oude resultaten kloppen)', () => {
  assert.equal(sourceById('xon'), SOURCES.xon);
  assert.equal(sourceById('hibp'), SOURCES.hibp);
  for (const value of [undefined, null, '', 'iets', 'constructor', '__proto__', 'toString', 7]) {
    assert.equal(sourceById(value), SOURCES.hibp, String(value));
  }
  assert.equal(sourceHost(SOURCES.xon), 'xposedornot.com');
  assert.equal(sourceHost(SOURCES.hibp), 'haveibeenpwned.com');
});
