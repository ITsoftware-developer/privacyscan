// Tests voor het bevestigen van je e-mailadres en het versturen van mail.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { createConfirmation, confirmEmail, isConfirmationValid } from '../src/confirm.js';
import { openDatabase } from '../src/db.js';
import { createMailer } from '../src/mail.js';
import { isLoopback } from '../src/routes-scan.js';
import {
  ANNA, alertText, confirmationToken, login, register, registerConfirmed, send, sessionCookie, startServer,
} from './helpers.js';

const TOKEN = /[A-Za-z0-9_-]{43}/;

function confirmedAt(db) {
  return db.prepare('SELECT email_confirmed_at AS at FROM users').get().at;
}

test('na het registreren staat er een bevestigingsmail in het testpostvak', async (t) => {
  const { db, mailer, base } = await startServer(t);
  const cookie = sessionCookie(await register(base));

  assert.equal(mailer.outbox.length, 1);
  const [mail] = mailer.outbox;
  assert.equal(mail.to, ANNA.email);
  assert.match(mail.subject, /Bevestig je e-mailadres/);
  assert.match(mail.text, /Hoi Anna de Vries/);
  assert.match(mail.text, /http:\/\/localhost:3000\/e-mail-bevestigen\?token=[A-Za-z0-9_-]{43}\n/);
  assert.equal(confirmedAt(db), null);

  const html = await (await send(base, '/dashboard', { cookie })).text();
  assert.match(html, /Nog niet bevestigd/);
  assert.match(html, /Stuur de mail opnieuw/);
  assert.match(html, /href="\/dev\/mails"/); // op je eigen computer wijzen we naar het testpostvak
});

test('het token staat alleen als hash in de database en verloopt na 30 minuten', async (t) => {
  const { db, mailer, base } = await startServer(t);
  const before = Date.now();
  await register(base);
  const token = confirmationToken(mailer);

  const rows = db.prepare('SELECT * FROM email_confirmations').all();
  assert.equal(rows.length, 1);
  assert.match(rows[0].id, /^[0-9a-f]{64}$/);
  assert.notEqual(rows[0].id, token);

  const minutes = (rows[0].expires_at - before) / 60000;
  assert.ok(minutes > 29.9 && minutes < 30.2, `verloopt na ${minutes} minuten`);

  // Het token zelf staat nergens in de database.
  const everything = JSON.stringify(db.prepare('SELECT * FROM users').all());
  assert.ok(!everything.includes(token));
});

test('de link uit de mail bevestigt niet vanzelf: je moet eerst op de knop drukken', async (t) => {
  const { db, mailer, base } = await startServer(t);
  await register(base);
  const token = confirmationToken(mailer);

  // Mailprogramma's openen links soms automatisch. Dat mag niets bevestigen.
  const page = await send(base, `/e-mail-bevestigen?token=${token}`);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  const html = await page.text();
  assert.match(html, /<form method="post" action="\/e-mail-bevestigen">/);
  assert.ok(html.includes(`name="token" value="${token}"`));
  assert.equal(confirmedAt(db), null);
});

