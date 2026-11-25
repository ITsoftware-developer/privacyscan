// Tests voor het praten met Have I Been Pwned. Er wordt niets echt verstuurd:
// de tests geven de client een nep-fetch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TEST_KEY, createHibp, createThrottle, normalizeBreach } from '../src/hibp.js';
import { plainText } from '../src/text.js';

const MY_KEY = 'ab12'.repeat(8);

// Een nep-fetch die onthoudt wat er gevraagd is en een vast antwoord geeft.
function fakeFetch(respond) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return respond();
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

const answer = (status, body) => () => new Response(
  typeof body === 'string' ? body : JSON.stringify(body),
  { status, headers: { 'content-type': 'application/json' } },
);

async function codeOf(promise) {
  try {
    await promise;
  } catch (error) {
    return error.code;
  }
  return 'geen fout';
}

const RAW_ADOBE = {
  Name: 'Adobe',
  Title: 'Adobe',
  Domain: 'adobe.com',
  BreachDate: '2013-10-04',
  AddedDate: '2013-12-04T00:00:00Z',
  ModifiedDate: '2022-05-15T23:52:49Z',
  PwnCount: 152445165,
  Description: 'In oktober 2013 lekten <strong>152 miljoen</strong> accounts van <a href="https://example.com/adobe" target="_blank" rel="noopener">Adobe</a> &amp; meer.',
  LogoPath: 'https://haveibeenpwned.com/Content/Images/PwnedLogos/Adobe.png',
  DataClasses: ['Email addresses', 'Password hints', 'Passwords', 'Usernames'],
  IsVerified: true,
  IsSensitive: false,
};

test('vraagt HIBP met het goede adres, de sleutel en een user-agent', async () => {
  const fetchImpl = fakeFetch(answer(200, [RAW_ADOBE]));
  const hibp = createHibp({ apiKey: MY_KEY, fetchImpl, minIntervalMs: 0 });

  await hibp.breachesFor('anna+test@example.com');

  const [{ url, init }] = fetchImpl.calls;
  // Het adres is gecodeerd (+ en @), en we vragen om de volledige gegevens.
  assert.equal(url, 'https://haveibeenpwned.com/api/v3/breachedaccount/anna%2Btest%40example.com?truncateResponse=false');
  assert.equal(init.headers['hibp-api-key'], MY_KEY);
  assert.match(init.headers['user-agent'], /^Privacyscan/);
  assert.ok(init.signal instanceof AbortSignal, 'er is een tijdslimiet');
});

test('zonder eigen sleutel werken alleen testadressen, met de testsleutel van HIBP', async () => {
  const fetchImpl = fakeFetch(answer(200, [RAW_ADOBE]));
  const hibp = createHibp({ fetchImpl, minIntervalMs: 0 });

  assert.equal(hibp.hasKeyFor('anna@example.com'), false);
  assert.equal(await codeOf(hibp.breachesFor('anna@example.com')), 'no_key');
  assert.equal(fetchImpl.calls.length, 0); // er is niets verstuurd

  assert.equal(hibp.hasKeyFor('Account-Exists@HIBP-Integration-Tests.com'), true);
  await hibp.breachesFor('account-exists@hibp-integration-tests.com');
  assert.equal(fetchImpl.calls[0].init.headers['hibp-api-key'], TEST_KEY);
  assert.equal(TEST_KEY, '0'.repeat(32));
});

test('een eigen sleutel gaat voor de testsleutel, en geldt voor elk adres', async () => {
  const fetchImpl = fakeFetch(answer(404, ''));
  const hibp = createHibp({ apiKey: MY_KEY, fetchImpl, minIntervalMs: 0 });

  assert.equal(hibp.hasKeyFor('anna@example.com'), true);
  await hibp.breachesFor('anna@example.com');
  await hibp.breachesFor('account-exists@hibp-integration-tests.com');
  assert.deepEqual(fetchImpl.calls.map((c) => c.init.headers['hibp-api-key']), [MY_KEY, MY_KEY]);
});

test('een sleutel in het verkeerde formaat wordt niet eens verstuurd', async () => {
  const fetchImpl = fakeFetch(answer(200, []));
  const hibp = createHibp({ apiKey: 'te-kort', fetchImpl, minIntervalMs: 0 });

  assert.equal(await codeOf(hibp.breachesFor('anna@example.com')), 'bad_key');
  assert.equal(fetchImpl.calls.length, 0);
});

test('404 betekent: HIBP weet van dit adres niets', async () => {
  const hibp = createHibp({ apiKey: MY_KEY, fetchImpl: fakeFetch(answer(404, '')), minIntervalMs: 0 });
  assert.deepEqual(await hibp.breachesFor('anna@example.com'), []);
});

