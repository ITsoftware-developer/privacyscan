// Tests voor de beheerder: op een openbare site mag alleen het account met het
// bevestigde adres uit OWNER_EMAIL op naam zoeken, zonder identiteitscheck.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';
import { isValidEmail, normalizeEmail } from '../src/email.js';
import { hasOwnerAddress, isOwner, parseOwnerEmail } from '../src/owner.js';
import {
  ANNA, CLUB, GIDS, alertText, fakeHibp, fakeSearch, register, registerConfirmed, send, sessionCookie, startServer,
} from './helpers.js';

const BRAM = { ...ANNA, naam: 'Bram Bakker', email: 'bram@example.com' };

// Een openbare site (production) waarvan Anna de beheerder is.
async function online(t, { owner = ANNA.email, results = [CLUB, GIDS], isDemo = false, ...options } = {}) {
  const search = fakeSearch({ results, isDemo });
  const server = await startServer(t, {
    production: true, ownerEmail: owner, hibp: fakeHibp(), search, ...options,
  });
  return { ...server, search };
}

function scan(base, cookie) {
  return send(base, '/scan/web', { method: 'POST', cookie });
}

function page(base, cookie, path) {
  return send(base, path, { cookie }).then((response) => response.text());
}

// --- De regels zelf -------------------------------------------------------------

test('e-mailadressen worden overal op dezelfde manier netjes gemaakt en gecontroleerd', () => {
  assert.equal(normalizeEmail('  Anna@Example.COM '), 'anna@example.com');
  assert.equal(normalizeEmail(undefined), '');
  assert.equal(normalizeEmail(null), '');

  for (const goed of ['anna@example.com', 'a.b+c@sub.example.nl']) assert.equal(isValidEmail(goed), true, goed);
  for (const fout of ['', 'anna', 'anna@', '@example.com', 'anna@example', 'an na@example.com', 'a@b@c.nl']) {
    assert.equal(isValidEmail(fout), false, fout);
  }
  assert.equal(isValidEmail(`${'a'.repeat(250)}@b.nl`), false); // langer dan 254 tekens
});

test('parseOwnerEmail: leeg betekent geen beheerder, de rest wordt netjes gemaakt', () => {
  for (const leeg of [undefined, null, '', '   ']) assert.equal(parseOwnerEmail(leeg), null);
  assert.equal(parseOwnerEmail('  Anna@Example.COM '), 'anna@example.com');
  assert.equal(parseOwnerEmail(parseOwnerEmail('Anna@Example.com')), 'anna@example.com'); // twee keer mag
});

test('parseOwnerEmail weigert een ongeldig adres met een duidelijke melding', () => {
  for (const fout of ['anna', 'anna@example', 'anna@@example.com', 'anna example@x.nl']) {
    assert.throws(() => parseOwnerEmail(fout), (error) => {
      assert.match(error.message, /^OWNER_EMAIL is geen geldig e-mailadres: /);
      assert.ok(error.message.includes(fout.trim()));
      return true;
    }, fout);
  }
});

test('isOwner: het adres moet precies kloppen én bevestigd zijn', () => {
  const owner = 'anna@example.com';
  const bevestigd = (email) => ({ email, email_confirmed_at: 1000 });
  const onbevestigd = (email) => ({ email, email_confirmed_at: null });

  assert.equal(isOwner(bevestigd('anna@example.com'), owner), true);
  assert.equal(isOwner(bevestigd('Anna@Example.COM'), owner), true); // hoofdletters maken niet uit

  // Bijna hetzelfde is niet hetzelfde.
  for (const ander of ['xanna@example.com', 'anna@example.com.nl', 'anna+test@example.com', 'anna@mail.example.com', 'anna@example.org', '']) {
    assert.equal(isOwner(bevestigd(ander), owner), false, ander);
  }

  assert.equal(isOwner(onbevestigd('anna@example.com'), owner), false); // zonder bevestiging geen beheerder
  assert.equal(hasOwnerAddress(onbevestigd('anna@example.com'), owner), true); // het adres klopt wel
  assert.equal(hasOwnerAddress(onbevestigd('bram@example.com'), owner), false);

  // Zonder beheerder, of zonder gebruiker, is er niemand.
  for (const geen of [null, undefined, '']) {
    assert.equal(isOwner(bevestigd('anna@example.com'), geen), false);
    assert.equal(hasOwnerAddress(bevestigd('anna@example.com'), geen), false);
  }
  assert.equal(isOwner(null, owner), false);
  assert.equal(isOwner(undefined, owner), false);
});

test('een ongeldig OWNER_EMAIL laat de app niet starten', () => {
  const db = openDatabase(':memory:');
  assert.throws(() => createApp({ db, ownerEmail: 'geen-adres' }), /OWNER_EMAIL is geen geldig e-mailadres/);
  assert.doesNotThrow(() => createApp({ db, ownerEmail: 'anna@example.com' }));
  assert.doesNotThrow(() => createApp({ db, ownerEmail: '' }));
});

// --- Zoeken op een openbare site -----------------------------------------------------