test('op de knop drukken bevestigt het adres, en de link werkt maar één keer', async (t) => {
  const { db, mailer, base } = await startServer(t);
  const cookie = sessionCookie(await register(base));
  const token = confirmationToken(mailer);

  const done = await send(base, '/e-mail-bevestigen', { method: 'POST', fields: { token } });
  assert.equal(done.status, 200);
  assert.match(await done.text(), /je e-mailadres is bevestigd/);
  assert.ok(confirmedAt(db) > 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM email_confirmations').get().n, 0);

  const dashboard = await (await send(base, '/dashboard', { cookie })).text();
  assert.match(dashboard, />\s*Bevestigd\s*</);
  assert.doesNotMatch(dashboard, /Stuur de mail opnieuw/);

  const again = await send(base, '/e-mail-bevestigen', { method: 'POST', fields: { token } });
  assert.equal(again.status, 400);
  assert.match(await again.text(), /werkt niet \(meer\)/);
  assert.equal((await send(base, `/e-mail-bevestigen?token=${token}`)).status, 400);
});

test('een verlopen link werkt niet', async (t) => {
  const { db, mailer, base } = await startServer(t);
  await register(base);
  const token = confirmationToken(mailer);
  db.prepare('UPDATE email_confirmations SET expires_at = ?').run(Date.now() - 1000);

  assert.equal((await send(base, `/e-mail-bevestigen?token=${token}`)).status, 400);
  const response = await send(base, '/e-mail-bevestigen', { method: 'POST', fields: { token } });
  assert.equal(response.status, 400);
  assert.match(alertText(await response.text()), /verlopen of al gebruikt/);
  assert.equal(confirmedAt(db), null);
});

test('verzonnen en kapotte tokens worden geweigerd', async (t) => {
  const { db, base } = await startServer(t);
  await register(base);

  const tokens = ['', 'x', 'A'.repeat(43), 'A'.repeat(500), '<script>alert(1)</script>', "' OR 1=1 --"];
  for (const token of tokens) {
    const query = await send(base, `/e-mail-bevestigen?token=${encodeURIComponent(token)}`);
    assert.equal(query.status, 400, `GET met "${token.slice(0, 20)}"`);
    const post = await send(base, '/e-mail-bevestigen', { method: 'POST', fields: { token } });
    assert.equal(post.status, 400, `POST met "${token.slice(0, 20)}"`);
  }
  // Twee keer token= in de adresbalk, en helemaal geen token.
  assert.equal((await send(base, '/e-mail-bevestigen?token=a&token=b')).status, 400);
  assert.equal((await send(base, '/e-mail-bevestigen')).status, 400);
  assert.equal((await send(base, '/e-mail-bevestigen', { method: 'POST' })).status, 400);
  assert.equal(confirmedAt(db), null);
});

test('bevestigen en opnieuw versturen vanaf een andere website wordt geweigerd (CSRF)', async (t) => {
  const { db, mailer, base } = await startServer(t);
  const cookie = sessionCookie(await register(base));
  const token = confirmationToken(mailer);

  const confirm = await send(base, '/e-mail-bevestigen', {
    method: 'POST', fields: { token }, fetchSite: 'cross-site', origin: 'https://andere-site.example',
  });
  assert.equal(confirm.status, 403);
  const resend = await send(base, '/bevestiging-opnieuw', {
    method: 'POST', cookie, fetchSite: 'cross-site', origin: 'https://andere-site.example',
  });
  assert.equal(resend.status, 403);

  assert.equal(confirmedAt(db), null);
  assert.equal(mailer.outbox.length, 1);
});

test('een nieuwe mail laten sturen maakt de oude link ongeldig', async (t) => {
  const { mailer, base } = await startServer(t);
  const cookie = sessionCookie(await register(base));
  const oldToken = confirmationToken(mailer);

  const response = await send(base, '/bevestiging-opnieuw', { method: 'POST', cookie });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), '/dashboard?verstuurd');
  assert.equal(mailer.outbox.length, 2);

  const newToken = confirmationToken(mailer);
  assert.notEqual(newToken, oldToken);
  assert.equal((await send(base, `/e-mail-bevestigen?token=${oldToken}`)).status, 400);
  assert.equal((await send(base, `/e-mail-bevestigen?token=${newToken}`)).status, 200);

  const dashboard = await (await send(base, '/dashboard?verstuurd', { cookie })).text();
  assert.match(dashboard, /We hebben een nieuwe bevestigingsmail gestuurd/);
});

test('een nieuwe mail laten sturen kan maar een paar keer per uur', async (t) => {
  const { mailer, base } = await startServer(t, { resendLimit: 2 });
  const cookie = sessionCookie(await register(base));

  for (let i = 0; i < 2; i++) {
    assert.equal((await send(base, '/bevestiging-opnieuw', { method: 'POST', cookie })).status, 303);
  }
  const blocked = await send(base, '/bevestiging-opnieuw', { method: 'POST', cookie });
  assert.equal(blocked.status, 429);
  assert.match(await blocked.text(), /Even wachten/);
  assert.equal(mailer.outbox.length, 3); // de mail bij het registreren en twee nieuwe
});

test('een adres dat al bevestigd is krijgt geen nieuwe mail', async (t) => {
  const { mailer, base } = await startServer(t);
  const cookie = await registerConfirmed(base, mailer);
  const count = mailer.outbox.length;

  const response = await send(base, '/bevestiging-opnieuw', { method: 'POST', cookie });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), '/dashboard');
  assert.equal(mailer.outbox.length, count);
});

