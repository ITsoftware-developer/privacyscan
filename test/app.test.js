// Tests voor registreren, inloggen, uitloggen en de beveiliging.
// Draaien met: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';

const ANNA = {
  naam: 'Anna de Vries',
  email: 'anna@example.com',
  wachtwoord: 'paars konijn op de fiets',
  wachtwoord2: 'paars konijn op de fiets',
};

// Start de app met een lege database in het geheugen. De wachtwoordcheck
// tegen datalekken staat uit, zodat de tests zonder internet werken.
async function startServer(t, options = {}) {
  const db = openDatabase(':memory:');
  const app = createApp({ db, pwnedCheck: async () => false, ...options });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  return { db, base: `http://127.0.0.1:${server.address().port}` };
}

// Doet een verzoek zoals een browser dat zou doen (inclusief Origin-header bij formulieren).
function send(base, path, { method = 'GET', fields, cookie, origin = base } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (method !== 'GET') {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    if (origin !== undefined) headers.origin = origin;
  }
  return fetch(base + path, {
    method,
    headers,
    body: fields ? new URLSearchParams(fields) : undefined,
    redirect: 'manual',
  });
}

function register(base, fields = ANNA, extra = {}) {
  return send(base, '/registreren', { method: 'POST', fields, ...extra });
}

function login(base, email, wachtwoord) {
  return send(base, '/inloggen', { method: 'POST', fields: { email, wachtwoord } });
}

function sessionCookie(response) {
  const line = response.headers.getSetCookie().find((c) => c.startsWith('sessie='));
  return line?.split(';')[0];
}

function alertText(html) {
  return html.match(/class="alert alert-error"[^>]*>([^<]*)</)?.[1].trim();
}

function countUsers(db) {
  return db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
}

test('registreren maakt een account aan en logt je meteen in', async (t) => {
  const { base } = await startServer(t);

  const response = await register(base);
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), '/dashboard');

  const cookieLine = response.headers.getSetCookie().join('\n');
  assert.match(cookieLine, /HttpOnly/i);
  assert.match(cookieLine, /SameSite=Lax/i);

  const dashboard = await send(base, '/dashboard', { cookie: sessionCookie(response) });
  assert.equal(dashboard.status, 200);
  assert.match(await dashboard.text(), /Hoi Anna de Vries/);
});

test('het wachtwoord staat als argon2id-hash in de database, niet als tekst', async (t) => {
  const { db, base } = await startServer(t);
  await register(base);

  const { password_hash } = db.prepare('SELECT password_hash FROM users').get();
  assert.match(password_hash, /^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
  assert.ok(!password_hash.includes(ANNA.wachtwoord));
});

test('het sessietoken staat alleen als hash in de database', async (t) => {
  const { db, base } = await startServer(t);
  const token = sessionCookie(await register(base)).split('=')[1];

  const { id } = db.prepare('SELECT id FROM sessions').get();
  assert.notEqual(id, token);
  assert.match(id, /^[0-9a-f]{64}$/);
});

test('zonder geldige sessie kom je niet op het dashboard', async (t) => {
  const { base } = await startServer(t);

  const anonymous = await send(base, '/dashboard');
  assert.equal(anonymous.status, 303);
  assert.equal(anonymous.headers.get('location'), '/inloggen');

  const fake = await send(base, '/dashboard', { cookie: 'sessie=verzonnen-token' });
  assert.equal(fake.status, 303);
});

test('inloggen werkt, ook met hoofdletters in het e-mailadres', async (t) => {
  const { base } = await startServer(t);
  await register(base);

  const response = await login(base, 'Anna@Example.COM', ANNA.wachtwoord);
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), '/dashboard');

  const dashboard = await send(base, '/dashboard', { cookie: sessionCookie(response) });
  assert.equal(dashboard.status, 200);
});

test('fout wachtwoord en onbekend e-mailadres geven precies dezelfde melding', async (t) => {
  const { base } = await startServer(t);
  await register(base);

  const wrongPassword = await login(base, ANNA.email, 'dit is niet het wachtwoord');
  const unknownEmail = await login(base, 'bestaat.niet@example.com', ANNA.wachtwoord);

  assert.equal(wrongPassword.status, 401);
  assert.equal(unknownEmail.status, 401);
  assert.equal(sessionCookie(wrongPassword), undefined);

  const message1 = alertText(await wrongPassword.text());
  const message2 = alertText(await unknownEmail.text());
  assert.ok(message1);
  assert.equal(message1, message2);
});