test('de beheerder mag op een openbare site op naam zoeken', async (t) => {
  const { db, base, mailer, search } = await online(t);
  const cookie = await registerConfirmed(base, mailer);

  const response = await send(base, '/scan/web', {
    method: 'POST', cookie, fields: { q: 'iemand anders', naam: 'Jan Jansen' },
  });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), '/resultaten?gescand=web#web');

  // De zoekopdracht komt uit het account, niet uit wat er is meegestuurd.
  assert.deepEqual(search.calls, [{ query: '"Anna de Vries"', name: 'Anna de Vries', city: '' }]);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM findings WHERE kind = 'web'").get().n, 2);
  assert.match(await page(base, cookie, '/resultaten'), /Uitslagen clubkampioenschappen/);
});

test('een ander account mag dat niet, ook niet met een bevestigd e-mailadres', async (t) => {
  const { db, base, mailer, search } = await online(t);
  const anna = await registerConfirmed(base, mailer);
  const bram = await registerConfirmed(base, mailer, BRAM);

  const response = await scan(base, bram);
  assert.equal(response.status, 403);
  assert.match(alertText(await response.text()), /Zoeken op naam staat uit op een openbare site/);
  assert.deepEqual(search.calls, []); // er is niets naar de zoekdienst gegaan
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM findings').get().n, 0);

  // En de beheerder kan het nog steeds.
  assert.equal((await scan(base, anna)).status, 303);
  assert.deepEqual(search.calls.map((call) => call.name), ['Anna de Vries']);
});

test('een account met het adres van de beheerder dat niet bevestigd is, mag niets', async (t) => {
  const { base, search } = await online(t);
  const cookie = sessionCookie(await register(base)); // geregistreerd, niet bevestigd

  const response = await scan(base, cookie);
  assert.equal(response.status, 403);
  assert.match(await response.text(), /Bevestig eerst je e-mailadres/);
  assert.deepEqual(search.calls, []);

  assert.equal((await send(base, '/profiel', { cookie })).status, 404);

  // Het dashboard nodigt uit om te bevestigen en zegt niet dat zoeken uit staat.
  const dashboard = await page(base, cookie, '/dashboard');
  assert.match(dashboard, /Daarna kun je hier zoeken waar je naam online opduikt/);
  assert.doesNotMatch(dashboard, /Zoeken op je naam staat uit/);
  assert.doesNotMatch(dashboard, /action="\/scan\/web"/);
  assert.doesNotMatch(dashboard, /Je bent de beheerder/);
});

test('een bijna gelijk adres is geen beheerder', async (t) => {
  const { base, mailer, search } = await online(t, { scanLimit: 100 });

  for (const email of ['xanna@example.com', 'anna+test@example.com', 'anna@example.com.nl', 'anna@mail.example.com']) {
    const cookie = await registerConfirmed(base, mailer, { ...ANNA, email });
    assert.equal((await scan(base, cookie)).status, 403, email);
  }
  assert.deepEqual(search.calls, []);
});

test('hoofdletters en spaties in OWNER_EMAIL maken niet uit', async (t) => {
  const { base, mailer, search } = await online(t, { owner: '  ANNA@Example.COM ' });
  const cookie = await registerConfirmed(base, mailer);

  assert.equal((await scan(base, cookie)).status, 303);
  assert.equal(search.calls.length, 1);
});

test('zonder beheerder mag op een openbare site niemand op naam zoeken', async (t) => {
  for (const owner of [null, '']) {
    const { base, mailer, search } = await online(t, { owner });
    const cookie = await registerConfirmed(base, mailer);

    assert.equal((await scan(base, cookie)).status, 403);
    assert.deepEqual(search.calls, []);
    assert.equal((await send(base, '/profiel', { cookie })).status, 404);
  }
});

test('op je eigen computer maakt OWNER_EMAIL niets uit: wie erbij kan, mag zoeken', async (t) => {
  const search = fakeSearch({ results: [CLUB] });
  const { base, mailer } = await startServer(t, {
    hibp: fakeHibp(), search, ownerEmail: 'iemand-anders@example.com',
  });
  const cookie = await registerConfirmed(base, mailer);

  assert.equal((await scan(base, cookie)).status, 303);
  assert.equal(search.calls.length, 1);
  assert.equal((await send(base, '/profiel', { cookie })).status, 200);
  // Op je eigen computer is er geen beheerder-uitleg nodig.
  assert.doesNotMatch(await page(base, cookie, '/dashboard'), /Je bent de beheerder/);
});

test('ook de beheerder heeft een limiet op het aantal zoekopdrachten', async (t) => {
  const { base, mailer, search } = await online(t, { scanLimit: 1 });
  const cookie = await registerConfirmed(base, mailer);

  assert.equal((await scan(base, cookie)).status, 303);
  assert.equal((await scan(base, cookie)).status, 429);
  assert.equal(search.calls.length, 1);
});

// --- De woonplaats-pagina en het dashboard ----------------------------------------------

