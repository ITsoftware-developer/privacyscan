// Tests voor de AI-agent (src/ai/agent.js) en de koppeling met Ollama (src/ai/ollama.js). Er draait in de tests
// geen echt model: een nep-model geeft vaste antwoorden, zodat we precies kunnen nagaan wat de site met een
// antwoord doet. Vooral: dat niets wat niet letterlijk in de tekst staat, als gevonden gegeven op de pagina komt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AI_PAGES, ANALYSIS_SCHEMA, createAiAgent, normalizeQuote, quoteIn, sourceText, validateAnalysis, validateChoice, windowAround,
} from '../src/ai/agent.js';
import {
  AiError, DEFAULT_OLLAMA_URL, createOllama, isLocalUrl, parseAiProvider, parseOllamaUrl,
} from '../src/ai/ollama.js';
import { setPaused } from '../src/controls.js';
import { probeOllama } from '../src/probes.js';
import {
  ANNA, fakeHibp, fakeSearch, registerConfirmed, send, startServer,
} from './helpers.js';

const IDENTITY = {
  name: 'Anna de Vries', city: 'Utrecht', email: 'anna@example.com', phone: null,
};

// --- Instellingen ------------------------------------------------------------------------------------------

test('AI_PROVIDER: leeg of none is geen AI, ollama is Ollama, iets anders stopt de server', () => {
  assert.equal(parseAiProvider(undefined), null);
  assert.equal(parseAiProvider(' none '), null);
  assert.equal(parseAiProvider('Ollama'), 'ollama');
  assert.throws(() => parseAiProvider('chatgpt'), /AI_PROVIDER moet "ollama" zijn/);
});

test('OLLAMA_URL: leeg is deze computer; alleen http(s) zonder wachtwoord', () => {
  assert.equal(parseOllamaUrl(''), DEFAULT_OLLAMA_URL);
  assert.equal(parseOllamaUrl(' http://192.168.1.20:11434/ '), 'http://192.168.1.20:11434');
  for (const fout of ['geen adres', 'ftp://host', 'http://gebruiker:geheim@host:11434']) {
    assert.throws(() => parseOllamaUrl(fout), /OLLAMA_URL/, fout);
  }
  assert.equal(isLocalUrl('http://127.0.0.1:11434'), true);
  assert.equal(isLocalUrl('http://localhost:11434'), true);
  assert.equal(isLocalUrl('http://[::1]:11434'), true);
  assert.equal(isLocalUrl('http://192.168.1.20:11434'), false);
  assert.equal(isLocalUrl('https://ollama.example.com'), false);
});

// --- De koppeling met Ollama ---------------------------------------------------------------------------------

function fakeOllamaFetch(answer) {
  const fake = {
    calls: [],
    async impl(url, init) {
      const body = init.body ? JSON.parse(init.body) : null;
      fake.calls.push({ url: String(url), method: init.method, body });
      return answer(String(url), body, init);
    },
  };
  return fake;
}
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('een vraag aan Ollama: vast formaat, temperatuur 0, niet nadenken, en het antwoord als JSON', async () => {
  const fetch = fakeOllamaFetch(() => json(200, {
    message: { role: 'assistant', content: '{"over_jou":"nee","gegevens":[]}' }, prompt_eval_count: 120, eval_count: 9, done: true,
  }));
  const ollama = createOllama({ model: 'qwen3:8b', fetchImpl: fetch.impl });
  const answer = await ollama.chat({ system: 'S', prompt: 'P', schema: ANALYSIS_SCHEMA });
  assert.deepEqual(answer, { content: { over_jou: 'nee', gegevens: [] }, tokens: { prompt: 120, output: 9 } });
  const { url, method, body } = fetch.calls[0];
  assert.equal(url, 'http://127.0.0.1:11434/api/chat');
  assert.equal(method, 'POST');
  assert.equal(body.model, 'qwen3:8b');
  assert.equal(body.stream, false);
  assert.equal(body.think, false);
  assert.deepEqual(body.format, ANALYSIS_SCHEMA);
  assert.equal(body.options.temperature, 0);
  assert.deepEqual(body.messages, [{ role: 'system', content: 'S' }, { role: 'user', content: 'P' }]);
});

