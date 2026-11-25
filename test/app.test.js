// Tests voor registreren, inloggen, uitloggen en de beveiliging.
// Draaien met: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db.js';
import {
  ANNA, alertText, countUsers, login, register, send, sessionCookie, startServer,
} from './helpers.js';


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
  const attempts = [
    { fetchSite: 'cross-site', origin: 'https://andere-site.example' }, // moderne browser
    { fetchSite: 'same-site', origin: 'https://sub.example.com' },      // ander subdomein
    { fetchSite: 'cross-site', origin: base },                          // Sec-Fetch-Site weegt het zwaarst
    { fetchSite: null, origin: 'https://andere-site.example' },        // via http: alleen Origin
    { fetchSite: null, origin: 'null' },                                // afgeschermde herkomst
    { fetchSite: null, origin: null },                                  // geen van beide: geen browser
  ];
  for (const headers of attempts) {
    const response = await register(base, ANNA, headers);
    assert.equal(response.status, 403, `verwacht 403 bij ${JSON.stringify(headers)}`);
  }
  assert.equal(countUsers(db), 0);
});

test('formulieren van de eigen site komen door, ook als één van de headers ontbreekt', async (t) => {
  const { db, base } = await startServer(t);

  // Via https of localhost sturen browsers Sec-Fetch-Site mee; dat is genoeg.
  const onlyFetchSite = await register(base, ANNA, { origin: null });
  assert.equal(onlyFetchSite.status, 303);

  // Via gewone http naar een andere computer is er alleen Origin.
  const onlyOrigin = await register(base, { ...ANNA, email: 'bram@example.com' }, { fetchSite: null });
  assert.equal(onlyOrigin.status, 303);

  assert.equal(countUsers(db), 2);
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

const WRONG = 'fout fout fout fout';

test('na te veel mislukte inlogpogingen vanaf één IP-adres moet je wachten', async (t) => {
  const { base } = await startServer(t, { loginLimit: 3 });
  await register(base);

  for (let i = 0; i < 3; i++) {
    assert.equal((await login(base, ANNA.email, WRONG)).status, 401);
  }
  // Nu is het even op slot, zelfs met het goede wachtwoord.
  const blocked = await login(base, ANNA.email, ANNA.wachtwoord);
  assert.equal(blocked.status, 429);
  assert.match(alertText(await blocked.text()), /Te veel mislukte pogingen/);
});

test('na te veel mislukte pogingen op één account gaat alleen dat account even op slot', async (t) => {
  // De IP-limiet staat hoog, zodat we zien dat de limiet per account apart werkt.
  const { db, base } = await startServer(t, { loginLimit: 100, accountLimit: 3 });
  await register(base);
  await register(base, { ...ANNA, email: 'bram@example.com' });

  for (let i = 0; i < 3; i++) {
    assert.equal((await login(base, ANNA.email, WRONG)).status, 401);
  }
  assert.equal((await login(base, ANNA.email, ANNA.wachtwoord)).status, 429);
  assert.equal((await login(base, 'bram@example.com', ANNA.wachtwoord)).status, 303);

  // In de database staan alleen hashes, geen leesbare e-mail- of IP-adressen.
  for (const { id } of db.prepare('SELECT id FROM rate_limits').all()) {
    assert.match(id, /^[0-9a-f]{64}$/);
  }
});

test('de telling overleeft een herstart van de server', async (t) => {
  const db = openDatabase(':memory:');
  const first = await startServer(t, { db, loginLimit: 100, accountLimit: 3 });
  await register(first.base);
  for (let i = 0; i < 3; i++) {
    await login(first.base, ANNA.email, WRONG);
  }
  await first.close();

  // Een nieuwe server met dezelfde database weet nog van de mislukte pogingen.
  const second = await startServer(t, { db, loginLimit: 100, accountLimit: 3 });
  assert.equal((await login(second.base, ANNA.email, ANNA.wachtwoord)).status, 429);
});

test('na een geslaagde login begint de telling voor dat account opnieuw', async (t) => {
  const { base } = await startServer(t, { loginLimit: 100, accountLimit: 3 });
  await register(base);

  // Zonder reset zou de vierde mislukte poging al geblokkeerd worden.
  for (const password of [WRONG, WRONG, ANNA.wachtwoord, WRONG, WRONG]) {
    await login(base, ANNA.email, password);
  }
  assert.equal((await login(base, ANNA.email, ANNA.wachtwoord)).status, 303);
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

test('de startpagina is voor iedereen, en stuurt ingelogde mensen naar hun dashboard', async (t) => {
  const { base } = await startServer(t);
  const home = await send(base, '/');
  assert.equal(home.status, 200); // de e-mailcontrole, zonder dat je moet inloggen
  assert.equal(home.headers.get('location'), null);

  const cookie = sessionCookie(await register(base));
  for (const path of ['/', '/inloggen', '/registreren']) {
    const response = await send(base, path, { cookie });
    assert.equal(response.headers.get('location'), '/dashboard', path);
  }
});

test('te veel aanmeldingen vanaf één IP-adres worden even tegengehouden', async (t) => {
  const { db, base } = await startServer(t, { registerLimit: 2 });
  await register(base, { ...ANNA, email: 'een@example.com' });
  await register(base, { ...ANNA, email: 'twee@example.com' });

  const third = await register(base, { ...ANNA, email: 'drie@example.com' });
  assert.equal(third.status, 429);
  assert.match(alertText(await third.text()), /Te veel aanmeldingen/);
  assert.equal(countUsers(db), 2);
});

test('twee aanmeldingen tegelijk met hetzelfde adres leveren één account op', async (t) => {
  // De wachtwoordcheck wacht even, zodat beide aanmeldingen zeker tegelijk lopen.
  const slowCheck = () => new Promise((resolve) => setTimeout(() => resolve(false), 50));
  const { db, base } = await startServer(t, { pwnedCheck: slowCheck });

  const responses = await Promise.all([register(base), register(base)]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [303, 400]);
  assert.equal(countUsers(db), 1);
});

test('een onverwachte fout geeft een nette foutpagina, zonder technische details', async (t) => {
  t.mock.method(console, 'error', () => {}); // houd de testuitvoer schoon
  const brokenCheck = async () => {
    throw new Error('geheime details uit de server');
  };
  const { base } = await startServer(t, { pwnedCheck: brokenCheck });

  const response = await register(base);
  assert.equal(response.status, 500);
  const html = await response.text();
  assert.match(html, /Er ging iets mis/);
  assert.ok(!html.includes('geheime details'));
});

test('onbekende pagina geeft een nette 404', async (t) => {
  const { base } = await startServer(t);
  const response = await send(base, '/bestaat-niet');
  assert.equal(response.status, 404);
  assert.match(await response.text(), /Pagina niet gevonden/);
});

test('account verwijderen wist al je gegevens en logt je uit', async (t) => {
  const { db, base } = await startServer(t);
  const cookie = sessionCookie(await register(base));

  const dashboard = await (await send(base, '/dashboard', { cookie })).text();
  assert.match(dashboard, /href="\/account\/verwijderen"/);
  assert.equal((await send(base, '/account/verwijderen', { cookie })).status, 200);

  const response = await send(base, '/account/verwijderen', {
    method: 'POST', cookie, fields: { wachtwoord: ANNA.wachtwoord },
  });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), '/inloggen?verwijderd');
  assert.equal(countUsers(db), 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);

  // De oude cookie werkt niet meer, en inloggen kan ook niet meer.
  assert.equal((await send(base, '/dashboard', { cookie })).status, 303);
  assert.equal((await login(base, ANNA.email, ANNA.wachtwoord)).status, 401);

  const notice = await (await send(base, '/inloggen?verwijderd')).text();
  assert.match(notice, /Je account en al je gegevens zijn verwijderd/);
});

test('account verwijderen kan alleen met het juiste wachtwoord', async (t) => {
  const { db, base } = await startServer(t, { accountLimit: 2 });
  const cookie = sessionCookie(await register(base));
  const tryDelete = (wachtwoord) => send(base, '/account/verwijderen', {
    method: 'POST', cookie, fields: { wachtwoord },
  });

  const wrong = await tryDelete(WRONG);
  assert.equal(wrong.status, 401);
  assert.match(alertText(await wrong.text()), /niet verwijderd/);
  assert.equal(countUsers(db), 1);

  // Na te veel foute pogingen moet je even wachten, ook met het goede wachtwoord.
  await tryDelete(WRONG);
  assert.equal((await tryDelete(ANNA.wachtwoord)).status, 429);
  assert.equal(countUsers(db), 1);
});

test('de privacyverklaring is voor iedereen te lezen en overal gelinkt', async (t) => {
  const { base } = await startServer(t);

  const response = await send(base, '/privacy');
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<h1>Privacyverklaring<\/h1>/);
  assert.match(html, /Concept: vul/); // zonder contactgegevens staat er een herinnering

  assert.match(await (await send(base, '/inloggen')).text(), /href="\/privacy"/);
  assert.match(await (await send(base, '/registreren')).text(), /href="\/privacy"/);
});

test('de privacyverklaring toont je contactgegevens als je die instelt', async (t) => {
  const contact = { name: 'Anna de Vries', email: 'privacy@example.com' };
  const { base } = await startServer(t, { contact });

  const html = await (await send(base, '/privacy')).text();
  assert.match(html, /Anna de Vries/);
  assert.match(html, /privacy@example\.com/);
  assert.doesNotMatch(html, /Concept: vul/);
});

test('zonder inloggen kun je geen account verwijderen', async (t) => {
  const { db, base } = await startServer(t);
  await register(base);

  assert.equal((await send(base, '/account/verwijderen')).status, 303);
  const response = await send(base, '/account/verwijderen', {
    method: 'POST', fields: { wachtwoord: ANNA.wachtwoord },
  });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), '/inloggen');
  assert.equal(countUsers(db), 1);
});