test('zonder inloggen kun je geen nieuwe mail laten sturen', async (t) => {
  const { mailer, base } = await startServer(t);
  const response = await send(base, '/bevestiging-opnieuw', { method: 'POST' });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), '/inloggen');
  assert.equal(mailer.outbox.length, 0);
});

test('de link in de mail gebruikt het ingestelde adres, ook bij een vervalste Host-header', async (t) => {
  const { mailer, base } = await startServer(t, { baseUrl: 'https://privacyscan.example' });

  // Een aanvaller vult een ander adres in de Host-header in, in de hoop dat de
  // mail een link naar zijn eigen site bevat.
  const url = new URL(base);
  const body = new URLSearchParams(ANNA).toString();
  const status = await new Promise((resolve, reject) => {
    const req = request({
      hostname: url.hostname,
      port: url.port,
      path: '/registreren',
      method: 'POST',
      headers: {
        host: 'aanvaller.example',
        'content-type': 'application/x-www-form-urlencoded',
        'content-length': Buffer.byteLength(body),
        'sec-fetch-site': 'same-origin',
      },
    }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end(body);
  });

  assert.equal(status, 303);
  const { text } = mailer.outbox[0];
  assert.match(text, /^https:\/\/privacyscan\.example\/e-mail-bevestigen\?token=/m);
  assert.ok(!text.includes('aanvaller.example'));
});

test('als de mail niet verstuurd kan worden, lukt de aanmelding toch', async (t) => {
  const errors = t.mock.method(console, 'error', () => {});
  const broken = { usesSmtp: true, outbox: [], send: async () => { throw new Error('mailserver is stuk'); } };
  const { db, base } = await startServer(t, { mailer: broken });

  const response = await register(base);
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), '/dashboard');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1);
  assert.match(errors.mock.calls[0].arguments[0], /mailserver is stuk/);

  // Opnieuw proberen geeft een nette melding, zonder technische details.
  const cookie = sessionCookie(response);
  const retry = await send(base, '/bevestiging-opnieuw', { method: 'POST', cookie });
  assert.equal(retry.status, 502);
  assert.match(await retry.text(), /Mail versturen mislukt/);
});

test('het testpostvak laat de mails zien, met een klikbare link', async (t) => {
  const { mailer, base } = await startServer(t);
  await register(base);
  const token = confirmationToken(mailer);

  const page = await send(base, '/dev/mails');
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  const html = await page.text();
  assert.match(html, /Bevestig je e-mailadres voor Privacyscan/);
  assert.ok(html.includes(`<a href="http://localhost:3000/e-mail-bevestigen?token=${token}">`));
});

test('het testpostvak bestaat niet op een echte site, en niet met een echte mailserver', async (t) => {
  const online = await startServer(t, { production: true });
  assert.equal((await send(online.base, '/dev/mails')).status, 404);

  const smtp = { usesSmtp: true, outbox: [], send: async () => {} };
  const { base } = await startServer(t, { mailer: smtp });
  const html = await (await send(base, '/dev/mails')).text();
  assert.match(html, /SMTP_URL<\/code> staat aan/);
  // En dan verwijst het dashboard er ook niet meer naar.
  const cookie = sessionCookie(await register(base));
  assert.doesNotMatch(await (await send(base, '/dashboard', { cookie })).text(), /href="\/dev\/mails"/);
});

test('alleen verzoeken van deze computer zelf mogen het testpostvak zien', () => {
  for (const address of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) assert.ok(isLoopback(address));
  for (const address of ['192.168.1.20', '10.0.0.5', '::ffff:192.168.1.20', '', undefined]) {
    assert.ok(!isLoopback(address), String(address));
  }
});

test('createConfirmation geeft elk account maar één geldige link tegelijk', () => {
  const db = openDatabase(':memory:');
  db.prepare("INSERT INTO users (id, name, email, password_hash, created_at) VALUES (1, 'A', 'a@example.com', 'x', 0)").run();
  db.prepare("INSERT INTO users (id, name, email, password_hash, created_at) VALUES (2, 'B', 'b@example.com', 'x', 0)").run();

  const first = createConfirmation(db, 1);
  const other = createConfirmation(db, 2);
  const second = createConfirmation(db, 1);

  assert.match(first, TOKEN);
  assert.ok(!isConfirmationValid(db, first));
  assert.ok(isConfirmationValid(db, second));
  assert.ok(isConfirmationValid(db, other)); // het andere account blijft ongemoeid
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM email_confirmations').get().n, 2);
});

