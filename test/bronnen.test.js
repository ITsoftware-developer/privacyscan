// Tests voor de openbare kant van de Research Engine: de startpagina (voor en na een controle)
// en de pagina /bronnen. Wat hier staat, mag nooit meer beloven dan er echt is.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBreachCheck } from '../src/breach-check.js';
import { createHibp } from '../src/hibp.js';
import { ScanError } from '../src/scan-error.js';
import { createXon } from '../src/xon.js';
import {
  ADOBE, fakeHibp, fakeXonFetch, jsonResponse, registerConfirmed, send, startServer, xonFound, xonRaw,
} from './helpers.js';

// De zichtbare tekst van een pagina: zonder tags, met enkele spaties en zonder spatie voor leestekens.
const READABLE = (html) => html
  .replace(/<[^>]+>/g, ' ')
  .replace(/\s+/g, ' ')
  .replace(/\s+([.,;:)])/g, '$1');

const check = (base, email) => send(base, '/controle', { method: 'POST', fields: { email } });

// De stappen van de Research Engine zoals de bezoeker ze ziet: [titel, status in tekst].
function stepsIn(html) {
  return [...html.matchAll(/<span class="engine-name">([^<]*)<\/span>[\s\S]*?<span class="state state-(\w+)">([^<]*)<\/span>/g)]
    .map(([, title, , label]) => [title, label]);
}

const labelsIn = (html) => stepsIn(html).map(([, label]) => label);

// Het bronnenregister zoals de bezoeker het ziet: { naam: stand }.
function registerIn(html) {
  const result = {};
  for (const [, block] of html.matchAll(/<li class="register-item">([\s\S]*?)<\/li>/g)) {
    const name = READABLE(block.match(/<span class="register-name">([\s\S]*?)<\/span>/)[1]).trim();
    result[name] = block.match(/<span class="state state-\w+">([^<]*)<\/span>/)[1];
  }
  return result;
}

// De site zoals hij draait zonder eigen HIBP-sleutel, met de gratis dienst aan (zie free-check.test.js).
function freeSite(xonAnswers = {}) {
  const xonFetch = fakeXonFetch(xonAnswers);
  const hibp = createBreachCheck({
    hibp: createHibp({ fetchImpl: async () => jsonResponse(200, []), minIntervalMs: 0 }),
    xon: createXon({ fetchImpl: xonFetch.impl, minIntervalMs: 0, log: () => {} }),
  });
  return { hibp, xonFetch };
}

const everythingInDatabase = (db) => db
  .prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()
  .map(({ name }) => JSON.stringify(db.prepare(`SELECT * FROM ${name}`).all())).join('\n');

// --- /bronnen -----------------------------------------------------------------------------

test('de bronnenpagina is openbaar en zegt eerlijk wat werkt en wat nog niet bestaat', async (t) => {
  const { base } = await startServer(t, { hibp: fakeHibp() });

  const response = await send(base, '/bronnen');
  assert.equal(response.status, 200);
  const html = await response.text();

  assert.deepEqual(registerIn(html), {
    'Have I Been Pwned': 'Actief',
    XposedOrNot: 'Uit',
    'Pwned Passwords': 'Actief',
    'Zoekdienst voor het web (Brave Search)': 'Demo (nepdata)',
    Databrokers: 'Gepland',
    'Sociale media': 'Gepland',
    'Openbare documenten': 'Gepland',
    Darkwebmonitoring: 'Gepland',
  });
  assert.match(READABLE(html), /Alleen wat hier Actief heet, werkt echt\./);
});

test('zonder HIBP-sleutel staat HIBP als "alleen testadressen"', async (t) => {
  const { base } = await startServer(t, { hibp: fakeHibp({ hasKey: false }) });

  const registry = registerIn(await (await send(base, '/bronnen')).text());
  assert.equal(registry['Have I Been Pwned'], 'Alleen testadressen');
  assert.equal(registry.XposedOrNot, 'Uit');
});

test('met de gratis dienst aan is XposedOrNot actief, en HIBP nog steeds niet', async (t) => {
  const { hibp } = freeSite();
  const { base } = await startServer(t, { hibp });

  const registry = registerIn(await (await send(base, '/bronnen')).text());
  assert.equal(registry.XposedOrNot, 'Actief');
  assert.equal(registry['Have I Been Pwned'], 'Alleen testadressen');
});

