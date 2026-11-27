// Tests voor het zelf lezen van gevonden pagina's (src/research/page-reader.js) en de stap in de Deep Scan.
// De lezer praat in deze tests alleen met een testserver op deze computer; een nep-adresopzoeker zegt welk
// IP-adres een naam heeft. Zo testen we ook dat interne adressen geweigerd worden, zonder internet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  USER_AGENT, createPageReader, foundText, htmlToText, isPublicAddress, offLimits, parsePageCheck, parseRobots, robotsAllow,
} from '../src/research/page-reader.js';
import {
  ANNA, fakeHibp, fakeSearch, registerConfirmed, send, startServer,
} from './helpers.js';

// --- Adressen ---------------------------------------------------------------------------------------------

test('alleen openbare IP-adressen mogen; intern, lokaal en speciaal nooit', () => {
  for (const address of ['8.8.8.8', '93.184.216.34', '2a00:1450:4001:80b::200e', '2606:4700::6810:84e5']) {
    assert.equal(isPublicAddress(address), true, address);
  }
  for (const address of [
    '127.0.0.1', '127.8.9.10', '10.0.0.1', '172.16.5.4', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1',
    '0.0.0.0', '224.0.0.1', '255.255.255.255', '198.18.0.1', '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1',
    '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:8.8.8.8', '64:ff9b::a00:1', 'ff02::1', 'localhost', '', 'geen ip',
  ]) {
    assert.equal(isPublicAddress(address), false, address);
  }
});

test('databrokers, personenzoeksites en sociale media lezen we bewust niet', () => {
  for (const url of [
    'https://www.detelefoongids.nl/anna/1/', 'https://nl.linkedin.com/in/anna', 'https://www.facebook.com/anna',
    'https://www.intelius.com/x', 'https://m.youtube.com/watch?v=1', 'geen adres',
  ]) {
    assert.equal(offLimits(url), true, url);
  }
  for (const url of ['https://example.org/club/uitslagen', 'https://www.tennisclub-utrecht.nl/leden.html']) {
    assert.equal(offLimits(url), false, url);
  }
});

test('PAGE_CHECK: leeg of on is aan, off is uit, iets anders stopt de server', () => {
  assert.equal(parsePageCheck(undefined), true);
  assert.equal(parsePageCheck(' ON '), true);
  assert.equal(parsePageCheck('off'), false);
  assert.throws(() => parsePageCheck('ja'), /PAGE_CHECK moet "on" of "off" zijn/);
});

// --- robots.txt en html -----------------------------------------------------------------------------------

test('robots.txt: onze eigen groep gaat voor *, de langste regel wint, Allow wint bij gelijke lengte', () => {
  const rules = parseRobots(`
    User-agent: *
    Disallow: /

    User-agent: Googlebot
    Disallow: /prive

    User-agent: PrivacyscanBot
    User-agent: AndereBot
    Disallow: /leden
    Allow: /leden/uitslagen
    Disallow: /*.php$
  `);
  assert.equal(robotsAllow(rules, '/'), true); // onze groep verbiedt / niet
  assert.equal(robotsAllow(rules, '/leden/lijst'), false);
  assert.equal(robotsAllow(rules, '/leden/uitslagen/2025'), true);
  assert.equal(robotsAllow(rules, '/index.php'), false);
  assert.equal(robotsAllow(rules, '/index.php?x=1'), true); // $ = einde van het adres
  const star = parseRobots('User-agent: *\nDisallow: /geheim\nAllow: /geheim\n');
  assert.equal(robotsAllow(star, '/geheim/x'), true); // gelijk: Allow wint
  assert.equal(robotsAllow(parseRobots('User-agent: *\nDisallow: /\n'), '/x'), false);
  assert.equal(robotsAllow(parseRobots(''), '/x'), true);
  assert.equal(robotsAllow(parseRobots('Disallow: /\n'), '/x'), true); // een regel zonder groep telt niet
});

test('van html naar tekst: zonder scripts, stijlen en commentaar, met de titel en leesbare tekens', () => {
  const { title, text } = htmlToText(`<!doctype html><html><head><title>Club &amp; co &#8211; uitslagen</title>
    <style>p { color: red }</style><script>var naam = "Anna de Vries";</script></head>
    <body><!-- Anna de Vries --><h1>Uitslagen</h1><p>Anna de Vries&nbsp;werd 2<sup>e</sup>.</p>
    <p>Caf&eacute; &#x27;t Hoekje</p><noscript>Anna</noscript></body></html>`);
  assert.equal(title, 'Club & co – uitslagen');
  assert.equal(text, 'Uitslagen\nAnna de Vries werd 2 e .\nCafé \'t Hoekje');
  assert.equal(foundText(['naam', 'woonplaats', 'iets']), 'je naam en je woonplaats');
  assert.equal(foundText([]), '');
});