test('een tweede bevestiging verandert het tijdstip van de eerste niet', () => {
  const db = openDatabase(':memory:');
  db.prepare("INSERT INTO users (id, name, email, password_hash, created_at) VALUES (1, 'A', 'a@example.com', 'x', 0)").run();

  assert.ok(confirmEmail(db, createConfirmation(db, 1), 1000));
  assert.ok(confirmEmail(db, createConfirmation(db, 1), 2000));
  assert.equal(db.prepare('SELECT email_confirmed_at AS at FROM users').get().at, 1000);
});

test('de mailer bewaart in het testpostvak de 20 nieuwste mails, nieuwste eerst', async () => {
  const mailer = createMailer();
  assert.equal(mailer.usesSmtp, false);

  for (let i = 1; i <= 25; i++) {
    await mailer.send({ to: 'a@example.com', subject: `Mail ${i}`, text: 'tekst' });
  }
  assert.equal(mailer.outbox.length, 20);
  assert.equal(mailer.outbox[0].subject, 'Mail 25');
  assert.equal(mailer.outbox.at(-1).subject, 'Mail 6');
});

test('met SMTP_URL gaat de mail naar de mailserver, met het adres als los object', async () => {
  const sent = [];
  const created = [];
  const mailer = createMailer({
    smtpUrl: 'smtp://127.0.0.1:1025',
    from: 'Privacyscan <noreply@example.com>',
    createTransport: (url) => {
      created.push(url);
      return { sendMail: async (message) => { sent.push(message); } };
    },
  });

  assert.equal(mailer.usesSmtp, true);
  await mailer.send({ to: 'x,y@example.com', subject: 'Hoi', text: 'tekst' });

  assert.deepEqual(created, ['smtp://127.0.0.1:1025']);
  assert.deepEqual(sent, [{
    from: 'Privacyscan <noreply@example.com>',
    to: { name: '', address: 'x,y@example.com' }, // één adres, geen lijstje
    subject: 'Hoi',
    text: 'tekst',
  }]);
  assert.equal(mailer.outbox.length, 0); // niets in het testpostvak

  // Een fout van de mailserver komt bij de aanroeper terecht.
  const failing = createMailer({
    smtpUrl: 'smtp://x',
    createTransport: () => ({ sendMail: async () => { throw new Error('geweigerd'); } }),
  });
  await assert.rejects(failing.send({ to: 'a@example.com', subject: 's', text: 't' }), /geweigerd/);
});

test('een bevestigde gebruiker kan gewoon opnieuw inloggen', async (t) => {
  const { mailer, base } = await startServer(t);
  await registerConfirmed(base, mailer);

  const response = await login(base, ANNA.email, ANNA.wachtwoord);
  assert.equal(response.status, 303);
  const dashboard = await (await send(base, '/dashboard', { cookie: sessionCookie(response) })).text();
  assert.match(dashboard, />\s*Bevestigd\s*</);
});

test('op het dashboard staat je account pas op "Klaar" als je e-mailadres bevestigd is', async (t) => {
  const { mailer, base } = await startServer(t);
  const cookie = sessionCookie(await register(base));

  let html = await (await send(base, '/dashboard', { cookie })).text();
  assert.match(html, /<span class="badge badge-warn">Actie nodig<\/span>/);
  assert.match(html, /<span class="badge badge-warn">Nog niet bevestigd<\/span>/);
  assert.doesNotMatch(html, /badge-ok">Klaar</);

  await send(base, '/e-mail-bevestigen', { method: 'POST', fields: { token: confirmationToken(mailer) } });
  html = await (await send(base, '/dashboard', { cookie })).text();
  assert.match(html, /<span class="badge badge-ok">Klaar<\/span>/);
  assert.match(html, /<span class="badge badge-ok">Bevestigd<\/span>/);
  assert.doesNotMatch(html, /Actie nodig/);
});