test('een model dat niet kan nadenken: nog een keer zonder "think"', async () => {
  const fetch = fakeOllamaFetch((url, body) => (Object.hasOwn(body, 'think')
    ? json(400, { error: '"llama3.1" does not support thinking' })
    : json(200, { message: { content: '{"lezen":[]}' } })));
  const ollama = createOllama({ model: 'llama3.1', fetchImpl: fetch.impl });
  assert.deepEqual((await ollama.chat({ system: '', prompt: '', schema: {} })).content, { lezen: [] });
  assert.equal(fetch.calls.length, 2);
});

test('fouten van Ollama worden een AiError met een code, zonder details', async () => {
  const cases = [
    [() => json(404, { error: "model 'x' not found" }), 'model_missing'],
    [() => json(500, { error: 'out of memory' }), 'failed'],
    [() => json(200, { message: { content: 'dit is geen json' } }), 'bad_output'],
    [() => { throw new TypeError('fetch failed'); }, 'unavailable'],
  ];
  for (const [answer, code] of cases) {
    const ollama = createOllama({ fetchImpl: fakeOllamaFetch(answer).impl });
    await assert.rejects(ollama.chat({ system: '', prompt: '', schema: {} }), (error) => error instanceof AiError && error.code === code, code);
  }
  // Te traag: de vraag wordt afgebroken.
  const slow = createOllama({
    timeoutMs: 50,
    fetchImpl: (url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('afgebroken'), { name: 'AbortError' })));
    }),
  });
  await assert.rejects(slow.chat({ system: '', prompt: '', schema: {} }), (error) => error.code === 'timeout');
});

test('de testknop vraagt alleen welke modellen er zijn, en zegt of het ingestelde model erbij zit', async () => {
  const tags = (names) => fakeOllamaFetch(() => json(200, { models: names.map((name) => ({ name })) })).impl;
  const ok = await probeOllama(createOllama({ model: 'qwen3:8b', fetchImpl: tags(['qwen3:8b', 'llama3.1:8b']) }));
  assert.deepEqual(ok, { ok: true, text: 'Ollama antwoordt en het model qwen3:8b is geïnstalleerd (2 modellen in totaal).' });
  const latest = await probeOllama(createOllama({ model: 'mistral', fetchImpl: tags(['mistral:latest']) }));
  assert.equal(latest.ok, true);
  const missing = await probeOllama(createOllama({ model: 'qwen3:8b', fetchImpl: tags(['llama3.1:8b']) }));
  assert.deepEqual(missing, { ok: false, text: 'Ollama antwoordt, maar het model qwen3:8b is niet geïnstalleerd. Installeer het met: ollama pull qwen3:8b' });
  const off = await probeOllama(createOllama({ fetchImpl: () => { throw new TypeError('fetch failed'); } }));
  assert.match(off.text, /Ollama is niet bereikbaar op http:\/\/127\.0\.0\.1:11434\. Staat Ollama aan\?/);
});

// --- Niets verzinnen: de controle van een antwoord -------------------------------------------------------------

const SOURCE = sourceText(
  { title: 'Uitslagen clubkampioenschappen', url: 'https://example.org/club', details: { snippet: 'Anna de Vries werd tweede.' } },
  { title: '', text: 'Dames enkel: 1. Bep Jansen, 2. Anna de Vries (Utrecht), geboren 12-03-1990, Kerkstraat 5. Mail: anna@example.com' },
  IDENTITY,
);

test('alleen wat letterlijk in de tekst staat, blijft over; de rest wordt weggegooid en geteld', () => {
  const checked = validateAnalysis({
    over_jou: 'ja',
    gegevens: [
      { soort: 'adres', citaat: 'Kerkstraat 5' },
      { soort: 'geboortedatum', citaat: '“12-03-1990”' },            // aanhalingstekens eromheen maken niet uit
      { soort: 'e-mail', citaat: 'ANNA@example.com' },              // hoofdletters ook niet
      { soort: 'werk', citaat: 'directeur bij Philips' },           // staat er niet: verzonnen
      { soort: 'telefoon', citaat: '06-12345678' },                 // staat er niet
      { soort: 'telefoon', citaat: 'Kerkstraat 5' },                // geen telefoonnummer
      { soort: 'wachtwoord', citaat: 'Kerkstraat 5' },              // geen toegestane soort
      { soort: 'adres', citaat: 'Kerkstraat  5' },                  // dubbel (alleen witruimte anders)
      { soort: 'naam', citaat: '' },
      'onzin',
    ],
  }, SOURCE, IDENTITY);
  assert.equal(checked.verdict, 'ja');
  assert.deepEqual(checked.data, [
    { type: 'adres', quote: 'Kerkstraat 5' },
    { type: 'geboortedatum', quote: '12-03-1990' },
    { type: 'e-mail', quote: 'ANNA@example.com' },
  ]);
  assert.equal(checked.rejected, 6);
});