test('het antwoord van HIBP wordt opgeschoond tot een klein, veilig object', async () => {
  const messy = [
    RAW_ADOBE,
    null,
    { Title: 'Zonder naam' },
    { Name: 'Kaal' },
    { Name: 'Vreemd', Title: 'Vreemd', BreachDate: 'gisteren', PwnCount: '12', DataClasses: ['Passwords', 7, '<b>Telefoon</b>'] },
  ];
  const hibp = createHibp({ apiKey: MY_KEY, fetchImpl: fakeFetch(answer(200, messy)), minIntervalMs: 0 });

  const [adobe, kaal, vreemd, ...rest] = await hibp.breachesFor('anna@example.com');

  assert.deepEqual(adobe, {
    name: 'Adobe',
    title: 'Adobe',
    domain: 'adobe.com',
    breachDate: '2013-10-04',
    pwnCount: 152445165,
    dataClasses: ['Email addresses', 'Password hints', 'Passwords', 'Usernames'],
    // geen tags, geen &amp;: gewone tekst
    description: 'In oktober 2013 lekten 152 miljoen accounts van Adobe & meer.',
    isSensitive: false,
  });
  assert.equal(kaal.title, 'Kaal'); // zonder Title nemen we de naam
  assert.equal(kaal.breachDate, null);
  assert.deepEqual(kaal.dataClasses, []);
  assert.equal(kaal.isSensitive, false); // niet vermeld = niet als gevoelig gemarkeerd
  assert.equal(vreemd.breachDate, null); // geen echte datum
  assert.equal(vreemd.pwnCount, null);   // geen getal
  assert.deepEqual(vreemd.dataClasses, ['Passwords', 'Telefoon']);
  assert.equal(rest.length, 0); // alles zonder naam is weggelaten
});

test('HIBP-fouten worden vertaald naar een vaste code', async () => {
  const cases = [
    [answer(401, { statusCode: 401, message: 'Access denied' }), 'bad_key'],
    [answer(403, 'user-agent ontbreekt'), 'unexpected'],
    [answer(429, { statusCode: 429, message: 'Rate limit is exceeded.' }), 'rate_limited'],
    [answer(500, 'kapot'), 'unexpected'],
    [answer(503, '<html>Cloudflare</html>'), 'unavailable'],
    [answer(200, 'dit is geen json'), 'unexpected'],
    [answer(200, { geen: 'lijst' }), 'unexpected'],
    [() => { throw new TypeError('fetch failed'); }, 'unavailable'], // geen internet
  ];
  for (const [respond, expected] of cases) {
    const hibp = createHibp({ apiKey: MY_KEY, fetchImpl: fakeFetch(respond), minIntervalMs: 0 });
    assert.equal(await codeOf(hibp.breachesFor('anna@example.com')), expected);
  }
});

test('de wachtrij houdt tijd tussen aanvragen en zegt "druk" bij een te lange rij', async () => {
  const throttle = createThrottle(100, 150);
  const started = performance.now();

  // Drie tegelijk: de eerste mag meteen, de tweede na 100 ms, de derde zou 200 ms moeten wachten.
  const results = await Promise.allSettled([
    throttle().then(() => performance.now() - started),
    throttle().then(() => performance.now() - started),
    throttle().then(() => performance.now() - started),
  ]);

  assert.equal(results[0].status, 'fulfilled');
  assert.ok(results[0].value < 50);
  assert.equal(results[1].status, 'fulfilled');
  assert.ok(results[1].value >= 90, `tweede aanvraag na ${results[1].value} ms`);
  assert.equal(results[2].status, 'rejected');
  assert.equal(results[2].reason.code, 'busy');
});

test('normalizeBreach kapt lange namen en teksten af', () => {
  const breach = normalizeBreach({ Name: 'x'.repeat(500), Description: 'y'.repeat(1000), PwnCount: 5 });
  assert.equal(breach.name.length, 100);
  assert.equal(breach.description.length, 400);
  assert.ok(breach.description.endsWith('…'));
  assert.equal(normalizeBreach(undefined), null);
  assert.equal(normalizeBreach({ Name: '' }), null);
});

test('plainText haalt tags weg en zet tekens één keer terug', () => {
  assert.equal(plainText('<p>Hoi <b>daar</b></p>', 50), 'Hoi daar');
  assert.equal(plainText('Tom &amp; Jerry &quot;samen&quot; &#39;s avonds', 50), 'Tom & Jerry "samen" \'s avonds');
  assert.equal(plainText('&amp;lt;', 50), '&lt;'); // niet twee keer ontcijferen
  assert.equal(plainText('  veel \n\n  witruimte\t ', 50), 'veel witruimte');
  assert.equal(plainText(null, 50), '');
  assert.equal(plainText(undefined, 50), '');
  assert.equal(plainText('abcdefghij', 5), 'abcd…');
});

test('een gevoelig lek houdt zijn vlag, ook als HIBP die als iets anders meestuurt', () => {
  assert.equal(normalizeBreach({ Name: 'Geheim', IsSensitive: true }).isSensitive, true);
  assert.equal(normalizeBreach({ Name: 'Gewoon', IsSensitive: false }).isSensitive, false);
  // Alleen een echte true telt als gevoelig; "true" als tekst of 1 is rommel van buiten.
  assert.equal(normalizeBreach({ Name: 'Raar', IsSensitive: 'true' }).isSensitive, false);
  assert.equal(normalizeBreach({ Name: 'Raar', IsSensitive: 1 }).isSensitive, false);
});

test('de client weet of er een eigen sleutel is (anders werken alleen testadressen)', () => {
  assert.equal(createHibp().hasKey, false);
  assert.equal(createHibp({ apiKey: MY_KEY }).hasKey, true);
});
