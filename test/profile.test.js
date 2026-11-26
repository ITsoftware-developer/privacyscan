// Tests voor de pagina "Zoekgegevens": je telefoonnummer bevestigen met een sms-code, zoeken op je
// e-mailadres aan- of uitzetten, en wat de Deep Scan daarmee doet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Duplex } from 'node:stream';
import { createApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';
import { createSmsSender } from '../src/sms.js';
import {
  ANNA, alertText, fakeHibp, fakeSearch, register, registerConfirmed, send, sessionCookie, startServer,
} from './helpers.js';

const BRAM = {
  naam: 'Bram Jansen', email: 'bram@example.com', wachtwoord: 'groene giraf in de regen', wachtwoord2: 'groene giraf in de regen',
};

async function setup(t, options = {}) {
  const sms = options.sms ?? createSmsSender({ production: options.production });
  const server = await startServer(t, { hibp: fakeHibp(), ...options, sms });
  const cookie = await registerConfirmed(server.base, server.mailer);
  return { ...server, sms, cookie };
}

const page = async (base, cookie, path) => (await send(base, path, { cookie })).text();
const sendCode = (base, cookie, telefoon) => send(base, '/profiel/telefoon', { method: 'POST', cookie, fields: { telefoon } });
const confirm = (base, cookie, code) => send(base, '/profiel/telefoon/bevestigen', { method: 'POST', cookie, fields: { code } });
const codeIn = (message) => message.text.match(/\b(\d{6})\b/)[1];
const phoneOf = (db, email = ANNA.email) => ({ ...db.prepare('SELECT phone, phone_verified_at FROM users WHERE email = ?').get(email) });

test('je telefoonnummer bevestigen: eerst een code per sms, pas daarna staat het nummer op je account', async (t) => {
  const { db, base, sms, cookie } = await setup(t);

  const empty = await page(base, cookie, '/profiel');
  assert.match(empty, /name="telefoon"/);
  assert.match(empty, /een bevestigd e-mailadres bewijst niet dat een telefoonnummer van jou is/i);

  const sent = await sendCode(base, cookie, '06 12345678');
  assert.equal(sent.status, 303);
  assert.equal(sent.headers.get('location'), '/profiel?code-verstuurd#telefoon');
  assert.equal(sms.outbox.length, 1);
  assert.equal(sms.outbox[0].to, '+31612345678');
  assert.match(sms.outbox[0].text, /^Je code voor Privacyscan: \d{6}\. Hij is 10 minuten geldig\./);
  const code = codeIn(sms.outbox[0]);

  // Nog niet bevestigd: het nummer staat nog niet op het account, en de code zelf staat nergens.
  assert.deepEqual(phoneOf(db), { phone: null, phone_verified_at: null });
  const stored = { ...db.prepare('SELECT * FROM phone_codes').get() };
  assert.doesNotMatch(JSON.stringify(stored), new RegExp(code));

  const waiting = await page(base, cookie, '/profiel?code-verstuurd');
  assert.match(waiting, /We hebben een sms met een code gestuurd/);
  assert.match(waiting, /We hebben een code gestuurd naar <strong>06 12345678<\/strong>/);
  assert.match(waiting, /href="\/dev\/sms"/);
  assert.match(waiting, /name="code"/);

  const wrong = await confirm(base, cookie, code === '000000' ? '111111' : '000000');
  assert.equal(wrong.status, 400);
  assert.equal(alertText(await wrong.text()), 'Deze code klopt niet. Je kunt het nog 4 keer proberen.');
  assert.deepEqual(phoneOf(db), { phone: null, phone_verified_at: null });

  const ok = await confirm(base, cookie, ` ${code.slice(0, 3)} ${code.slice(3)} `); // spaties maken niet uit
  assert.equal(ok.status, 303);
  assert.equal(ok.headers.get('location'), '/profiel?bevestigd#telefoon');
  const saved = phoneOf(db);
  assert.equal(saved.phone, '+31612345678');
  assert.ok(saved.phone_verified_at > 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM phone_codes').get().n, 0);

  const done = await page(base, cookie, '/profiel?bevestigd');
  assert.match(done, /Je telefoonnummer is bevestigd/);
  assert.match(done, /06 12345678 <span class="badge badge-ok">Bevestigd<\/span>/);
  assert.match(await page(base, cookie, '/dashboard'), /06 12345678 <span class="badge badge-ok">Bevestigd<\/span>/);

  // Dezelfde code werkt geen tweede keer.
  const again = await confirm(base, cookie, code);
  assert.equal(again.status, 400);
  assert.match(alertText(await again.text()), /Er staat geen geldige code open/);
});

test('vijf keer een verkeerde code: de code werkt niet meer, ook de goede niet', async (t) => {
  const { db, base, sms, cookie } = await setup(t);
  await sendCode(base, cookie, '0612345678');
  const code = codeIn(sms.outbox[0]);
  const bad = code === '999999' ? '888888' : '999999';

  for (const left of [4, 3, 2, 1]) {
    assert.match(alertText(await (await confirm(base, cookie, bad)).text()), new RegExp(`nog ${left} keer`));
  }
  assert.match(alertText(await (await confirm(base, cookie, bad)).text()), /5 keer een verkeerde code ingevuld/);
  assert.match(alertText(await (await confirm(base, cookie, code)).text()), /Er staat geen geldige code open/);
  assert.equal(phoneOf(db).phone, null);
});

test('een verlopen code werkt niet', async (t) => {
  const { db, base, sms, cookie } = await setup(t);
  await sendCode(base, cookie, '0612345678');
  db.prepare('UPDATE phone_codes SET expires_at = 1').run();
  const response = await confirm(base, cookie, codeIn(sms.outbox[0]));
  assert.equal(response.status, 400);
  assert.match(alertText(await response.text()), /Er staat geen geldige code open: hij is verlopen of al gebruikt/);
  assert.equal(phoneOf(db).phone, null);
  // Op de pagina staat dan weer het formulier voor een nummer, niet dat voor de code.
  const html = await page(base, cookie, '/profiel');
  assert.match(html, /name="telefoon"/);
  assert.doesNotMatch(html, /name="code"/);
});

test('alleen zes cijfers zijn een code; iets anders telt niet als poging', async (t) => {
  const { base, sms, cookie } = await setup(t);
  await sendCode(base, cookie, '0612345678');
  for (const code of ['', '12345', '1234567', 'abcdef', '12 34 5']) {
    const response = await confirm(base, cookie, code);
    assert.equal(response.status, 400, code);
    assert.equal(alertText(await response.text()), 'Vul de 6 cijfers van de code in.');
  }
  assert.equal((await confirm(base, cookie, codeIn(sms.outbox[0]))).status, 303);
});

test('een ongeldig nummer: een foutmelding, geen sms, en het telt niet mee voor de limiet', async (t) => {
  const { db, base, sms, cookie } = await setup(t);
  for (const telefoon of ['bel me', '06 1234', '7700 900123', '']) {
    const response = await sendCode(base, cookie, telefoon);
    assert.equal(response.status, 400, telefoon);
    assert.ok(alertText(await response.text()), telefoon);
  }
  assert.equal(sms.outbox.length, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM phone_codes').get().n, 0);
  // Wat je typte, blijft staan (veilig in de pagina gezet).
  assert.match(await (await sendCode(base, cookie, '<b>06</b>')).text(), /value="&lt;b&gt;06&lt;\/b&gt;"/);

  for (let i = 0; i < 3; i += 1) assert.equal((await sendCode(base, cookie, '0612345678')).status, 303);
});

test('hooguit drie codes per uur per account', async (t) => {
  const { base, sms, cookie } = await setup(t);
  for (let i = 0; i < 3; i += 1) assert.equal((await sendCode(base, cookie, '0612345678')).status, 303);
  const blocked = await sendCode(base, cookie, '0687654321');
  assert.equal(blocked.status, 429);
  assert.match(alertText(await blocked.text()), /Je hebt al een paar codes laten sturen/);
  assert.equal(sms.outbox.length, 3);
});

test('hooguit drie codes per uur naar hetzelfde nummer, ook vanaf verschillende accounts', async (t) => {
  const { base, mailer, sms, cookie } = await setup(t);
  const bram = await registerConfirmed(base, mailer, BRAM);
  assert.equal((await sendCode(base, cookie, '06 12345678')).status, 303);
  assert.equal((await sendCode(base, cookie, '+31612345678')).status, 303);
  assert.equal((await sendCode(base, bram, '0612345678')).status, 303);
  assert.equal((await sendCode(base, bram, '06-12345678')).status, 429);
  // Een ander nummer kan Bram nog wel bevestigen.
  assert.equal((await sendCode(base, bram, '0687654321')).status, 303);
  assert.equal(sms.outbox.length, 4);
});

test('een code van iemand anders werkt niet voor jouw account', async (t) => {
  const { db, base, mailer, sms, cookie } = await setup(t);
  const bram = await registerConfirmed(base, mailer, BRAM);
  await sendCode(base, cookie, '0612345678');
  const response = await confirm(base, bram, codeIn(sms.outbox[0]));
  assert.equal(response.status, 400);
  assert.match(alertText(await response.text()), /Er staat geen geldige code open/);
  assert.equal(phoneOf(db, BRAM.email).phone, null);
});

test('een typfout in het nummer: de code annuleren', async (t) => {
  const { db, base, cookie } = await setup(t);
  await sendCode(base, cookie, '0612345678');
  const response = await send(base, '/profiel/telefoon/annuleren', { method: 'POST', cookie });
  assert.equal(response.headers.get('location'), '/profiel?geannuleerd#telefoon');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM phone_codes').get().n, 0);
  assert.match(await page(base, cookie, '/profiel?geannuleerd'), /Er is geen nummer toegevoegd/);
});

test('je nummer verwijderen: dan onderzoeken we het niet meer', async (t) => {
  const { db, base, sms, cookie } = await setup(t);
  await sendCode(base, cookie, '0612345678');
  await confirm(base, cookie, codeIn(sms.outbox[0]));
  assert.equal(phoneOf(db).phone, '+31612345678');

  const response = await send(base, '/profiel/telefoon/verwijderen', { method: 'POST', cookie });
  assert.equal(response.headers.get('location'), '/profiel?verwijderd#telefoon');
  assert.deepEqual(phoneOf(db), { phone: null, phone_verified_at: null });
  const html = await page(base, cookie, '/profiel?verwijderd');
  assert.match(html, /Je telefoonnummer is verwijderd/);
  assert.match(html, /name="telefoon"/);
});

test('een nieuw nummer bevestigen vervangt het oude pas als de nieuwe code klopt', async (t) => {
  const { db, base, sms, cookie } = await setup(t);
  await sendCode(base, cookie, '0612345678');
  await confirm(base, cookie, codeIn(sms.outbox[0]));
  await sendCode(base, cookie, '0687654321');
  assert.equal(phoneOf(db).phone, '+31612345678'); // het oude nummer blijft tot je het nieuwe bevestigt
  await confirm(base, cookie, codeIn(sms.outbox[0]));
  assert.equal(phoneOf(db).phone, '+31687654321');
});

test('zonder bevestigd e-mailadres sturen we geen code', async (t) => {
  const sms = createSmsSender();
  const { db, base } = await startServer(t, { hibp: fakeHibp(), sms });
  const cookie = sessionCookie(await register(base));
  assert.match(await page(base, cookie, '/profiel'), /Bevestig eerst je e-mailadres\. Daarna kun je hier een nummer toevoegen/);
  const response = await sendCode(base, cookie, '0612345678');
  assert.equal(response.status, 403);
  assert.equal(sms.outbox.length, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM phone_codes').get().n, 0);
});

test('op een openbare site kan bevestigen per sms nog niet, en de pagina zegt dat eerlijk', async (t) => {
  const { db, base, cookie } = await setup(t, { production: true });
  const html = await page(base, cookie, '/profiel');
  assert.match(html, /Bevestigen per sms kan op deze site nog niet: er is nog geen sms-dienst gekoppeld/);
  assert.doesNotMatch(html, /name="telefoon"/);

  const response = await sendCode(base, cookie, '0612345678');
  assert.equal(response.status, 503);
  assert.match(alertText(await response.text()), /nog geen sms-dienst gekoppeld/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM phone_codes').get().n, 0);
});

test('lukt de sms niet, dan blijft er geen code openstaan', async (t) => {
  const sms = {
    available: true, outbox: [], async send() { throw new Error('geen bereik'); },
  };
  const { db, base, cookie } = await setup(t, { sms });
  const response = await sendCode(base, cookie, '0612345678');
  assert.equal(response.status, 502);
  assert.match(alertText(await response.text()), /De sms kon niet worden verstuurd/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM phone_codes').get().n, 0);
});

test('het testpostvak voor sms bestaat alleen op je eigen computer', async (t) => {
  const { base, sms, cookie } = await setup(t);
  await sendCode(base, cookie, '0612345678');
  const inbox = await send(base, '/dev/sms');
  assert.equal(inbox.status, 200);
  assert.equal(inbox.headers.get('cache-control'), 'no-store');
  const html = await inbox.text();
  assert.match(html, /06 12345678/);
  assert.match(html, new RegExp(`Je code voor Privacyscan: ${codeIn(sms.outbox[0])}`));

  const online = await setup(t, { production: true });
  assert.equal((await send(online.base, '/dev/sms')).status, 404);
});

// Een verzoek dat van een ander apparaat lijkt te komen, zonder echt een netwerkpoort open te zetten (op
// Windows zou dat een melding van de firewall geven). Geeft de HTTP-status.
function requestFrom(app, path, remoteAddress) {
  return new Promise((resolve) => {
    const socket = new Duplex({ read() {}, write(chunk, encoding, done) { done(); } });
    Object.defineProperty(socket, 'remoteAddress', { value: remoteAddress });
    const req = new IncomingMessage(socket);
    Object.assign(req, { method: 'GET', url: path, headers: { host: 'localhost:3000' } });
    req.push(null);
    const res = new ServerResponse(req);
    res.assignSocket(socket);
    res.on('finish', () => resolve(res.statusCode));
    app(req, res);
  });
}

test('de testpostvakken zijn er alleen voor deze computer zelf, niet voor iemand op je netwerk', async () => {
  const app = createApp({ db: openDatabase(':memory:'), pwnedCheck: async () => false, sms: createSmsSender() });
  for (const path of ['/dev/sms', '/dev/mails']) {
    assert.equal(await requestFrom(app, path, '127.0.0.1'), 200, path);
    assert.equal(await requestFrom(app, path, '::ffff:127.0.0.1'), 200, path);
    assert.equal(await requestFrom(app, path, '192.168.1.20'), 404, path);
    assert.equal(await requestFrom(app, path, '203.0.113.7'), 404, path);
  }
});

// --- Zoeken op je e-mailadres ----------------------------------------------------------------------

test('zoeken op je e-mailadres zet je zelf aan en uit', async (t) => {
  const { db, base, cookie } = await setup(t);
  const choice = (keuze) => send(base, '/profiel/e-mail-zoeken', { method: 'POST', cookie, fields: { keuze } });
  const consent = () => db.prepare('SELECT email_web_at FROM users').get().email_web_at;

  assert.equal(consent(), null);
  assert.match(await page(base, cookie, '/profiel'), /<span class="badge">Uit<\/span>/);

  const on = await choice('aan');
  assert.equal(on.headers.get('location'), '/profiel?e-mail-aan#e-mail');
  assert.ok(consent() > 0);
  const html = await page(base, cookie, '/profiel?e-mail-aan');
  assert.match(html, /Bij je volgende Deep Scan zoeken we ook op het web naar je e-mailadres/);
  assert.match(html, /<span class="badge badge-ok">Aan<\/span> sinds/);

  assert.equal((await choice('misschien')).status, 400);
  assert.ok(consent() > 0);

  assert.equal((await choice('uit')).headers.get('location'), '/profiel?e-mail-uit#e-mail');
  assert.equal(consent(), null);
});

test('zonder bevestigd e-mailadres kun je zoeken op je e-mailadres niet aanzetten', async (t) => {
  const { db, base } = await startServer(t, { hibp: fakeHibp() });
  const cookie = sessionCookie(await register(base));
  const response = await send(base, '/profiel/e-mail-zoeken', { method: 'POST', cookie, fields: { keuze: 'aan' } });
  assert.equal(response.status, 403);
  assert.equal(db.prepare('SELECT email_web_at FROM users').get().email_web_at, null);
});

test('zonder in te loggen kom je bij geen van deze formulieren', async (t) => {
  const { base } = await startServer(t, { hibp: fakeHibp() });
  for (const path of ['/profiel/telefoon', '/profiel/telefoon/bevestigen', '/profiel/telefoon/annuleren', '/profiel/telefoon/verwijderen', '/profiel/e-mail-zoeken']) {
    const response = await send(base, path, { method: 'POST', fields: { telefoon: '0612345678', code: '123456', keuze: 'aan' } });
    assert.equal(response.status, 303, path);
    assert.equal(response.headers.get('location'), '/inloggen', path);
  }
});

test('een formulier van een andere site wordt geweigerd', async (t) => {
  const { db, base, sms, cookie } = await setup(t);
  const response = await send(base, '/profiel/telefoon', {
    method: 'POST', cookie, fields: { telefoon: '0612345678' }, origin: 'https://kwaadaardig.example', fetchSite: 'cross-site',
  });
  assert.equal(response.status, 403);
  assert.equal(sms.outbox.length, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM phone_codes').get().n, 0);
});

// --- Wat de Deep Scan ermee doet --------------------------------------------------------------------

test('de Deep Scan zoekt alleen op een bevestigd nummer, en een bevestigd nummer in een resultaat is een sterke overeenkomst', async (t) => {
  const listing = {
    title: 'Telefoongids: Anna de Vries',
    url: 'https://www.detelefoongids.nl/anna-de-vries/123/',
    snippet: 'Anna de Vries, bel 06-12345678.',
  };
  const search = fakeSearch({ results: (request) => (request.query.includes('"0612345678"') ? [listing] : []) });
  const { db, base, sms, cookie } = await setup(t, { search });

  // Eerst zonder nummer: geen zoekopdracht met een telefoonnummer, en de stap zegt waarom.
  await sendCode(base, cookie, '0612345678'); // aangevraagd, maar niet bevestigd
  await send(base, '/scan/deep', { method: 'POST', cookie });
  assert.ok(search.calls.every((call) => !call.query.includes('0612345678')));
  const before = await page(base, cookie, '/resultaten');
  assert.match(before, /Je hebt geen bevestigd telefoonnummer/);

  await confirm(base, cookie, codeIn(sms.outbox[0]));
  search.calls.length = 0;
  await send(base, '/scan/deep', { method: 'POST', cookie });
  const phoneCalls = search.calls.filter((call) => call.query.includes('0612345678'));
  assert.equal(phoneCalls.length, 1);
  assert.equal(phoneCalls[0].query, '"0612345678" OR "06-12345678" OR "06 12345678" OR "+31612345678"');

  const row = db.prepare("SELECT confidence, details FROM findings WHERE kind = 'web'").get();
  assert.equal(row.confidence, 'hoog');
  assert.deepEqual(JSON.parse(row.details).via, ['telefoon']);
  const html = await page(base, cookie, '/resultaten');
  assert.match(html, /Sterke overeenkomst/);
  assert.match(html, /Je bevestigde telefoonnummer staat in de titel of het fragment/);
  assert.match(html, /Telefoonnummer \(mobiel\): <strong>\+31 6 •••• 5678<\/strong> · komt overeen met je bevestigde telefoonnummer/);
  assert.match(html, /Gevonden via je telefoonnummer<\/span>/);
  // De databroker staat in het overzicht als gevonden via je telefoonnummer.
  const check = { ...db.prepare("SELECT status, found, via FROM broker_checks WHERE broker_id = 'detelefoongids'").get() };
  assert.deepEqual(check, { status: 'gevonden', found: 1, via: 'telefoon' });
  // Het rapport en de wachtrij bewaren het nummer zelf niet: dat blijft staan, ook als je het nummer verwijdert.
  assert.match(html, /mogelijke vermelding met je bevestigde telefoonnummer/);
  for (const table of ['scan_runs', 'jobs', 'scans']) {
    const stored = JSON.stringify(db.prepare(`SELECT * FROM ${table}`).all());
    assert.doesNotMatch(stored, /12345678/, table);
  }
});

test('met toestemming zoekt de Deep Scan ook op je e-mailadres, zonder niet', async (t) => {
  const search = fakeSearch({ results: [] });
  const { base, cookie } = await setup(t, { search });
  const emailCalls = () => search.calls.filter((call) => call.query.includes(ANNA.email));

  await send(base, '/scan/deep', { method: 'POST', cookie });
  assert.equal(emailCalls().length, 0);
  assert.match(await page(base, cookie, '/resultaten'), /Je hebt niet gekozen om ook op je e-mailadres te zoeken/);

  await send(base, '/profiel/e-mail-zoeken', { method: 'POST', cookie, fields: { keuze: 'aan' } });
  await send(base, '/scan/deep', { method: 'POST', cookie });
  assert.deepEqual(emailCalls().map((call) => call.query), [`"${ANNA.email}"`]);
});

test('je account verwijderen wist ook je nummer, een openstaande code en wat de Data Broker Engine bijhield', async (t) => {
  const search = fakeSearch({ results: [] });
  const { db, base, sms, cookie } = await setup(t, { search });
  await sendCode(base, cookie, '0612345678');
  await confirm(base, cookie, codeIn(sms.outbox[0]));
  await sendCode(base, cookie, '0687654321'); // staat nog open
  await send(base, '/scan/deep', { method: 'POST', cookie });
  assert.ok(db.prepare('SELECT COUNT(*) AS n FROM broker_checks').get().n > 0);

  const response = await send(base, '/account/verwijderen', { method: 'POST', cookie, fields: { wachtwoord: ANNA.wachtwoord } });
  assert.equal(response.status, 303);
  for (const table of ['users', 'phone_codes', 'broker_checks', 'findings', 'scan_runs', 'jobs']) {
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0, table);
  }
});