// --- De lezer, tegen een testserver ---------------------------------------------------------------------------

async function testServer(t, routes) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, agent: req.headers['user-agent'] });
    const route = routes[req.url] ?? routes['*'];
    if (!route) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('niet gevonden');
      return;
    }
    route(req, res);
  });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  }));
  return { port: server.address().port, seen };
}

const html = (body, type = 'text/html; charset=utf-8') => (req, res) => {
  res.writeHead(200, { 'content-type': type });
  res.end(body);
};

// "club.test" wijst naar de testserver; "dubbel.test" naar een openbaar én een intern adres.
const resolve = (host, options, callback) => {
  if (host === 'club.test') return callback(null, [{ address: '127.0.0.1', family: 4 }]);
  if (host === 'dubbel.test') return callback(null, [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }]);
  return callback(Object.assign(new Error('onbekend'), { code: 'ENOTFOUND' }));
};
// Voor de test mag de testserver (127.0.0.1) wel; verder alleen openbare adressen.
const testAllow = (address) => address === '127.0.0.1' || isPublicAddress(address);

test('de lezer leest een pagina, met de juiste tekenset, en stelt zich voor als PrivacyscanBot', async (t) => {
  const { port, seen } = await testServer(t, {
    '/uitslagen': html('<title>Uitslagen</title><p>Anna de Vries werd tweede in Utrecht.</p>'),
    '/oud': html(Buffer.from('<p>Café de Vries</p>', 'latin1'), 'text/html; charset=windows-1252'),
    '/tekst': html('Anna de Vries, Utrecht', 'text/plain'),
  });
  const reader = createPageReader({ resolve, allowAddress: testAllow, ports: [port] });
  const page = await reader.read(`http://club.test:${port}/uitslagen`);
  assert.deepEqual(page, {
    status: 'gelezen', url: `http://club.test:${port}/uitslagen`, title: 'Uitslagen', text: 'Anna de Vries werd tweede in Utrecht.',
  });
  assert.equal((await reader.read(`http://club.test:${port}/oud`)).text, 'Café de Vries');
  assert.equal((await reader.read(`http://club.test:${port}/tekst`)).text, 'Anna de Vries, Utrecht');
  assert.ok(seen.every((request) => request.agent === USER_AGENT));
  // robots.txt is één keer opgevraagd voor deze site, daarna onthouden.
  assert.equal(seen.filter((request) => request.url === '/robots.txt').length, 1);
});

test('robots.txt geldt: wat de site afschermt, lezen we niet; bij een storing liever niet', async (t) => {
  const { port, seen } = await testServer(t, {
    '/robots.txt': html('User-agent: *\nDisallow: /leden\n', 'text/plain'),
    '*': html('<p>Anna de Vries</p>'),
  });
  const reader = createPageReader({ resolve, allowAddress: testAllow, ports: [port] });
  assert.equal((await reader.read(`http://club.test:${port}/leden/lijst`)).status, 'robots');
  assert.equal(seen.some((request) => request.url === '/leden/lijst'), false); // de pagina zelf is niet opgevraagd
  assert.equal((await reader.read(`http://club.test:${port}/nieuws`)).status, 'gelezen');

  const broken = await testServer(t, {
    '/robots.txt': (req, res) => { res.writeHead(500); res.end(); },
    '*': html('<p>Anna de Vries</p>'),
  });
  const second = createPageReader({ resolve, allowAddress: testAllow, ports: [broken.port] });
  assert.equal((await second.read(`http://club.test:${broken.port}/x`)).status, 'robots');
});