test('"over jou" kan niet als je naam, e-mailadres en nummer niet in de tekst staan', () => {
  const other = sourceText({ title: 'Fotograaf in Groningen', url: 'https://example.net', details: { snippet: 'Portretten en bruiloften.' } }, null, IDENTITY);
  assert.equal(validateAnalysis({ over_jou: 'ja', gegevens: [] }, other, IDENTITY).verdict, 'onbekend');
  assert.equal(validateAnalysis({ over_jou: 'mogelijk', gegevens: [] }, other, IDENTITY).verdict, 'onbekend');
  assert.equal(validateAnalysis({ over_jou: 'nee', gegevens: [] }, other, IDENTITY).verdict, 'nee');
  assert.equal(validateAnalysis({ over_jou: 'zeker weten', gegevens: [] }, SOURCE, IDENTITY).verdict, 'onbekend');
  assert.deepEqual(validateAnalysis(null, SOURCE, IDENTITY), { verdict: 'onbekend', data: [], rejected: 0 });
});

test('een citaat wordt vergeleken zonder op hoofdletters, rare tekens of witruimte te letten', () => {
  assert.equal(normalizeQuote('  Café   “de Vries” – Utrecht '), 'café "de vries" - utrecht');
  assert.equal(quoteIn('anna DE vries', 'Hallo Anna de  Vries!'), true);
  assert.equal(quoteIn('Anna de Vries uit Rotterdam', 'Hallo Anna de Vries!'), false);
  assert.equal(quoteIn('a', 'a'), false);       // te kort
  assert.equal(quoteIn('...', '...'), false);   // geen letters of cijfers
  assert.equal(quoteIn('x'.repeat(200), 'x'.repeat(300)), false); // te lang
});

test('het model krijgt een stuk van de pagina rond je naam, en nooit de hele pagina', () => {
  const long = `${'Begin van de pagina. '.repeat(300)}Hier staat Anna de Vries uit Utrecht. ${'Einde. '.repeat(300)}`;
  const window = windowAround(long, IDENTITY, 500);
  assert.ok(window.length <= 502);
  assert.match(window, /Anna de Vries uit Utrecht/);
  assert.match(windowAround('kort', IDENTITY), /^kort$/);
});

test('bij het kiezen van pagina\'s gelden alleen ids uit de lijst, elk één keer, en hooguit het maximum', () => {
  const list = [{ id: 4 }, { id: 7 }, { id: 9 }];
  assert.deepEqual(validateChoice({ lezen: ['7', '7', '123', 'x', '4', '9'] }, list, 2).map((item) => item.id), [7, 4]);
  assert.deepEqual(validateChoice({ lezen: 'alles' }, list, 3), []);
  assert.deepEqual(validateChoice(null, list, 3), []);
});

// --- De AI in de Deep Scan ----------------------------------------------------------------------------------------

const CLUB = { title: 'Uitslagen clubkampioenschappen', url: 'https://example.org/club/uitslagen', snippet: 'Anna de Vries werd tweede.' };
const NAMESAKE = { title: 'Fotograaf Anna de Vries', url: 'https://fotograaf.example.net/', snippet: 'Anna de Vries, fotograaf in Groningen.' };

function fakeReader(pages) {
  const reader = {
    calls: [],
    async read(url) {
      reader.calls.push(url);
      return pages[url] ?? { status: 'onbereikbaar' };
    },
  };
  return reader;
}