test('de woonplaats-pagina bestaat alleen voor de beheerder', async (t) => {
  const { db, base, mailer } = await online(t);
  const anna = await registerConfirmed(base, mailer);
  const bram = await registerConfirmed(base, mailer, BRAM);
  const city = (email) => db.prepare('SELECT city FROM users WHERE email = ?').get(email).city;

  assert.equal((await send(base, '/profiel', { cookie: anna })).status, 200);
  const saved = await send(base, '/profiel', { method: 'POST', cookie: anna, fields: { woonplaats: 'Utrecht' } });
  assert.equal(saved.status, 303);
  assert.equal(city(ANNA.email), 'Utrecht');

  assert.equal((await send(base, '/profiel', { cookie: bram })).status, 404);
  const refused = await send(base, '/profiel', { method: 'POST', cookie: bram, fields: { woonplaats: 'Rotterdam' } });
  assert.equal(refused.status, 404);
  assert.equal(city(BRAM.email), null); // er is niets bewaard

  // En zonder in te loggen, gaat het zoals altijd naar de inlogpagina.
  assert.equal((await send(base, '/profiel')).headers.get('location'), '/inloggen');
});

test('de zoekopdracht van de beheerder gebruikt zijn woonplaats', async (t) => {
  const { base, mailer, search } = await online(t);
  const cookie = await registerConfirmed(base, mailer);
  await send(base, '/profiel', { method: 'POST', cookie, fields: { woonplaats: 'Utrecht' } });

  await scan(base, cookie);
  assert.deepEqual(search.calls, [{ query: '"Anna de Vries" "Utrecht"', name: 'Anna de Vries', city: 'Utrecht' }]);
});

test('het dashboard: de beheerder ziet de zoekknop en uitleg, anderen zien dat het uit staat', async (t) => {
  const { base, mailer } = await online(t);
  const anna = await registerConfirmed(base, mailer);
  const bram = await registerConfirmed(base, mailer, BRAM);

  const owner = await page(base, anna, '/dashboard');
  assert.match(owner, /action="\/scan\/web"/);
  assert.match(owner, /Je bent de beheerder van deze site\. Alleen jij mag hier op naam zoeken, zonder identiteitscheck\./);
  assert.match(owner, /href="\/profiel"/);

  const other = await page(base, bram, '/dashboard');
  assert.doesNotMatch(other, /action="\/scan\/web"/);
  assert.match(other, /Zoeken op je naam staat uit op een openbare site/);
  assert.doesNotMatch(other, /Je bent de beheerder/);
  assert.doesNotMatch(other, /href="\/profiel"/);
});

// --- De privacyverklaring ---------------------------------------------------------------

const READABLE = (html) => html
  .replace(/<[^>]+>/g, ' ')
  .replace(/\s+/g, ' ')
  .replace(/\s+([.,;:)])/g, '$1');

async function privacyText(t, options) {
  const { base } = await online(t, options);
  return READABLE(await (await send(base, '/privacy')).text());
}

test('de privacyverklaring zegt dat alleen de beheerder op naam zoekt', async (t) => {
  const text = await privacyText(t, { isDemo: true });

  assert.match(text, /Zoeken op naam staat op deze site uit, behalve voor de beheerder/);
  assert.match(text, /alleen de beheerder van de site op naam, en alleen op zijn eigen naam/);
  assert.match(text, /Je woonplaats, als je die zelf invult \(alleen de beheerder kan dat\)/);
  assert.match(text, /demo met verzonnen resultaten\. Daarbij gaat er niets naar buiten/);
  // Over andere gebruikers klopt dit ook: hun naam gaat nooit naar een zoekdienst.
  assert.match(text, /Voor andere gebruikers dan de beheerder staat zoeken op naam uit/);
  assert.doesNotMatch(text, /Je naam gaat niet naar een zoekdienst, want zoeken op naam staat uit/);
  assert.doesNotMatch(text, /en je woonplaats wijzig je zelf/); // gewone gebruikers hebben die pagina niet
});

test('met een echte zoekdienst noemt de privacyverklaring wat er van de beheerder naartoe gaat', async (t) => {
  const { base } = await startServer(t, {
    production: true, ownerEmail: ANNA.email, hibp: fakeHibp(), search: fakeSearch({ name: 'Zoekmachine X' }),
  });
  const text = READABLE(await (await send(base, '/privacy')).text());

  assert.match(text, /hun naam gaat niet naar een zoekdienst/);
  assert.match(text, /Zoekt de beheerder, dan gaat diens naam \(en woonplaats\) naar de zoekdienst Zoekmachine X/);
  assert.doesNotMatch(text, /demo met verzonnen resultaten/);
});

test('zonder beheerder blijft de privacyverklaring bij "zoeken op naam staat uit"', async (t) => {
  const text = await privacyText(t, { owner: null });
  assert.match(text, /Zoeken op naam staat op deze site uit\. Een bevestigd/);
  assert.match(text, /Je naam gaat niet naar een zoekdienst, want zoeken op naam staat uit/);
  assert.doesNotMatch(text, /behalve voor de beheerder/);
  assert.doesNotMatch(text, /Je woonplaats/);
});