test('de roadmap heeft zes fases, waarvan er twee klaar zijn, en belooft geen verwijderdienst', async (t) => {
  const { base } = await startServer(t, { hibp: fakeHibp() });
  const html = await (await send(base, '/bronnen')).text();
  const text = READABLE(html);

  const phases = [...html.matchAll(/<strong>Fase (\d) · ([^<]*)<\/strong>\s*<span class="state state-\w+">([^<]*)<\/span>/g)]
    .map(([, number, name, state]) => [number, name, state]);
  assert.deepEqual(phases, [
    ['1', 'Veilig fundament', 'Klaar'],
    ['2', 'Breach Intelligence Engine', 'Klaar'],
    ['3', 'Data Broker Engine', 'Gepland'],
    ['4', 'Deep Research Engine', 'Gepland'],
    ['5', 'Eigen AI-agent', 'Gepland'],
    ['6', 'Continuous Monitoring', 'Gepland'],
  ]);

  // De principes staan er: niets verzinnen, eerlijk zijn, alleen eigen gegevens, alleen vinden.
  assert.match(text, /Niets verzonnen\./);
  assert.match(text, /We noemen nooit iets voltooid wat niet gedaan is\./);
  assert.match(text, /Onderzoek naar iemand anders, met diens toestemming, bestaat nog niet\./);
  assert.match(text, /Privacyscan verwijdert niets van het internet en stuurt geen verwijderverzoeken\./);
  assert.match(text, /Gegevens verwijderen en verwijderverzoeken versturen staan bewust niet op de roadmap/);
  // En nergens staat dat iets al voltooid is: dat woord hoort bij een gedane stap in een rapport.
  assert.doesNotMatch(text, /Voltooid/);
});

test('de bronnenpagina bevat geen persoonsgegevens, ook niet als je ingelogd bent', async (t) => {
  const { base, mailer } = await startServer(t, { hibp: fakeHibp({ breaches: [ADOBE] }) });
  const cookie = await registerConfirmed(base, mailer);

  const html = await (await send(base, '/bronnen', { cookie })).text();
  assert.doesNotMatch(html, /anna@example\.com|Anna de Vries/);
});

test('elke openbare pagina heeft onderaan een link naar de bronnen en de roadmap', async (t) => {
  const { base } = await startServer(t, { hibp: fakeHibp() });
  for (const path of ['/', '/bronnen', '/privacy', '/inloggen']) {
    const html = await (await send(base, path)).text();
    assert.match(html, /<a href="\/bronnen">Bronnen en roadmap<\/a>/, path);
  }
});

test('de pagina waar je binnenkomt belooft niet dat we iets van het internet verwijderen', async (t) => {
  const { base } = await startServer(t, { hibp: fakeHibp() });

  const registreren = READABLE(await (await send(base, '/registreren')).text());
  assert.match(registreren, /We zoeken en tonen; we verwijderen niets\./);

  for (const path of ['/', '/registreren', '/inloggen']) {
    const text = READABLE(await (await send(base, path)).text());
    assert.doesNotMatch(text, /verwijderverzoek|laten verwijderen|we verwijderen (je|jouw|alles)|haalt? .{0,40} (weg|offline)/i, path);
  }
});

// --- De startpagina: voordat er iets gedaan is --------------------------------------------

test('de startpagina laat zien wat er te doen is, en noemt nog niets voltooid', async (t) => {
  const { base } = await startServer(t, { hibp: fakeHibp() });
  const html = await (await send(base, '/')).text();
  const text = READABLE(html);

  assert.match(text, /Engine online/);
  assert.match(text, /Wat weet het internet over jou\?/);
  assert.match(text, /Ontdek waar jouw persoonlijke gegevens zijn blootgesteld\./);
  assert.match(html, /placeholder="jouw@email\.nl"/);
  assert.match(html, /<button type="submit" class="button button-action">Start Deep Scan<\/button>/);

  assert.deepEqual(stepsIn(html), [
    ['Datalekdatabases onderzoeken', 'Beschikbaar'],
    ['Databrokers controleren', 'Nog niet gebouwd'],
    ['Openbare internetbronnen onderzoeken', 'Met account'],
    ['Mogelijke blootstelling beoordelen', 'Na stap 1'],
    ['Bewijs controleren', 'Na stap 1'],
  ]);
  assert.doesNotMatch(html, /Voltooid|Testmodus/);
  // De naam van het paneel zegt niet dat er een AI is: die bestaat pas in fase 5.
  assert.match(text, /Research Engine/);
  assert.doesNotMatch(text, /AI Research Engine/);
});

test('zonder eigen sleutel zegt de startpagina dat het testmodus is, bij de chip, de stap en de melding', async (t) => {
  const { base } = await startServer(t, { hibp: fakeHibp({ hasKey: false }) });
  const html = await (await send(base, '/')).text();

  assert.match(html, /<p class="engine-status is-test">/);
  assert.doesNotMatch(READABLE(html), /Engine online/);
  assert.equal(labelsIn(html)[0], 'Testmodus');
  assert.match(READABLE(html), /Testmodus\. Deze site heeft nog geen eigen sleutel van Have I Been Pwned/);
});

// --- De startpagina: na een controle ------------------------------------------------------

const lekken = (...names) => ({ email: () => jsonResponse(200, xonFound(...names)) });