// Een nep-model. `analyze(prompt)` geeft het antwoord bij het beoordelen van een resultaat, `choose(prompt)` bij het
// kiezen van pagina's. Elke vraag komt in `calls`.
function fakeModel({ analyze = () => ({ over_jou: 'onbekend', gegevens: [] }), choose = () => ({ lezen: [] }), error = null } = {}) {
  const model = {
    id: 'ollama', name: 'Ollama', url: DEFAULT_OLLAMA_URL, model: 'test-model', local: true, calls: [],
    async chat(request) {
      model.calls.push(request);
      const failure = typeof error === 'function' ? error(request) : error;
      if (failure) throw failure;
      const content = request.schema?.properties?.lezen ? choose(request) : analyze(request);
      return { content, tokens: { prompt: 10, output: 5 } };
    },
    async models() { return ['test-model']; },
  };
  return model;
}

async function deepScan(t, { results, pages = {}, model, ...options }) {
  const search = fakeSearch({ results });
  const pageReader = fakeReader(pages);
  const server = await startServer(t, {
    hibp: fakeHibp(), search, pageReader, ai: createAiAgent({ provider: model }), ...options,
  });
  const cookie = await registerConfirmed(server.base, server.mailer, ANNA);
  await send(server.base, '/scan/deep', { method: 'POST', cookie });
  const row = server.db.prepare('SELECT steps FROM scan_runs').get();
  const steps = row ? JSON.parse(row.steps) : [];
  const finding = (url) => {
    const found = server.db.prepare('SELECT details, confidence FROM findings WHERE url = ?').get(url);
    return found ? { ...found, details: JSON.parse(found.details) } : null;
  };
  return {
    ...server, cookie, steps, step: (id) => steps.find((item) => item.id === id), finding, pageReader, search,
  };
}

test('de AI beoordeelt de resultaten; alleen letterlijke citaten komen op de pagina, en de zekerheid blijft van de regels', async (t) => {
  const model = fakeModel({
    analyze: (request) => (request.prompt.includes('Kerkstraat')
      ? {
        over_jou: 'ja',
        gegevens: [
          { soort: 'adres', citaat: 'Kerkstraat 5, Utrecht' },
          { soort: 'werk', citaat: 'directeur bij Philips' }, // verzonnen
        ],
      }
      : { over_jou: 'nee', gegevens: [{ soort: 'werk', citaat: 'fotograaf in Groningen' }] }),
  });
  const scan = await deepScan(t, {
    results: [CLUB, NAMESAKE],
    pages: { [CLUB.url]: { status: 'gelezen', title: 'Uitslagen', text: 'Dames enkel: 2. Anna de Vries, Kerkstraat 5, Utrecht.' } },
    model,
  });

  const club = scan.finding(CLUB.url);
  assert.deepEqual(club.details.ai, {
    verdict: 'ja', data: [{ type: 'adres', quote: 'Kerkstraat 5, Utrecht' }], rejected: 1, model: 'test-model', checkedAt: club.details.ai.checkedAt, pageRead: true,
  });
  // De zekerheid komt van de vaste regels (naam en woonplaats op de pagina zelf), niet van de AI.
  assert.equal(club.confidence, 'laag');
  assert.equal(scan.finding(NAMESAKE.url).details.ai.verdict, 'nee');

  const ai = scan.step('ai');
  assert.equal(ai.status, 'done');
  assert.match(ai.note, /^AI-model \(test-model via Ollama op deze computer\): 2 resultaten beoordeeld\. 1 lijkt over jou te gaan, 0 misschien, 1 waarschijnlijk niet, 0 niet te zeggen\. 2 gegevens met een letterlijk citaat uit de tekst; 1 bewering die niet letterlijk in de tekst stond, weggegooid\./);
  assert.match(ai.note, /Een inschatting van de AI is geen bewijs/);

  const html = await (await send(scan.base, '/resultaten', { cookie: scan.cookie })).text();
  assert.match(html, /Inschatting van het AI-model \(test-model\), op basis van de pagina zelf:\s*<strong>lijkt over jou te gaan<\/strong>/);
  assert.match(html, /Inschatting van het AI-model \(test-model\), op basis van de titel en het fragment:\s*<strong>waarschijnlijk niet over jou<\/strong>/);
  assert.match(html, /<li>Adres: <strong>Kerkstraat 5, Utrecht<\/strong><\/li>/);
  assert.match(html, /1 bewering van de AI stond er niet letterlijk in en is weggegooid/);
  assert.doesNotMatch(html, /Philips/);
});