test('doorverwijzingen worden gevolgd, maar nooit naar een intern adres', async (t) => {
  const { port } = await testServer(t, {
    '/oud-adres': (req, res) => { res.writeHead(301, { location: '/nieuw-adres' }); res.end(); },
    '/nieuw-adres': html('<p>Anna de Vries</p>'),
    '/naar-router': (req, res) => { res.writeHead(302, { location: 'http://192.168.1.1/' }); res.end(); },
    '/naar-metadata': (req, res) => { res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' }); res.end(); },
    '/rondje': (req, res) => { res.writeHead(302, { location: '/rondje' }); res.end(); },
  });
  const reader = createPageReader({ resolve, allowAddress: testAllow, ports: [port] });
  const moved = await reader.read(`http://club.test:${port}/oud-adres`);
  assert.equal(moved.status, 'gelezen');
  assert.equal(moved.url, `http://club.test:${port}/nieuw-adres`);
  assert.equal((await reader.read(`http://club.test:${port}/naar-router`)).status, 'geweigerd');
  assert.equal((await reader.read(`http://club.test:${port}/naar-metadata`)).status, 'geweigerd');
  assert.equal((await reader.read(`http://club.test:${port}/rondje`)).status, 'onbereikbaar');
});

test('de gewone lezer weigert elk intern of vreemd adres, ook na een gelukte verbinding van een andere lezer', async (t) => {
  const { port, seen } = await testServer(t, { '*': html('<p>Anna de Vries</p>') });
  // Eerst een lezer die de testserver wel mag (zodat er een verbinding open had kunnen blijven).
  await createPageReader({ resolve, allowAddress: testAllow, ports: [port] }).read(`http://club.test:${port}/a`);
  const before = seen.length;

  const strict = createPageReader({ resolve, ports: [port] });
  for (const url of [
    `http://club.test:${port}/a`, // de naam wijst naar 127.0.0.1
    `http://127.0.0.1:${port}/a`,
    `http://[::1]:${port}/a`,
    `http://dubbel.test:${port}/a`, // één intern adres tussen de openbare is genoeg
    'http://169.254.169.254/latest/meta-data/',
    'http://10.0.0.1/',
  ]) {
    assert.equal((await strict.read(url)).status, 'geweigerd', url);
  }
  assert.equal(seen.length, before); // de testserver heeft niets meer gezien

  const normal = createPageReader({ resolve });
  for (const url of ['http://example.org:8080/', 'ftp://example.org/', 'http://gebruiker:wachtwoord@example.org/', 'javascript:alert(1)', 'geen adres']) {
    assert.equal((await normal.read(url)).status, 'geweigerd', url);
  }
  assert.equal((await normal.read('https://www.spokeo.com/Anna-de-Vries')).status, 'overgeslagen');
});

test('geen html (een pdf), te groot, een foutcode of te traag: niet gelezen, met de reden', async (t) => {
  const { port } = await testServer(t, {
    '/stuk.pdf': html('%PDF-1.7', 'application/pdf'),
    '/groot': (req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<p>${'x'.repeat(5000)}</p>`);
    },
    '/weg': (req, res) => { res.writeHead(410); res.end(); },
    '/traag': () => {}, // antwoordt nooit
  });
  const reader = createPageReader({
    resolve, allowAddress: testAllow, ports: [port], maxBytes: 1000, timeoutMs: 300,
  });
  assert.equal((await reader.read(`http://club.test:${port}/stuk.pdf`)).status, 'geen-tekst');
  assert.equal((await reader.read(`http://club.test:${port}/groot`)).status, 'te-groot');
  assert.equal((await reader.read(`http://club.test:${port}/weg`)).status, 'onbereikbaar');
  assert.equal((await reader.read(`http://club.test:${port}/traag`)).status, 'onbereikbaar');
  // Een site die niet bestaat: niet bereikbaar (en niet "robots.txt").
  assert.equal((await createPageReader({ resolve }).read('http://onbekend.test/')).status, 'onbereikbaar');
});

// --- De stap in de Deep Scan --------------------------------------------------------------------------------------

const CLUB_PAGE = { title: 'Uitslagen clubkampioenschappen', url: 'https://example.org/club/uitslagen', snippet: 'Uitslagen van 2025.' };
const FORUM = { title: 'Forum', url: 'https://forum.example.net/draad/12', snippet: 'Anna de Vries schreef' };
const OLD = { title: 'Oude pagina', url: 'https://oud.example.com/anna', snippet: 'Anna de Vries uit Utrecht' };
const SOCIAL = { title: 'Anna de Vries | LinkedIn', url: 'https://nl.linkedin.com/in/anna', snippet: 'Anna de Vries' };
const BROKER = { title: 'Anna de Vries', url: 'https://www.telefoonboek.nl/anna', snippet: 'Anna de Vries, Utrecht' };

// Een nep-lezer: wat hij per adres teruggeeft, en welke adressen gevraagd zijn.
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

test('de Deep Scan leest de gevonden gewone pagina\'s zelf en zegt wat erop staat', async (t) => {
  const search = fakeSearch({ results: [CLUB_PAGE, FORUM, OLD, SOCIAL, BROKER] });
  const pageReader = fakeReader({
    [CLUB_PAGE.url]: { status: 'gelezen', title: 'Uitslagen', text: 'Dames enkel: 1. Bep Jansen, 2. Anna de Vries (Utrecht). Mail: anna@example.com' },
    [FORUM.url]: { status: 'robots' },
    [OLD.url]: { status: 'gelezen', title: 'Oude pagina', text: 'Deze pagina bestaat niet meer.' },
  });
  const { db, base, mailer } = await startServer(t, { hibp: fakeHibp(), search, pageReader });
  const cookie = await registerConfirmed(base, mailer, ANNA);
  await send(base, '/scan/deep', { method: 'POST', cookie });

  // Databrokers en sociale media zijn niet geopend.
  assert.deepEqual(pageReader.calls.sort(), [CLUB_PAGE.url, FORUM.url, OLD.url].sort());
  const finding = (url) => {
    const row = db.prepare('SELECT details, confidence, confidence_note FROM findings WHERE url = ?').get(url);
    return { ...row, details: JSON.parse(row.details) };
  };
  const club = finding(CLUB_PAGE.url);
  assert.deepEqual(club.details.page.found, ['naam', 'email']);
  assert.match(club.details.page.excerpt, /2\. Anna de Vries \(Utrecht\)/);
  // Je bevestigde e-mailadres staat op de pagina zelf: een sterke overeenkomst, ook al zei het fragment niets.
  assert.equal(club.confidence, 'hoog');
  assert.match(club.confidence_note, /Je bevestigde e-mailadres staat op de pagina zelf/);
  assert.equal(finding(FORUM.url).details.page.status, 'robots');
  assert.deepEqual(finding(OLD.url).details.page.found, []);
  assert.equal(finding(OLD.url).details.page.excerpt, null);
  assert.equal(finding(SOCIAL.url).details.page, undefined);

  const html = await (await send(base, '/resultaten', cookie ? { cookie } : {})).text();
  assert.match(html, /2 pagina&#39;s zelf gelezen: op 1 daarvan staan je gegevens echt, op 1 niet \(meer\)\. Niet gelezen: 1 robots\.txt van de site vraagt om weg te blijven\. 2 resultaten op een databrokersite of sociale media bewust niet geopend\./);
  assert.match(html, /je naam en je e-mailadres staan erop\./);
  assert.match(html, /<blockquote class="page-excerpt">[^<]*2\. Anna de Vries \(Utrecht\)[^<]*<\/blockquote>/);
  assert.match(html, /je gegevens staan er niet \(meer\) op/);
  assert.match(html, /Pagina zelf niet gelezen: robots\.txt van de site vraagt om weg te blijven\./);
});

test('zonder paginalezer of bij de demo zegt de stap waarom er niets gelezen is', async (t) => {
  const off = await startServer(t, { hibp: fakeHibp(), search: fakeSearch({ results: [CLUB_PAGE] }) });
  const cookie = await registerConfirmed(off.base, off.mailer, ANNA);
  await send(off.base, '/scan/deep', { method: 'POST', cookie });
  const run = JSON.parse(off.db.prepare('SELECT steps FROM scan_runs').get().steps);
  const pages = run.find((step) => step.id === 'paginas');
  assert.equal(pages.status, 'unavailable');
  assert.match(pages.note, /PAGE_CHECK=off/);

  const pageReader = fakeReader({});
  const demo = await startServer(t, { hibp: fakeHibp(), pageReader }); // de demo-zoekdienst
  const second = await registerConfirmed(demo.base, demo.mailer, ANNA);
  await send(demo.base, '/scan/deep', { method: 'POST', cookie: second });
  const demoRun = JSON.parse(demo.db.prepare('SELECT steps FROM scan_runs').get().steps);
  assert.equal(demoRun.find((step) => step.id === 'paginas').status, 'skipped');
  assert.deepEqual(pageReader.calls, []);
});

test('hooguit zes pagina\'s per Deep Scan', async (t) => {
  const results = Array.from({ length: 9 }, (_, i) => ({ title: `Pagina ${i}`, url: `https://site${i}.example.org/`, snippet: 'Anna de Vries' }));
  const pages = Object.fromEntries(results.map((result) => [result.url, { status: 'gelezen', title: '', text: 'Anna de Vries' }]));
  const pageReader = fakeReader(pages);
  const { db, base, mailer } = await startServer(t, { hibp: fakeHibp(), search: fakeSearch({ results }), pageReader });
  const cookie = await registerConfirmed(base, mailer, ANNA);
  await send(base, '/scan/deep', { method: 'POST', cookie });
  assert.equal(pageReader.calls.length, 6);
  const note = JSON.parse(db.prepare('SELECT steps FROM scan_runs').get().steps).find((step) => step.id === 'paginas').note;
  assert.match(note, /Hooguit 6 pagina's per Deep Scan\./);
});
