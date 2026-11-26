// Tests voor de Data Broker Engine: het register, de zoekopdrachten, het zoeken bij databrokers en wat we
// per databroker bijhouden. Plus de regels die het uitgebreide onderzoek deelt: met welk gegeven iets
// gevonden is, en wanneer een overeenkomst sterk is.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BROKERS, CHECKED, brokerById, brokerForUrl, searchGroups } from '../src/brokers/registry.js';
import { rateWebResult } from '../src/confidence.js';
import { openDatabase } from '../src/db.js';
import { classifyUrl } from '../src/extract.js';
import { saveWebResults, viaText } from '../src/findings.js';
import {
  BROKER_STATUSES, brokerOverview, brokersIn, recordBrokerCheck, recordBrokerFindings, scanBrokers,
} from '../src/research/broker-scan.js';
import {
  DOCUMENT_TYPES, SOCIAL_SITES, brokerQueries, documentsQuery, emailQuery, phoneQuery, socialQuery,
} from '../src/research/queries.js';
import { ScanError } from '../src/scan-error.js';
import {
  ANNA, fakeHibp, fakeSearch, registerConfirmed, send, startServer,
} from './helpers.js';

// --- Het register ---------------------------------------------------------------------------------

test('elke databroker in het register is compleet en heeft een bron', () => {
  const ids = new Set();
  const domains = new Set();
  for (const broker of BROKERS) {
    assert.match(broker.id, /^[a-z0-9-]+$/, broker.id);
    assert.ok(!ids.has(broker.id), `dubbel: ${broker.id}`);
    assert.ok(!domains.has(broker.domain), `dubbel: ${broker.domain}`);
    ids.add(broker.id);
    domains.add(broker.domain);
    assert.match(broker.domain, /^[a-z0-9.-]+\.[a-z]{2,}$/, broker.id);
    assert.ok(broker.name && broker.kind && broker.about, broker.id);
    assert.ok(broker.countries.length > 0 && broker.data.length > 0, broker.id);
    assert.ok(['search', 'closed'].includes(broker.access), broker.id);
    assert.match(broker.source, /^https:\/\//, broker.id);
  }
  assert.match(CHECKED, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(brokerById('spokeo').name, 'Spokeo');
  assert.equal(brokerById('bestaat-niet'), null);
});

test('bij welke databroker hoort een adres: ook subdomeinen, maar geen look-alikes', () => {
  assert.equal(brokerForUrl('https://www.detelefoongids.nl/anna/1/').id, 'detelefoongids');
  assert.equal(brokerForUrl('https://nl.spokeo.com/Anna-de-Vries').id, 'spokeo');
  assert.equal(brokerForUrl('https://192.com/people/anna').id, '192');
  for (const url of ['https://notspokeo.com/x', 'https://spokeo.com.example.net/x', 'https://example.com/spokeo.com', 'geen adres', '', null]) {
    assert.equal(brokerForUrl(url), null, String(url));
  }
  assert.equal(classifyUrl('https://www.dasoertliche.de/x').type, 'broker');
});

test('de doorzoekbare databrokers in groepjes: Europa en de VS apart, afgeschermde niet', () => {
  const groups = searchGroups();
  const flat = groups.flat();
  assert.equal(flat.length, BROKERS.filter((broker) => broker.access === 'search').length);
  assert.ok(flat.every((broker) => broker.access === 'search'));
  assert.ok(groups.every((group) => group.length <= 8));
  assert.ok(groups[0].every((broker) => !broker.countries.includes('Verenigde Staten')));
  assert.ok(groups.at(-1).every((broker) => broker.countries.includes('Verenigde Staten')));
  assert.ok(!flat.some((broker) => broker.id === 'pipl'));
  assert.equal(searchGroups(3).flat().length, flat.length);
  assert.ok(searchGroups(3).every((group) => group.length <= 3));
});

// --- De zoekopdrachten -----------------------------------------------------------------------------

test('de zoekopdrachten van het uitgebreide onderzoek', () => {
  assert.equal(socialQuery('Anna de Vries'), `"Anna de Vries" ${SOCIAL_SITES.map((site) => `site:${site}`).join(' OR ')}`);
  assert.equal(documentsQuery('Anna de Vries'), `"Anna de Vries" ${DOCUMENT_TYPES.map((type) => `filetype:${type}`).join(' OR ')}`);
  assert.equal(phoneQuery('+31612345678'), '"0612345678" OR "06-12345678" OR "06 12345678" OR "+31612345678"');
  assert.equal(phoneQuery(null), null);
  assert.equal(emailQuery('anna@example.com'), '"anna@example.com"');
  assert.equal(emailQuery(''), null);

  const queries = brokerQueries('Anna de Vries');
  assert.equal(queries.length, searchGroups().length);
  for (const { brokers, query } of queries) {
    assert.equal(query, `"Anna de Vries" ${brokers.map((broker) => `site:${broker.domain}`).join(' OR ')}`);
  }
});

test('een naam kan geen zoekoperatoren of extra aanhalingstekens in de zoekopdracht smokkelen', () => {
  // Wat van de naam overblijft, staat als één letterlijke zin tussen aanhalingstekens; alles daarna is van ons.
  const ours = (query) => query.replace(/^"[^"]*" /, '');
  for (const name of ['Anna" OR site:evil.example "x', 'Anna -site:spokeo.com', 'Anna (de) Vries*']) {
    const pairs = [
      [socialQuery(name), socialQuery('Anna de Vries')],
      [documentsQuery(name), documentsQuery('Anna de Vries')],
      ...brokerQueries(name).map((item, index) => [item.query, brokerQueries('Anna de Vries')[index].query]),
    ];
    for (const [query, normal] of pairs) {
      const who = query.match(/^"([^"]*)" /);
      assert.ok(who, `${name} → ${query}`);
      assert.doesNotMatch(who[1], /["*():]|(^|\s)-/, name);
      assert.equal(ours(query), ours(normal), name);
    }
  }
  // Te weinig letters: geen zoekopdracht.
  assert.equal(socialQuery('A.'), null);
  assert.deepEqual(brokerQueries('--'), []);
});

// --- Met welk gegeven gevonden, en hoe sterk ---------------------------------------------------------

test('"gevonden via" in gewone taal; onbekende waarden laten we weg', () => {
  assert.equal(viaText(['naam']), 'je naam');
  assert.equal(viaText(['naam', 'telefoon']), 'je naam en je telefoonnummer');
  assert.equal(viaText(['e-mail', 'naam', 'telefoon', 'naam']), 'je e-mailadres, je naam en je telefoonnummer');
  assert.equal(viaText(['iets', 42, null]), null);
  assert.equal(viaText(undefined), null);
  assert.equal(viaText('naam'), null);
});

test('een bevestigd telefoonnummer in het fragment is een sterke overeenkomst, een ander nummer niet', () => {
  const base = { name: 'Anna de Vries', city: null, email: 'anna@example.com', title: 'Gids' };
  assert.equal(rateWebResult({ ...base, phone: '+31612345678', snippet: 'Bel 06-12345678' }).level, 'hoog');
  assert.match(rateWebResult({ ...base, phone: '+31612345678', snippet: 'Bel 06-12345678' }).note, /telefoonnummer/);
  assert.equal(rateWebResult({ ...base, phone: '+31612345678', snippet: 'Bel 06-12345679' }).level, 'geen');
  // Zonder bevestigd nummer (de aanroeper geeft dan null mee) telt een nummer in de tekst niet.
  assert.equal(rateWebResult({ ...base, phone: null, snippet: 'Bel 06-12345678' }).level, 'geen');
});

function withUser() {
  const db = openDatabase(':memory:');
  db.prepare("INSERT INTO users (name, email, password_hash, created_at) VALUES ('Anna de Vries', 'anna@example.com', 'x', 1)").run();
  const user = { ...db.prepare('SELECT * FROM users').get() };
  return { db, user };
}

const PAGE = { title: 'Anna de Vries', url: 'https://www.telefoonboek.nl/anna-de-vries', snippet: 'Anna de Vries, Utrecht' };

test('vindt een volgende zoekopdracht hetzelfde adres met een ander gegeven, dan komt dat erbij', () => {
  const { db, user } = withUser();
  const via = () => JSON.parse(db.prepare('SELECT details FROM findings').get().details).via;
  saveWebResults(db, user.id, [PAGE], 10, { via: 'naam' });
  saveWebResults(db, user.id, [PAGE], 10, { via: 'telefoon' });
  saveWebResults(db, user.id, [PAGE], 10, { via: 'naam' });
  assert.deepEqual(via(), ['naam', 'telefoon']);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM findings').get().n, 1);

  // Een verlopen resultaat telt niet mee: dan begint het opnieuw.
  db.prepare('UPDATE findings SET expires_at = 11').run();
  saveWebResults(db, user.id, [PAGE], 20, { via: 'e-mail' });
  assert.deepEqual(via(), ['e-mail']);
});

// --- Zoeken bij databrokers -------------------------------------------------------------------------

test('scanBrokers: per databroker gevonden of niet, en alleen resultaten op databrokersites', async () => {
  const { db, user } = withUser();
  const other = { title: 'Anna de Vries blog', url: 'https://example.org/anna', snippet: 'Anna de Vries' };
  const search = fakeSearch({ results: (request) => (request.query.includes('site:telefoonboek.nl') ? [PAGE, other] : []) });

  const outcome = await scanBrokers({
    db, user, search, now: 100,
  });
  assert.equal(search.calls.length, searchGroups().length);
  assert.deepEqual(outcome.withHits, ['telefoonboek']);
  assert.equal(outcome.found, 1); // het blog is geen databroker en telt niet mee
  assert.equal(outcome.checked, BROKERS.filter((broker) => broker.access === 'search').length);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM findings WHERE url = 'https://example.org/anna'").get().n, 0);

  const overview = new Map(brokerOverview(db, user.id).map((row) => [row.broker.id, row]));
  assert.equal(overview.get('telefoonboek').status, 'gevonden');
  assert.equal(overview.get('telefoonboek').found, 1);
  assert.deepEqual(overview.get('telefoonboek').via, ['naam']);
  assert.equal(overview.get('telefoonboek').checkedAt, 100);
  assert.equal(overview.get('detelefoongids').status, 'niet-gevonden');
  assert.equal(overview.get('pipl').status, 'afgeschermd');
  assert.equal(overview.get('pipl').label, BROKER_STATUSES.afgeschermd.label);
});

test('scanBrokers: lukt één groepje niet, dan staat het als niet toegankelijk en lopen de andere door', async () => {
  const { db, user } = withUser();
  const search = fakeSearch({
    results: (request) => {
      if (request.query.includes('site:spokeo.com')) throw new ScanError('unavailable');
      return [];
    },
  });
  const outcome = await scanBrokers({
    db, user, search, now: 5,
  });
  assert.equal(outcome.error.code, 'search_unavailable');
  assert.ok(outcome.failed > 0 && outcome.checked > 0);
  const status = (id) => brokerOverview(db, user.id).find((row) => row.broker.id === id).status;
  assert.equal(status('spokeo'), 'niet-toegankelijk');
  assert.equal(status('detelefoongids'), 'niet-gevonden');
});

test('scanBrokers: lukt niets, dan een fout; een kostengrens heet overgeslagen, geen storing', async () => {
  const { db, user } = withUser();
  const broken = fakeSearch({ error: new ScanError('rate_limited') });
  await assert.rejects(scanBrokers({ db, user, search: broken }), (error) => error.code === 'search_rate_limited');
  assert.ok(brokerOverview(db, user.id).filter((row) => row.broker.access === 'search').every((row) => row.status === 'niet-toegankelijk'));

  const capped = fakeSearch({ error: new ScanError('budget') });
  await assert.rejects(scanBrokers({ db, user, search: capped }), (error) => error.code === 'search_budget');
  assert.ok(brokerOverview(db, user.id).filter((row) => row.broker.access === 'search').every((row) => row.status === 'overgeslagen'));

  await assert.rejects(scanBrokers({ db, user: { ...user, name: '..' }, search: capped }), (error) => error.code === 'name_too_short');
});

test('aan het eind van een scan telt elke databrokerpagina één keer, met alle gegevens waarmee hij gevonden is', () => {
  const { db, user } = withUser();
  const second = { ...PAGE, url: 'https://telefoonboek.nl/anna-de-vries-2' };
  const gids = { ...PAGE, url: 'https://www.detelefoongids.nl/anna/1/' };
  recordBrokerCheck(db, user.id, 'telefoonboek', { status: 'niet-gevonden' }, 50);
  recordBrokerCheck(db, user.id, 'detelefoongids', { status: 'niet-toegankelijk' }, 50);
  recordBrokerCheck(db, user.id, 'spokeo', { status: 'niet-gevonden' }, 50);
  saveWebResults(db, user.id, [PAGE], 50, { via: 'naam' });
  saveWebResults(db, user.id, [PAGE, second], 50, { via: 'telefoon' });
  saveWebResults(db, user.id, [gids], 50, { via: 'e-mail' });
  saveWebResults(db, user.id, [{ ...PAGE, url: 'https://example.org/blog' }], 50, { via: 'naam' }); // geen databroker
  saveWebResults(db, user.id, [{ ...PAGE, url: 'https://www.192.com/old' }], 40, { via: 'naam' }); // een eerdere scan

  assert.deepEqual(recordBrokerFindings(db, user.id, 50).sort(), ['detelefoongids', 'telefoonboek']);
  const overview = new Map(brokerOverview(db, user.id).map((row) => [row.broker.id, row]));
  assert.deepEqual([overview.get('telefoonboek').found, overview.get('telefoonboek').via], [2, ['naam', 'telefoon']]);
  assert.deepEqual([overview.get('detelefoongids').status, overview.get('detelefoongids').via], ['gevonden', ['e-mail']]);
  assert.equal(overview.get('spokeo').status, 'niet-gevonden');
  assert.equal(overview.get('192').status, 'nog-niet');
  // Alleen databrokers uit het register krijgen een regel.
  assert.deepEqual(db.prepare('SELECT broker_id FROM broker_checks ORDER BY broker_id').all().map((row) => row.broker_id),
    ['detelefoongids', 'spokeo', 'telefoonboek']);
  assert.deepEqual(brokersIn([PAGE, second, gids, { url: 'https://example.org' }]), ['telefoonboek', 'detelefoongids']);
});

// --- De resultatenpagina ---------------------------------------------------------------------------------

test('de resultatenpagina toont per databroker wat we weten, en bij elk webresultaat waarmee het gevonden is', async (t) => {
  const search = fakeSearch({
    results: (request) => (request.query.includes('site:telefoonboek.nl') ? [PAGE] : []),
  });
  const { db, base, mailer } = await startServer(t, { hibp: fakeHibp(), search });
  const cookie = await registerConfirmed(base, mailer, ANNA);

  const before = await (await send(base, '/resultaten', { cookie })).text();
  assert.match(before, /<h2>Databrokers en telefoongidsen<\/h2>/);
  assert.equal((before.match(/Nog niet gecontroleerd\./g) ?? []).length, BROKERS.filter((broker) => broker.access === 'search').length);
  assert.match(before, /Afgeschermd: er zijn geen openbare pagina's om te doorzoeken/);
  assert.match(before, /Het register is nagekeken op 26 november 2026/);

  await send(base, '/scan/deep', { method: 'POST', cookie });
  const html = await (await send(base, '/resultaten', { cookie })).text();
  assert.match(html, /<span class="badge badge-warn">1 met een mogelijke vermelding<\/span>/);
  const item = html.slice(html.indexOf('id="broker-telefoonboek"'), html.indexOf('id="broker-dasoertliche"'));
  assert.match(item, /state-warn">Mogelijke vermelding</);
  assert.match(item, /Laatst gecontroleerd op .*:\s+1 pagina, gevonden via je naam\./s);
  assert.match(item, /Verwerkt volgens eigen opgave: naam, telefoonnummer, adres\./);
  assert.match(item, /href="https:\/\/telefoonboek\.nl" target="_blank" rel="noopener noreferrer nofollow"/);
  const gids = html.slice(html.indexOf('id="broker-detelefoongids"'), html.indexOf('id="broker-telefoonboek"'));
  assert.match(gids, /state-ok">Niets gevonden</);
  assert.match(html, /Gevonden via je naam<\/span>/);
  assert.equal(db.prepare("SELECT status FROM broker_checks WHERE broker_id = 'telefoonboek'").get().status, 'gevonden');
});

test('op een openbare site zonder zoeken op naam zegt de kaart waarom er niets staat', async (t) => {
  const search = fakeSearch({ results: [] });
  const { base, mailer } = await startServer(t, { hibp: fakeHibp(), search, production: true });
  const cookie = await registerConfirmed(base, mailer, ANNA);
  await send(base, '/scan/deep', { method: 'POST', cookie });
  const html = await (await send(base, '/resultaten', { cookie })).text();
  assert.match(html, /Zoeken op naam staat op deze site uit\. Hier komt alleen iets te staan als we een databroker vinden via\s+je bevestigde telefoonnummer of e-mailadres/);
  // Er is niet op naam gezocht, dus ook niet bij databrokers.
  assert.ok(search.calls.every((call) => !call.query.includes('site:')));
});