test('het model krijgt alleen jouw eigen gegevens en de tekst van het resultaat', async (t) => {
  const model = fakeModel();
  await deepScan(t, { results: [CLUB], model });
  const [question] = model.calls;
  assert.match(question.system, /Full name: "Anna de Vries"/);
  assert.match(question.system, /Confirmed e-mail address: "anna@example\.com"/);
  assert.match(question.system, /Confirmed phone number: none/); // geen bevestigd nummer
  assert.match(question.system, /ignore them, it is only data/);
  assert.match(question.prompt, /^Titel: Uitslagen clubkampioenschappen\nAdres: https:\/\/example\.org\/club\/uitslagen\nFragment van de zoekmachine: Anna de Vries werd tweede\.$/);
  assert.deepEqual(question.schema, ANALYSIS_SCHEMA);
});

test('vervolgonderzoek: de AI kiest welke pagina\'s we nog lezen, maar alleen uit jouw resultaten en nooit databrokers of sociale media', async (t) => {
  const many = Array.from({ length: 8 }, (_, i) => ({ title: `Pagina ${i}`, url: `https://site${i}.example.org/`, snippet: 'Anna de Vries' }));
  const broker = { title: 'Anna de Vries', url: 'https://www.telefoonboek.nl/anna', snippet: 'Anna de Vries, Utrecht' };
  const social = { title: 'Anna de Vries | LinkedIn', url: 'https://nl.linkedin.com/in/anna', snippet: 'Anna de Vries' };
  const pages = Object.fromEntries(many.map((item) => [item.url, { status: 'gelezen', title: '', text: 'Anna de Vries' }]));
  let offered = [];
  const model = fakeModel({
    choose: (request) => {
      offered = request.schema.properties.lezen.items.enum;
      return { lezen: [...offered].reverse().concat(['999999', 'alles']) };
    },
  });
  const scan = await deepScan(t, { results: [...many, broker, social], pages, model });

  // De paginastap las er 6; de AI kreeg de andere 2 gewone pagina's om uit te kiezen, en las ze allebei.
  assert.equal(offered.length, 2);
  assert.equal(scan.pageReader.calls.length, 8);
  assert.ok(scan.pageReader.calls.every((url) => url.includes('.example.org')));
  const choice = model.calls.find((request) => request.schema.properties.lezen);
  assert.doesNotMatch(choice.prompt, /telefoonboek|linkedin/);
  assert.match(scan.step('ai').note, /De AI koos 2 extra pagina's om te lezen \(2 gelezen\)\./);
  assert.equal(scan.finding(many[7].url).details.page.status, 'gelezen');
  assert.ok(AI_PAGES >= 2);
});

test('is Ollama niet bereikbaar, dan zegt de stap dat eerlijk en loopt de rest door', async (t) => {
  const model = fakeModel({ error: new AiError('unavailable') });
  const scan = await deepScan(t, { results: [CLUB, NAMESAKE], model });
  assert.equal(scan.step('ai').status, 'unreachable');
  assert.equal(scan.step('ai').note, 'Het AI-model was niet bereikbaar (Ollama op http://127.0.0.1:11434). Staat Ollama aan? Er is niets beoordeeld.');
  assert.equal(scan.step('verificatie').status, 'done');
  assert.equal(scan.finding(CLUB.url).details.ai, undefined);
  assert.equal(model.calls.length, 1); // na "niet bereikbaar" geen nieuwe pogingen, ook niet voor het tweede resultaat
});

test('ontbreekt het model, dan zegt de stap hoe je het installeert', async (t) => {
  const scan = await deepScan(t, { results: [CLUB], model: fakeModel({ error: new AiError('model_missing') }) });
  assert.match(scan.step('ai').note, /Ollama kent het model test-model niet\. Installeer het met: ollama pull test-model/);
});

test('een antwoord in een verkeerd formaat bij één resultaat: dat resultaat niet, de rest wel', async (t) => {
  const model = fakeModel({ error: (request) => (request.prompt.includes('Fotograaf') ? new AiError('bad_output') : null) });
  const scan = await deepScan(t, { results: [CLUB, NAMESAKE], model });
  assert.equal(scan.step('ai').status, 'done');
  assert.match(scan.step('ai').note, /1 resultaat niet beoordeeld: het ai-model gaf een antwoord in een verkeerd formaat\./);
});

test('zet de beheerder de AI op pauze, dan vraagt de Deep Scan het model niets', async (t) => {
  const model = fakeModel();
  const search = fakeSearch({ results: [CLUB] });
  const server = await startServer(t, {
    hibp: fakeHibp(), search, ai: createAiAgent({ provider: model }),
  });
  setPaused(server.db, 'ollama', true);
  const cookie = await registerConfirmed(server.base, server.mailer, ANNA);
  await send(server.base, '/scan/deep', { method: 'POST', cookie });
  const steps = JSON.parse(server.db.prepare('SELECT steps FROM scan_runs').get().steps);
  assert.deepEqual(steps.find((item) => item.id === 'ai'), {
    id: 'ai', title: 'AI-analyse en vervolgonderzoek', status: 'skipped', sources: [], note: 'De beheerder heeft de AI tijdelijk uitgezet.',
  });
  assert.equal(model.calls.length, 0);
});

test('wordt het account geblokkeerd terwijl de AI bezig is, dan stopt het onderzoek', async (t) => {
  let server;
  const model = fakeModel({
    analyze: () => {
      server.db.prepare('UPDATE users SET blocked_at = 1').run();
      return { over_jou: 'onbekend', gegevens: [] };
    },
  });
  server = await startServer(t, {
    hibp: fakeHibp(), search: fakeSearch({ results: [CLUB, NAMESAKE] }), ai: createAiAgent({ provider: model }),
  });
  const cookie = await registerConfirmed(server.base, server.mailer, ANNA);
  await send(server.base, '/scan/deep', { method: 'POST', cookie });
  assert.equal(model.calls.length, 1); // na de blokkade geen tweede vraag
  assert.deepEqual({ ...server.db.prepare('SELECT status, error FROM jobs').get() }, { status: 'failed', error: 'account_unavailable' });
  assert.equal(server.db.prepare('SELECT COUNT(*) AS n FROM scan_runs').get().n, 0);
});

test('bij de demo-zoekdienst beoordeelt de AI niets: er zijn geen echte resultaten', async (t) => {
  const model = fakeModel();
  const server = await startServer(t, { hibp: fakeHibp(), ai: createAiAgent({ provider: model }) });
  const cookie = await registerConfirmed(server.base, server.mailer, ANNA);
  await send(server.base, '/scan/deep', { method: 'POST', cookie });
  const steps = JSON.parse(server.db.prepare('SELECT steps FROM scan_runs').get().steps);
  assert.equal(steps.find((item) => item.id === 'ai').status, 'skipped');
  assert.equal(model.calls.length, 0);
});

// --- De beheerpagina -----------------------------------------------------------------------------------------------------

test('op de beheerpagina staat het AI-model bij de databronnen, met testknop en pauzeknop', async (t) => {
  const OWNER = {
    naam: 'Eva Eigenaar', email: 'eigenaar@example.com', wachtwoord: 'groene giraf op een step', wachtwoord2: 'groene giraf op een step',
  };
  const model = fakeModel();
  const server = await startServer(t, {
    hibp: fakeHibp(), ownerEmail: OWNER.email, ai: createAiAgent({ provider: model }),
  });
  const owner = await registerConfirmed(server.base, server.mailer, OWNER);
  const html = await (await send(server.base, '/beheerder', { cookie: owner })).text();
  assert.match(html, /Ollama \(AI-model\)/);
  assert.match(html, /Model test-model op http:\/\/127\.0\.0\.1:11434\. Dat is deze computer: er gaat niets naar een externe AI-dienst\./);

  const tested = await send(server.base, '/beheerder/bronnen/ollama/test', { method: 'POST', cookie: owner });
  assert.equal(tested.status, 303);
  assert.match(await (await send(server.base, '/beheerder', { cookie: owner })).text(), /Ollama antwoordt en het model test-model is geïnstalleerd/);

  const paused = await send(server.base, '/beheerder/bronnen/ollama/pauze', { method: 'POST', cookie: owner, fields: { actie: 'pauzeren' } });
  assert.equal(paused.status, 303);
  assert.equal(server.db.prepare("SELECT COUNT(*) AS n FROM settings WHERE key = 'paused:ollama'").get().n, 1);
});