test('na een controle is precies wat gedaan is voltooid: de rest blijft overgeslagen of nog niet gebouwd', async (t) => {
  const { hibp } = freeSite({
    ...lekken('Adobe', 'LinkedIn'),
    list: () => jsonResponse(200, {
      exposedBreaches: [
        xonRaw('Adobe', { exposedData: ['Email addresses', 'Passwords'] }),
        xonRaw('LinkedIn', { referenceURL: '', exposedData: ['Email addresses', 'Phone numbers'] }),
      ],
      status: 'success',
    }),
  });
  const { base } = await startServer(t, { hibp });

  const html = await (await check(base, 'lek@example.com')).text();
  assert.deepEqual(stepsIn(html), [
    ['Datalekdatabases onderzoeken', 'Voltooid'],
    ['Databrokers controleren', 'Nog niet gebouwd'],
    ['Openbare internetbronnen onderzoeken', 'Overgeslagen'],
    ['Mogelijke blootstelling beoordelen', 'Voltooid'],
    ['Bewijs controleren', 'Voltooid'],
  ]);

  const text = READABLE(html);
  assert.match(text, /2 datalekken gevonden bij XposedOrNot\./);
  assert.match(text, /Niet onderzocht: dat kan alleen in je eigen account, op je eigen naam\./);
  assert.match(text, /De lekken bevatten soorten gegevens als: inloggegevens \(in 1 lek\), telefoonnummers \(in 1 lek\)\./);
  assert.match(text, /Of jouw eigen gegevens daarbij zaten, melden de bronnen niet\./);
  // LinkedIn heeft bij XposedOrNot geen link: dat meldt de controle in plaats van het te verzwijgen.
  assert.match(text, /2 bevindingen gecontroleerd op bron, datum en beoordeling\. Let op: 1 zonder directe link\./);
});

test('bij elk lek op de startpagina staat dezelfde bron, datum en zekerheid als in een account', async (t) => {
  const { hibp } = freeSite(lekken('Adobe', 'LinkedIn'));
  const { base } = await startServer(t, { hibp });

  const html = await (await check(base, 'lek@example.com')).text();
  const blocks = html.match(/<dl class="evidence" aria-label="Bewijs bij deze bevinding">[\s\S]*?<\/dl>/g) ?? [];
  assert.equal(blocks.length, 2);
  for (const block of blocks) {
    const text = READABLE(block).trim();
    assert.match(text, /^Bron XposedOrNot Onderzocht op \d+ \w+ \d{4} om \d{2}:\d{2} Zekerheid Hoog · De bron zegt dat dit e-mailadres in dit lek staat/);
    assert.match(block, /<a href="https:\/\/xposedornot\.com"/); // de bron is een link die je kunt nalopen
  }
});

test('geen lek gevonden: goed nieuws, en er valt geen bewijs te controleren', async (t) => {
  const { hibp } = freeSite({ email: () => jsonResponse(404, { Error: 'Not found', email: null }) });
  const { base } = await startServer(t, { hibp });

  const html = await (await check(base, 'schoon@example.com')).text();
  assert.deepEqual(labelsIn(html), ['Voltooid', 'Nog niet gebouwd', 'Overgeslagen', 'Voltooid', 'Overgeslagen']);
  const text = READABLE(html);
  assert.match(text, /Geen datalek gevonden bij XposedOrNot\./);
  assert.match(text, /Er is geen datalek gevonden, dus er is niets om te beoordelen\./);
  assert.match(text, /Er zijn geen bevindingen om te controleren\./);
  assert.match(text, /Goed nieuws: geen datalek gevonden/);
  assert.doesNotMatch(html, /Bewijs bij deze bevinding/);
});

test('lukt de controle niet, dan staat er een foutmelding en blijft elke stap onaangeroerd', async (t) => {
  const hibp = fakeHibp({ error: new ScanError('unavailable') });
  const { base } = await startServer(t, { hibp });

  const response = await check(base, 'iemand@example.com');
  assert.equal(response.status, 502);
  const html = await response.text();
  assert.match(READABLE(html), /Have I Been Pwned is nu niet bereikbaar/);
  assert.deepEqual(labelsIn(html), ['Beschikbaar', 'Nog niet gebouwd', 'Met account', 'Na stap 1', 'Na stap 1']);
  assert.doesNotMatch(html, /Voltooid/); // er is niets onderzocht, dus niets is voltooid
});

test('de controle op de startpagina bewaart niets, ook het bewijs niet', async (t) => {
  const { hibp } = freeSite(lekken('Adobe'));
  const { db, base } = await startServer(t, { hibp });

  const response = await check(base, 'geheim.adres@example.com');
  assert.equal(response.status, 200);
  assert.match(READABLE(await response.text()), /Onderzocht op/);

  for (const table of ['findings', 'scans', 'scan_runs']) {
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0, table);
  }
  assert.doesNotMatch(everythingInDatabase(db), /geheim\.adres|Adobe/);
});
