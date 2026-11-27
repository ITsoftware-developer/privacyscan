// Tests voor de Deep Scan: de scanner zelf (elke stap eindigt eerlijk), en de pagina's eromheen
// (de knop, het rapport, het bewijs bij elke bevinding, de limieten en de regels voor wie mag zoeken).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db.js';
import { describeStep } from '../src/engine.js';
import { lastRun, lastScan, listFindings, saveRun, setWebStatus } from '../src/findings.js';
import { ScanError } from '../src/scan-error.js';
import { runDeepScan } from '../src/scanner.js';
import {
  ADOBE, ANNA, CLUB, GAWKER, GIDS, NAAMGENOOT, fakeHibp, fakeSearch, register, registerConfirmed, send,
  sessionCookie, startServer,
} from './helpers.js';

const BRAM = { ...ANNA, naam: 'Bram Bakker', email: 'bram@example.com' };

// Ruim in het verleden, zodat "nu" (de tijd van een keuze die je maakt) altijd later is.
const T1 = Date.UTC(2025, 0, 15, 10, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

const USER = { id: 1, name: ANNA.naam, email: ANNA.email, city: 'Utrecht' };

function newDb(user = USER) {
  const db = openDatabase(':memory:');
  db.prepare(`INSERT INTO users (id, name, email, password_hash, created_at, email_confirmed_at, city)
              VALUES (?, ?, ?, 'x', 0, 1, ?)`).run(user.id, user.name, user.email, user.city);
  return db;
}

const deepScan = (db, {
  user = USER, hibp = fakeHibp(), search = fakeSearch({ name: 'brave' }), allowWeb = true, now = T1,
} = {}) => runDeepScan({ db, user, hibp, search, allowWeb, now });

const step = (run, id) => run.steps.find((item) => item.id === id);
const statuses = (run) => Object.fromEntries(run.steps.map((item) => [item.id, item.status]));
const dayText = (ms) => new Date(ms).toLocaleDateString('nl-NL', { day: 'numeric', month: 'long', year: 'numeric' });
const count = (db, table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;

// --- De scanner ---------------------------------------------------------------------------

test('een Deep Scan zonder problemen: wat kan is voltooid, en wat niet kan zegt waarom', async () => {
  const db = newDb();
  const hibp = fakeHibp({ breaches: [GAWKER, ADOBE] });
  const search = fakeSearch({ results: [CLUB, GIDS, NAAMGENOOT], name: 'brave' });

  const run = await deepScan(db, { hibp, search });

  assert.deepEqual(statuses(run), {
    datalekken: 'done',
    web: 'done',
    databrokers: 'done',
    'sociale-media': 'done',
    documenten: 'done',
    telefoon: 'skipped', // geen bevestigd telefoonnummer
    'e-mail': 'skipped', // geen toestemming om op het e-mailadres te zoeken
    paginas: 'unavailable', // pagina's lezen staat uit in deze tests
    ai: 'unavailable', // er is geen AI ingesteld
    darkweb: 'unavailable',
    blootstelling: 'done',
    verificatie: 'done',
  });
  assert.equal(run.ranAt, T1);
  assert.deepEqual(run.steps.map((item) => item.title), [
    'Datalekdatabases onderzoeken', 'Openbare internetbronnen onderzoeken', 'Databrokers controleren',
    'Sociale media onderzoeken', 'Openbare documenten zoeken', 'Telefoonnummer onderzoeken',
    'E-mailadres op het web zoeken', 'Gevonden pagina\'s zelf controleren', 'AI-analyse en vervolgonderzoek',
    'Darkwebbronnen', 'Mogelijke blootstelling beoordelen',
    'Bewijs controleren en combineren',
  ]);
  assert.equal(step(run, 'datalekken').note, '2 datalekken gevonden bij Have I Been Pwned, waarvan 2 nieuw.');
  // De nep-zoekdienst geeft overal dezelfde drie resultaten, en geen daarvan staat op een databrokersite.
  assert.match(step(run, 'databrokers').note, /^Bij 14 databrokers gaf de zoekmachine niets\. Dat betekent niet dat ze niets over je hebben: wat niet in een zoekmachine staat, zien we niet\. Afgeschermd \(niet te doorzoeken\): Pipl\.$/);
  assert.match(step(run, 'web').note, /3 mogelijke vermeldingen gevonden, waarvan 3 nieuw/);
  assert.match(step(run, 'telefoon').note, /geen bevestigd telefoonnummer/);
  assert.match(step(run, 'e-mail').note, /niet gekozen om ook op je e-mailadres te zoeken/);
  assert.match(step(run, 'darkweb').note, /geen geautoriseerde aanbieder/);
  assert.equal(
    step(run, 'blootstelling').note,
    'De lekken bevatten soorten gegevens als: inloggegevens (in 2 lekken). Of jouw eigen gegevens daarbij zaten, melden de bronnen niet.',
  );
  assert.equal(
    step(run, 'verificatie').note,
    '5 bevindingen gecontroleerd op bron, datum en beoordeling: elk heeft een bron, een datum en een beoordeling. '
      + 'Dit controleert ons eigen bewijs, niet of de inhoud van de bron klopt: dat zie je pas als je de link opent. '
      + 'Combineren: 0 webresultaten zijn met meer dan één van je gegevens gevonden, en 0 zijn een sterke overeenkomst '
      + '(je bevestigde e-mailadres of telefoonnummer staat erin).',
  );
  assert.deepEqual(run.exposure.map((group) => [group.id, group.breaches]), [['inloggegevens', ['Adobe', 'Gawker']]]);

  // Gezocht is alleen op de gegevens van het account: de naam (met woonplaats), twee groepjes
  // databrokers, sociale media en documenten. Het rapport is bewaard.
  assert.deepEqual(hibp.calls, [USER.email]);
  assert.equal(search.calls.length, 5);
  for (const call of search.calls) assert.match(call.query, /Anna de Vries/);
  assert.deepEqual(lastRun(db, USER.id), run);
});

test('elke bevinding krijgt een bron, een datum en een zekerheid, met uitleg', async () => {
  const db = newDb();
  const hibp = fakeHibp({ breaches: [ADOBE] });
  const search = fakeSearch({ results: [CLUB, GIDS, NAAMGENOOT], name: 'brave' });
  await deepScan(db, { hibp, search });

  const { breaches, web } = listFindings(db, USER.id);
  assert.deepEqual(breaches.map((item) => [item.title, item.source_id, item.confidence, item.checked_at]), [
    ['Adobe', 'hibp', 'hoog', T1],
  ]);
  assert.match(breaches[0].confidence_note, /letterlijke overeenkomst/);

  assert.equal(web.length, 3);
  for (const item of web) {
    assert.equal(item.source_id, 'brave');
    assert.equal(item.checked_at, T1);
    assert.ok(['hoog', 'gemiddeld', 'laag', 'geen'].includes(item.confidence), item.title);
    assert.ok(item.confidence_note.length > 20, item.title);
  }
  const named = (title) => web.find((item) => item.title === title);
  // Een naam, ook met woonplaats, blijft een mogelijke overeenkomst: nooit "hoog".
  assert.equal(named(GIDS.title).confidence, 'gemiddeld'); // je naam én Utrecht staan erin
  assert.equal(named(CLUB.title).confidence, 'laag'); // alleen je naam
  assert.ok(web.every((item) => item.confidence !== 'hoog'));
});

test('de demo-zoekdienst is "Voltooid (demo)": de resultaten zijn verzonnen en dat staat erbij', async () => {
  const db = newDb();
  const search = fakeSearch({ results: [CLUB, GIDS], isDemo: true, name: 'demo' });
  const run = await deepScan(db, { search });

  const web = step(run, 'web');
  assert.equal(web.status, 'done');
  assert.equal(web.demo, true);
  assert.equal(describeStep(web).label, 'Voltooid (demo)');
  assert.match(web.note, /^Demo: 2 verzonnen resultaten\./);
  assert.deepEqual(web.sources, ['demo']);

  for (const item of listFindings(db, USER.id).web) {
    assert.equal(item.source_id, 'demo');
    assert.equal(item.confidence, 'demo'); // geen zekerheid te geven over nepdata
  }
});

test('de databrokerstap: voltooid als er gezocht kon worden, anders eerlijk waarom niet', async () => {
  const situaties = [
    [{ hibp: fakeHibp({ breaches: [ADOBE] }), search: fakeSearch({ results: [CLUB], name: 'brave' }) }, 'done', ['brave']],
    [{ hibp: fakeHibp({ error: new ScanError('unavailable') }), search: fakeSearch({ error: new Error('stuk') }) }, 'unreachable', ['nep']],
    [{ hibp: fakeHibp({ hasKey: false }), search: fakeSearch({ isDemo: true }), allowWeb: false }, 'skipped', []],
    [{ hibp: fakeHibp(), search: null }, 'unavailable', []],
  ];
  for (const [situatie, status, sources] of situaties) {
    const run = await deepScan(newDb(), situatie);
    assert.equal(step(run, 'databrokers').status, status, status);
    assert.deepEqual(step(run, 'databrokers').sources, sources, status);
  }
});

for (const [code, reason] of [
  ['unavailable', /niet bereikbaar/],
  ['rate_limited', /limiet/],
  ['bad_key', /sleutel/],
  ['busy', /tegelijk/],
  ['unexpected', /onverwacht antwoord/],
]) {
  test(`geeft de bron van datalekken "${code}", dan is die stap niet toegankelijk en loopt de rest door`, async () => {
    const db = newDb();
    const hibp = fakeHibp({ error: new ScanError(code) });
    const search = fakeSearch({ results: [CLUB], name: 'brave' });

    const run = await deepScan(db, { hibp, search });

    const breaches = step(run, 'datalekken');
    assert.equal(breaches.status, 'unreachable');
    assert.equal(describeStep(breaches).label, 'Niet toegankelijk');
    assert.match(breaches.note, reason);
    assert.deepEqual(breaches.sources, ['hibp']); // de bron is wel geprobeerd
    assert.ok(!JSON.stringify(run).includes(USER.email));

    // Een stap die niet lukt, stopt de rest niet. Maar er is niets om te beoordelen.
    assert.equal(step(run, 'web').status, 'done');
    assert.equal(step(run, 'blootstelling').status, 'skipped');
    assert.equal(lastScan(db, USER.id, 'breach'), null);
  });
}

test('lukt de bron niet, dan blijft wat we eerder vonden staan, met de datum van toen erbij', async () => {
  const db = newDb();
  await deepScan(db, { hibp: fakeHibp({ breaches: [ADOBE] }), now: T1 });

  const run = await deepScan(db, { hibp: fakeHibp({ error: new ScanError('unavailable') }), now: T1 + 3 * DAY });

  assert.equal(step(run, 'datalekken').status, 'unreachable');
  assert.equal(step(run, 'blootstelling').status, 'done');
  assert.ok(step(run, 'blootstelling').note.endsWith(`Gebaseerd op de controle van ${dayText(T1)}.`));
  // Het lek is niet opnieuw onderzocht, dus het houdt de oude datum.
  assert.equal(listFindings(db, USER.id).breaches[0].checked_at, T1);
  assert.equal(lastScan(db, USER.id, 'breach').ran_at, T1);
});

test('zonder bron voor dit adres is de stap "niet beschikbaar", en er wordt niets verstuurd', async () => {
  const db = newDb();
  const hibp = fakeHibp({ hasKey: false });
  const run = await deepScan(db, { hibp });

  const breaches = step(run, 'datalekken');
  assert.equal(breaches.status, 'unavailable');
  assert.equal(describeStep(breaches).label, 'Niet beschikbaar');
  assert.match(breaches.note, /geen bron beschikbaar/);
  assert.deepEqual(hibp.calls, []);
  assert.equal(lastScan(db, USER.id, 'breach'), null);
});

test('mag er niet op naam gezocht worden, dan wordt die stap overgeslagen en gaat er niets naar buiten', async () => {
  const db = newDb();
  const search = fakeSearch({ results: [CLUB, GIDS], name: 'brave' });
  const run = await deepScan(db, { hibp: fakeHibp({ breaches: [ADOBE] }), search, allowWeb: false });

  const web = step(run, 'web');
  assert.equal(web.status, 'skipped');
  assert.equal(describeStep(web).label, 'Overgeslagen');
  assert.match(web.note, /openbare site/);
  assert.deepEqual(web.sources, []); // niet eens geprobeerd
  assert.deepEqual(search.calls, []);
  assert.equal(lastScan(db, USER.id, 'web'), null);
  assert.deepEqual(listFindings(db, USER.id).web, []);
  assert.equal(step(run, 'datalekken').status, 'done'); // de rest loopt gewoon
});

test('een naam met te weinig letters wordt overgeslagen, zonder iets te zoeken', async () => {
  const user = { ...USER, name: 'A' };
  const db = newDb(user);
  const search = fakeSearch({ results: [CLUB] });
  const run = await deepScan(db, { user, search });

  assert.equal(step(run, 'web').status, 'skipped');
  assert.match(step(run, 'web').note, /te weinig letters/);
  assert.deepEqual(search.calls, []);
});

test('geeft de zoekdienst een fout, dan staat dat in het rapport, zonder de details van de dienst', async () => {
  const db = newDb();
  const search = fakeSearch({ error: new Error('geheim-token-123 geweigerd') });
  const run = await deepScan(db, { search });

  assert.equal(step(run, 'web').status, 'unreachable');
  assert.equal(step(run, 'web').note, 'De zoekdienst gaf een fout.');
  assert.doesNotMatch(JSON.stringify(run), /geheim-token-123/);
});

test('een onverwachte fout is "Mislukt": geen details in het rapport, en geen adres in het logboek', async (t) => {
  const logged = [];
  t.mock.method(console, 'error', (...args) => logged.push(args.join(' ')));
  const db = newDb();
  const hibp = fakeHibp();
  hibp.breachesFor = async () => { throw new TypeError('kapot intern\nregel twee met geheim'); };

  const run = await deepScan(db, { hibp, search: fakeSearch({ results: [CLUB], name: 'brave' }) });

  const breaches = step(run, 'datalekken');
  assert.equal(breaches.status, 'failed');
  assert.equal(describeStep(breaches).label, 'Mislukt');
  assert.equal(breaches.note, 'Er ging iets mis in de scanner. Kijk in de terminal van de server.');
  assert.doesNotMatch(JSON.stringify(run), /kapot intern|geheim/);

  // In de terminal staat de soort fout en alleen de eerste regel, nooit een adres.
  assert.equal(logged.length, 1);
  assert.match(logged[0], /^Deep Scan: onverwachte fout \(TypeError\): kapot intern$/);
  assert.ok(!logged[0].includes(USER.email));

  assert.equal(step(run, 'web').status, 'done'); // de rest loopt door
});

test('als niets lukt, krijg je toch een compleet rapport zonder één valse "voltooid"', async () => {
  const db = newDb();
  const run = await deepScan(db, {
    hibp: fakeHibp({ error: new ScanError('unavailable') }),
    search: fakeSearch({ error: new Error('stuk') }),
  });

  assert.deepEqual(statuses(run), {
    datalekken: 'unreachable',
    web: 'unreachable',
    databrokers: 'unreachable',
    'sociale-media': 'unreachable',
    documenten: 'unreachable',
    telefoon: 'skipped',
    'e-mail': 'skipped',
    paginas: 'unavailable', // pagina's lezen staat uit in deze tests
    ai: 'unavailable', // er is geen AI ingesteld
    darkweb: 'unavailable',
    blootstelling: 'skipped',
    verificatie: 'skipped',
  });
  assert.equal(run.steps.filter((item) => item.status === 'done').length, 0);
  assert.deepEqual(run.exposure, []);
  assert.match(step(run, 'verificatie').note, /geen bevindingen om te controleren/);
  assert.deepEqual(lastRun(db, USER.id), run); // ook dit rapport is bewaard
});

test('een tweede Deep Scan zet niets dubbel, en werkt de datum van het onderzoek bij', async () => {
  const db = newDb();
  const hibp = fakeHibp({ breaches: [ADOBE] });
  const search = fakeSearch({ results: [CLUB], name: 'brave' });
  await deepScan(db, { hibp, search, now: T1 });
  const run = await deepScan(db, { hibp, search, now: T1 + DAY });

  assert.equal(step(run, 'datalekken').note, '1 datalek gevonden bij Have I Been Pwned.'); // niets nieuws
  assert.equal(step(run, 'web').added, 0);
  assert.equal(count(db, 'findings'), 2);
  for (const row of db.prepare('SELECT found_at, checked_at FROM findings').all()) {
    assert.equal(row.found_at, T1); // wanneer we het voor het eerst vonden
    assert.equal(row.checked_at, T1 + DAY); // wanneer we het voor het laatst onderzochten
  }
  assert.equal(count(db, 'scan_runs'), 1); // één rapport per gebruiker: het nieuwste
  assert.equal(lastRun(db, USER.id).ranAt, T1 + DAY);
});

test('jouw keuze bij een resultaat verandert niet wanneer het onderzocht is, en blijft na een nieuwe scan', async () => {
  const db = newDb();
  const search = fakeSearch({ results: [CLUB], name: 'brave' });
  await deepScan(db, { search, now: T1 });

  const [first] = listFindings(db, USER.id).web;
  assert.equal(setWebStatus(db, USER.id, first.id, 'mine'), true);
  const chosen = listFindings(db, USER.id).web[0];
  assert.equal(chosen.status, 'mine');
  assert.equal(chosen.checked_at, T1); // updated_at is nu, checked_at niet

  await deepScan(db, { search, now: T1 + DAY });
  const again = listFindings(db, USER.id).web[0];
  assert.equal(again.status, 'mine');
  assert.equal(again.checked_at, T1 + DAY);
});

test('de verificatie is echt: een bevinding zonder bewijs valt op in het rapport', async () => {
  const db = newDb();
  // Zo ziet een bevinding eruit die nergens een bron, datum of zekerheid kreeg.
  db.prepare(`INSERT INTO findings (user_id, kind, source_key, title, found_at, updated_at)
              VALUES (1, 'breach', 'Oud lek', 'Oud lek', 0, 0)`).run();

  const run = await deepScan(db, { hibp: fakeHibp({ breaches: [ADOBE] }) });

  const verification = step(run, 'verificatie');
  assert.equal(verification.status, 'done');
  assert.match(verification.note, /^2 bevindingen gecontroleerd op bron, datum en beoordeling\. Let op: /);
  assert.match(verification.note, /1 zonder bron/);
  assert.match(verification.note, /1 zonder datum/);
  assert.match(verification.note, /1 zonder beoordeling/);
  assert.match(verification.note, /1 zonder directe link/);
  assert.doesNotMatch(verification.note, /elk heeft een bron/);
  // De stap belooft niet meer dan hij doet: hij controleert ons eigen bewijs, niet de bron zelf.
  assert.match(verification.note, /niet of de inhoud van de bron klopt/);
});

test('het bewaarde rapport bevat geen e-mailadres, naam of woonplaats', async () => {
  const db = newDb();
  await deepScan(db, {
    hibp: fakeHibp({ breaches: [ADOBE] }),
    search: fakeSearch({ results: [CLUB, GIDS], name: 'brave' }),
  });
  const row = db.prepare('SELECT steps, exposure FROM scan_runs WHERE user_id = 1').get();
  assert.doesNotMatch(`${row.steps} ${row.exposure}`, /anna@example\.com|Anna de Vries|Utrecht/i);
});

// --- De knop en de pagina's ---------------------------------------------------------------

const deep = (base, cookie, extra = {}) => send(base, '/scan/deep', { method: 'POST', cookie, ...extra });
const breachScan = (base, cookie) => send(base, '/scan/datalekken', { method: 'POST', cookie });
const webScan = (base, cookie) => send(base, '/scan/web', { method: 'POST', cookie });
const body = async (base, path, cookie) => (await send(base, path, { cookie })).text();

// De zichtbare tekst van een pagina: zonder tags, met enkele spaties en zonder spatie voor leestekens.
const READABLE = (html) => html
  .replace(/<[^>]+>/g, ' ')
  .replace(/\s+/g, ' ')
  .replace(/\s+([.,;:)])/g, '$1');

// De stappen van het rapport zoals de bezoeker ze ziet: titel, kleur en status in tekst.
function stepsIn(html) {
  return [...html.matchAll(/<span class="engine-name">([^<]*)<\/span>[\s\S]*?<span class="state state-(\w+)">([^<]*)<\/span>/g)]
    .map(([, title, tone, label]) => ({ title: title.replace(/&#39;/g, "'"), tone, label }));
}

// Een site met een bevestigd account van Anna, op je eigen computer.
async function site(t, {
  hibp = fakeHibp({ breaches: [ADOBE] }), search = fakeSearch({ results: [CLUB, GIDS], name: 'brave' }), ...options
} = {}) {
  const server = await startServer(t, { hibp, search, ...options });
  const cookie = await registerConfirmed(server.base, server.mailer);
  return { ...server, hibp, search, cookie };
}

// Een openbare site (production) waarvan Anna de beheerder is.
async function online(t, options = {}) {
  const search = fakeSearch({ results: [CLUB, GIDS], name: 'brave' });
  const server = await startServer(t, {
    production: true, ownerEmail: ANNA.email, hibp: fakeHibp({ breaches: [ADOBE] }), search, ...options,
  });
  return { ...server, search };
}

test('de Deep Scan vraagt om inloggen en een bevestigd e-mailadres, en doet tot die tijd niets', async (t) => {
  const hibp = fakeHibp({ breaches: [ADOBE] });
  const search = fakeSearch({ results: [CLUB] });
  const { db, base } = await startServer(t, { hibp, search });

  const anonymous = await deep(base);
  assert.equal(anonymous.status, 303);
  assert.equal(anonymous.headers.get('location'), '/inloggen');

  const cookie = sessionCookie(await register(base));
  const unconfirmed = await deep(base, cookie);
  assert.equal(unconfirmed.status, 403);
  assert.match(await unconfirmed.text(), /Bevestig eerst je e-mailadres/);

  assert.deepEqual(hibp.calls, []);
  assert.deepEqual(search.calls, []);
  assert.equal(count(db, 'scan_runs'), 0);

  // Ook op het dashboard staat dan geen knop, maar de uitleg.
  const dashboard = READABLE(await body(base, '/dashboard', cookie));
  assert.doesNotMatch(dashboard, /Start Deep Scan/);
  assert.match(dashboard, /Bevestig eerst je e-mailadres\. Daarna kun je hier alles in één keer onderzoeken/);
});

test('een Deep Scan vanaf een andere website wordt geweigerd (CSRF)', async (t) => {
  const { base, cookie, hibp, search, db } = await site(t);

  for (const headers of [
    { fetchSite: 'cross-site', origin: 'https://andere-site.example' },
    { fetchSite: null, origin: 'null' },
    { fetchSite: null, origin: null },
  ]) {
    assert.equal((await deep(base, cookie, headers)).status, 403, JSON.stringify(headers));
  }
  assert.deepEqual(hibp.calls, []);
  assert.deepEqual(search.calls, []);
  assert.equal(count(db, 'scan_runs'), 0);
});

test('de Deep Scan zoekt alleen op de gegevens van je eigen account, ook als je er zelf iets bij stuurt', async (t) => {
  const { base, cookie, hibp, search } = await site(t);

  await deep(base, cookie, {
    fields: { email: 'ander@example.com', naam: 'Iemand Anders', q: 'iemand anders', woonplaats: 'Rotterdam' },
  });

  assert.deepEqual(hibp.calls, [ANNA.email]);
  assert.equal(search.calls.length, 5); // naam, twee groepjes databrokers, sociale media, documenten
  for (const call of search.calls) assert.equal(call.name, ANNA.naam);
  assert.doesNotMatch(JSON.stringify(search.calls), /Iemand Anders|Rotterdam|ander@example\.com/);
});

test('na de Deep Scan zie je het rapport: elke stap met zijn eerlijke stand', async (t) => {
  const { base, cookie } = await site(t);

  const response = await deep(base, cookie);
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), '/resultaten?gescand=deep#rapport');

  const html = await body(base, '/resultaten?gescand=deep', cookie);
  const text = READABLE(html);
  assert.match(text, /Deep Scan klaar: 7 van 12 stappen voltooid\./);
  assert.match(html, /<div id="rapport" class="report">/);
  assert.match(text, /Rapport van je laatste Deep Scan/);
  assert.deepEqual(stepsIn(html), [
    { title: 'Datalekdatabases onderzoeken', tone: 'ok', label: 'Voltooid' },
    { title: 'Openbare internetbronnen onderzoeken', tone: 'ok', label: 'Voltooid' },
    { title: 'Databrokers controleren', tone: 'ok', label: 'Voltooid' },
    { title: 'Sociale media onderzoeken', tone: 'ok', label: 'Voltooid' },
    { title: 'Openbare documenten zoeken', tone: 'ok', label: 'Voltooid' },
    { title: 'Telefoonnummer onderzoeken', tone: 'warn', label: 'Overgeslagen' },
    { title: 'E-mailadres op het web zoeken', tone: 'warn', label: 'Overgeslagen' },
    { title: 'Gevonden pagina\'s zelf controleren', tone: 'warn', label: 'Niet beschikbaar' },
    { title: 'AI-analyse en vervolgonderzoek', tone: 'warn', label: 'Niet beschikbaar' },
    { title: 'Darkwebbronnen', tone: 'warn', label: 'Niet beschikbaar' },
    { title: 'Mogelijke blootstelling beoordelen', tone: 'ok', label: 'Voltooid' },
    { title: 'Bewijs controleren en combineren', tone: 'ok', label: 'Voltooid' },
  ]);
  assert.match(text, /1 datalek gevonden bij Have I Been Pwned, waarvan 1 nieuw\./);
  assert.match(text, /Bij 14 databrokers gaf de zoekmachine niets\./);
  assert.match(text, /Wat nog niet bestaat, noemen we nooit voltooid\./);
  assert.match(html, /<a href="\/bronnen">Bronnen en roadmap<\/a>/);
});

test('het rapport zegt welke soorten gegevens gelekt zijn, nooit de gegevens zelf', async (t) => {
  const { base, cookie } = await site(t);
  await deep(base, cookie);

  const text = READABLE(await body(base, '/resultaten', cookie));
  assert.match(text, /Mogelijk blootgestelde gegevens 1 soort Inloggegevens/);
  assert.match(text, /Inloggegevens Zat in: Adobe/);
  assert.match(text, /Had je bij deze diensten een account, gebruik dat wachtwoord dan nergens meer/);
  // We beweren niet dat dit van jou gelekt is: een lek zegt welke soorten gegevens erin zaten.
  assert.match(text, /We zien welke soorten gegevens een lek bevatte, niet de gegevens zelf en niet wat er van jou in stond/);
  assert.doesNotMatch(text, /in handen van anderen/);
});

test('bij elke bevinding staat de bron, de datum van het onderzoek en de zekerheid', async (t) => {
  const { base, cookie, db } = await site(t);
  db.prepare("UPDATE users SET city = 'Utrecht'").run();
  await deep(base, cookie);

  const html = await body(base, '/resultaten', cookie);
  const blocks = html.match(/<dl class="evidence" aria-label="Bewijs bij deze bevinding">[\s\S]*?<\/dl>/g) ?? [];
  assert.equal(blocks.length, count(db, 'findings')); // 1 datalek en 2 webresultaten: bij elk een blok
  assert.equal(blocks.length, 3);
  for (const block of blocks) {
    assert.match(block, /<dt>Bron<\/dt>/);
    assert.match(block, /<dt>Onderzocht op<\/dt>/);
    assert.match(block, /<dt>Zekerheid<\/dt>|<dt>Overeenkomst met je gegevens<\/dt>/);
    assert.doesNotMatch(block, /onbekend|Niet beoordeeld/);
  }
  // Een datalek heeft een zekerheid, een webresultaat een overeenkomst en jouw eigen oordeel.
  assert.equal(blocks.filter((block) => /<dt>Zekerheid<\/dt>/.test(block)).length, 1);
  assert.equal(blocks.filter((block) => /<dt>Jouw oordeel<\/dt>/.test(block)).length, 2);

  const text = READABLE(html);
  assert.match(text, /Bron Have I Been Pwned Onderzocht op \d+ \w+ \d{4} om \d{2}:\d{2} Zekerheid Hoog · De bron zegt dat dit e-mailadres in dit lek staat/);
  // De telefoongids noemt je naam én Utrecht, de club alleen je naam: allebei een mogelijke overeenkomst.
  assert.match(text, /Overeenkomst met je gegevens Mogelijke overeenkomst · Je volledige naam én je woonplaats staan in de titel of het fragment/);
  assert.match(text, /Overeenkomst met je gegevens Zwakke overeenkomst · Je volledige naam staat erin, je woonplaats niet/);
  assert.match(text, /Jouw oordeel Nog niet beoordeeld/);
  assert.doesNotMatch(text, /Sterke overeenkomst/); // een naam alleen, ook met woonplaats, is nooit "sterk"
});

test('een bevinding uit de tijd voor het bewijs zegt eerlijk dat bron en beoordeling ontbreken', async (t) => {
  const { base, cookie, db } = await site(t);
  await deep(base, cookie);
  // Zo ziet een webresultaat eruit dat bewaard is voordat er bewijs bij hoorde.
  db.prepare(`UPDATE findings SET source_id = NULL, confidence = NULL, confidence_note = NULL, checked_at = NULL
              WHERE title = ?`).run(CLUB.title);

  const text = READABLE(await body(base, '/resultaten', cookie));
  assert.match(text, /Bron niet bekend \(gevonden voor deze functie bestond\) Onderzocht op onbekend Overeenkomst met je gegevens Niet beoordeeld/);
});

test('zonder Deep Scan staat er op de resultatenpagina en het dashboard dat je er nog geen deed', async (t) => {
  const { base, cookie } = await site(t);

  const results = await body(base, '/resultaten', cookie);
  assert.match(READABLE(results), /Deep Scan Nog niet gedaan Je hebt nog geen Deep Scan gedaan\./);
  assert.doesNotMatch(results, /Rapport van je laatste Deep Scan|Mogelijk blootgestelde gegevens/);
  assert.deepEqual(stepsIn(results), []);

  const dashboard = await body(base, '/dashboard', cookie);
  assert.match(READABLE(dashboard), /Deep Scan Nog niet gedaan/);
  assert.match(dashboard, /<form method="post" action="\/scan\/deep">/);
  assert.doesNotMatch(dashboard, /Je laatste Deep Scan|Laatst gedaan op/);
  // Zonder run geen melding, ook niet als iemand ?gescand=deep in de adresbalk zet.
  const nothing = READABLE(await body(base, '/resultaten?gescand=deep', cookie));
  assert.doesNotMatch(nothing, /Deep Scan klaar/);
});

test('na een Deep Scan toont het dashboard de laatste stappen en de datum', async (t) => {
  const { base, cookie } = await site(t);
  await deep(base, cookie);

  const dashboard = await body(base, '/dashboard', cookie);
  const text = READABLE(dashboard);
  assert.match(text, /Deep Scan Laatst gedaan op \d+ \w+ \d{4} om \d{2}:\d{2}/);
  assert.match(text, /Je laatste Deep Scan/);
  assert.equal(stepsIn(dashboard).length, 12);
  assert.match(dashboard, /<a href="\/resultaten#rapport">Bekijk het volledige rapport<\/a>/);
  // De voortgang bovenaan laat zien wat er is en wat er nog niet is.
  assert.match(dashboard, /<li class="step done"><span class="step-dot" aria-hidden="true">✓<\/span>Fundament<\/li>/);
  // Fase 3 is begonnen, niet klaar.
  assert.match(dashboard, /<li class="step"><span class="step-dot" aria-hidden="true">3<\/span>Databrokers<\/li>/);
  assert.match(dashboard, /<li class="step"><span class="step-dot" aria-hidden="true">5<\/span>AI-agent<\/li>/);
  assert.doesNotMatch(dashboard, /Verwijderverzoeken|Fase 3|laten verwijderen/);
});

test('is een bron niet bereikbaar, dan staat dat eerlijk in het rapport en blijft de rest werken', async (t) => {
  const hibp = fakeHibp({ error: new ScanError('rate_limited') });
  const { base, cookie } = await site(t, { hibp });

  const response = await deep(base, cookie);
  assert.equal(response.status, 303); // de scan zelf is gelukt: de uitkomst staat in het rapport

  const html = await body(base, '/resultaten?gescand=deep', cookie);
  assert.match(READABLE(html), /Deep Scan klaar: 5 van 12 stappen voltooid\./);
  assert.deepEqual(stepsIn(html).map((item) => [item.tone, item.label]), [
    ['bad', 'Niet toegankelijk'],
    ['ok', 'Voltooid'],
    ['ok', 'Voltooid'],
    ['ok', 'Voltooid'],
    ['ok', 'Voltooid'],
    ['warn', 'Overgeslagen'],
    ['warn', 'Overgeslagen'],
    ['warn', 'Niet beschikbaar'], // pagina's zelf lezen staat uit in deze tests
    ['warn', 'Niet beschikbaar'], // geen AI
    ['warn', 'Niet beschikbaar'],
    ['warn', 'Overgeslagen'],
    ['ok', 'Voltooid'],
  ]);
  assert.match(READABLE(html), /De bron staat nu geen aanvragen meer toe \(limiet bereikt\)/);
});

test('de Deep Scan telt mee voor de limieten van de datalek- en webzoekopdrachten', async (t) => {
  const { base, cookie, hibp } = await site(t, { scanLimit: 2 });

  assert.equal((await deep(base, cookie)).status, 303); // telt als 1 datalekcontrole en 1 webzoekopdracht
  assert.equal((await breachScan(base, cookie)).status, 303); // de 2e datalekcontrole
  const blocked = await deep(base, cookie); // de 3e: te veel
  assert.equal(blocked.status, 429);
  const html = await blocked.text();
  assert.match(READABLE(html), /Je hebt het afgelopen uur al een paar keer gezocht/);
  assert.match(html, /Rapport van je laatste Deep Scan/); // het eerdere rapport blijft zichtbaar
  assert.equal(hibp.calls.length, 2); // er is niets extra naar de bron gestuurd
});

test('de Deep Scan en de losse webzoekopdracht delen dezelfde teller', async (t) => {
  const { base, cookie, search } = await site(t, { scanLimit: 1 });

  assert.equal((await deep(base, cookie)).status, 303);
  assert.equal((await webScan(base, cookie)).status, 429);
  assert.equal((await deep(base, cookie)).status, 429);
  assert.equal(search.calls.length, 5); // alleen de zoekopdrachten van die ene Deep Scan
});

test('op een openbare site slaat de Deep Scan het zoeken op naam over, behalve voor de beheerder', async (t) => {
  const { base, mailer, search } = await online(t);
  const bram = await registerConfirmed(base, mailer, BRAM);

  await deep(base, bram);
  const html = await body(base, '/resultaten?gescand=deep', bram);
  assert.deepEqual(stepsIn(html).map((item) => item.label), [
    'Voltooid', 'Overgeslagen', 'Overgeslagen', 'Overgeslagen', 'Overgeslagen', 'Overgeslagen', 'Overgeslagen',
    'Niet beschikbaar', 'Niet beschikbaar', 'Niet beschikbaar', 'Voltooid', 'Voltooid',
  ]);
  assert.match(READABLE(html), /Zoeken op naam staat uit op een openbare site/);
  assert.deepEqual(search.calls, []); // de naam van Bram is nergens heen gestuurd

  const anna = await registerConfirmed(base, mailer);
  await deep(base, anna);
  assert.equal(search.calls.length, 5);
  for (const call of search.calls) assert.equal(call.name, ANNA.naam);
  const own = await body(base, '/resultaten', anna);
  assert.deepEqual(stepsIn(own).map((item) => item.label), [
    'Voltooid', 'Voltooid', 'Voltooid', 'Voltooid', 'Voltooid', 'Overgeslagen', 'Overgeslagen', 'Niet beschikbaar',
    'Niet beschikbaar', 'Niet beschikbaar', 'Voltooid', 'Voltooid',
  ]);
});

test('het rapport van de één is niet te zien voor een ander', async (t) => {
  const { base, mailer, cookie } = await site(t);
  const bram = await registerConfirmed(base, mailer, BRAM);
  await deep(base, cookie);

  const text = READABLE(await body(base, '/resultaten', bram));
  assert.match(text, /Je hebt nog geen Deep Scan gedaan/);
  assert.doesNotMatch(text, /Rapport van je laatste Deep Scan|Adobe/);
});

test('een stand die we niet kennen, staat als "Onbekend" op de pagina, en tekst uit de database wordt onschadelijk gemaakt', async (t) => {
  const { base, cookie, db } = await site(t);
  const userId = db.prepare('SELECT id FROM users WHERE email = ?').get(ANNA.email).id;
  saveRun(db, userId, {
    ranAt: T1,
    steps: [
      { id: 'web', status: 'klaar', note: '<img src=x onerror=alert(1)>' },
      { id: 'databrokers', status: 'planned', note: 'Nog niet.' },
    ],
    exposure: [],
  });

  const html = await body(base, '/resultaten', cookie);
  assert.deepEqual(stepsIn(html).map((item) => item.label), ['Onbekend', 'Nog niet gebouwd']);
  assert.doesNotMatch(html, /state-ok">Voltooid/);
  assert.doesNotMatch(html, /<img src=x/);
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
});

test('een kapot bewaard rapport laat de pagina niet kapotgaan', async (t) => {
  const { base, cookie, db } = await site(t);
  await deep(base, cookie);
  db.prepare("UPDATE scan_runs SET steps = 'dit is geen json'").run();

  for (const path of ['/resultaten', '/resultaten?gescand=deep', '/dashboard']) {
    const response = await send(base, path, { cookie });
    assert.equal(response.status, 200, path);
    const html = await response.text();
    assert.match(READABLE(html), /Deep Scan Nog niet gedaan/, path);
    assert.deepEqual(stepsIn(html), [], path);
  }
});

test('een account verwijderen wist ook het rapport van de Deep Scan', async (t) => {
  const { base, cookie, db } = await site(t);
  await deep(base, cookie);
  assert.equal(count(db, 'scan_runs'), 1);

  db.prepare('DELETE FROM users').run();
  assert.equal(count(db, 'scan_runs'), 0);
  assert.equal(count(db, 'findings'), 0);
});