test('uitloggen maakt de sessie ongeldig', async (t) => {
  const { db, base } = await startServer(t);
  const cookie = sessionCookie(await register(base));

  const response = await send(base, '/uitloggen', { method: 'POST', cookie });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), '/inloggen?uitgelogd');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);

  // De oude cookie werkt niet meer, ook niet als iemand hem had bewaard.
  const dashboard = await send(base, '/dashboard', { cookie });
  assert.equal(dashboard.status, 303);
});

test('een formulier vanaf een andere website wordt geweigerd (CSRF)', async (t) => {
  const { db, base } = await startServer(t);

  const otherSite = await register(base, ANNA, { origin: 'https://andere-site.example' });
  assert.equal(otherSite.status, 403);

  const nullOrigin = await register(base, ANNA, { origin: 'null' });
  assert.equal(nullOrigin.status, 403);

  assert.equal(countUsers(db), 0);
});

test('registratie controleert de invoer', async (t) => {
  const { db, base } = await startServer(t);
  const cases = [
    [{ ...ANNA, naam: '' }, /Vul je naam in/],
    [{ ...ANNA, email: 'geen-adres' }, /geldig e-mailadres/],
    [{ ...ANNA, wachtwoord: 'kort', wachtwoord2: 'kort' }, /minimaal 12 tekens/],
    [{ ...ANNA, wachtwoord2: 'iets heel anders dan dat' }, /niet hetzelfde/],
  ];
  for (const [fields, expected] of cases) {
    const response = await register(base, fields);
    assert.equal(response.status, 400);
    assert.match(alertText(await response.text()), expected);
  }
  assert.equal(countUsers(db), 0);

  // Een tweede account met hetzelfde adres (andere hoofdletters) mag niet.
  await register(base);
  const duplicate = await register(base, { ...ANNA, email: 'ANNA@example.com' });
  assert.equal(duplicate.status, 400);
  assert.match(alertText(await duplicate.text()), /bestaat al een account/);
  assert.equal(countUsers(db), 1);
});

test('het wachtwoord komt nooit terug in de pagina na een fout', async (t) => {
  const { base } = await startServer(t);
  const response = await register(base, { ...ANNA, wachtwoord2: 'iets heel anders dan dat' });
  const html = await response.text();
  assert.ok(!html.includes(ANNA.wachtwoord));
  assert.ok(html.includes(ANNA.email)); // het e-mailadres blijft wel ingevuld
});

test('een wachtwoord uit een bekend datalek wordt geweigerd', async (t) => {
  const { db, base } = await startServer(t, { pwnedCheck: async () => true });

  const response = await register(base);
  assert.equal(response.status, 400);
  assert.match(alertText(await response.text()), /bekende datalekken/);
  assert.equal(countUsers(db), 0);
});

test('na te veel mislukte inlogpogingen moet je wachten', async (t) => {
  const { base } = await startServer(t, { loginLimit: 3 });
  await register(base);

  for (let i = 0; i < 3; i++) {
    assert.equal((await login(base, ANNA.email, 'fout fout fout fout')).status, 401);
  }
  // Nu is het even op slot, zelfs met het goede wachtwoord.
  const blocked = await login(base, ANNA.email, ANNA.wachtwoord);
  assert.equal(blocked.status, 429);
  assert.match(alertText(await blocked.text()), /Te veel mislukte pogingen/);
});

test('namen worden veilig getoond, zonder HTML-injectie', async (t) => {
  const { base } = await startServer(t);
  const evilName = '<script>alert(1)</script>';
  const cookie = sessionCookie(await register(base, { ...ANNA, naam: evilName }));

  const html = await (await send(base, '/dashboard', { cookie })).text();
  assert.ok(!html.includes(evilName));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
});

test('beveiligingsheaders staan aan', async (t) => {
  const { base } = await startServer(t);
  const response = await send(base, '/inloggen');

  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-security-policy'), /default-src 'self'/);
  assert.doesNotMatch(response.headers.get('content-security-policy'), /upgrade-insecure-requests/);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('referrer-policy'), 'same-origin');
  assert.equal(response.headers.get('x-powered-by'), null);
});

test('onbekende pagina geeft een nette 404', async (t) => {
  const { base } = await startServer(t);
  const response = await send(base, '/bestaat-niet');
  assert.equal(response.status, 404);
  assert.match(await response.text(), /Pagina niet gevonden/);
});
