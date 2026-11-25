// Hulpfuncties die alle tests delen: de app starten en verzoeken doen zoals een browser.
import { createApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';
import { createMailer } from '../src/mail.js';
import { createDemoSearch } from '../src/search.js';

export const ANNA = {
  naam: 'Anna de Vries',
  email: 'anna@example.com',
  wachtwoord: 'paars konijn op de fiets',
  wachtwoord2: 'paars konijn op de fiets',
};

// Start de app met een lege database in het geheugen (of met de database die je
// meegeeft). De wachtwoordcheck tegen datalekken staat uit, zodat de tests
// zonder internet werken, en mails komen in een testpostvak (mailer.outbox). De app krijgt de
// demo-zoekdienst, tenzij je zelf een zoekdienst meegeeft (search: null = geen zoekdienst).
export async function startServer(t, options = {}) {
  const db = options.db ?? openDatabase(':memory:');
  const mailer = options.mailer ?? createMailer();
  const app = createApp({ pwnedCheck: async () => false, search: createDemoSearch(), ...options, mailer, db });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const close = () => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  };
  t.after(close);
  return { db, mailer, close, base: `http://127.0.0.1:${server.address().port}` };
}

// Doet een verzoek zoals een browser dat zou doen. Bij een formulier sturen
// browsers de headers Origin en Sec-Fetch-Site mee; met null laat je er een weg.
export function send(base, path, { method = 'GET', fields, cookie, origin = base, fetchSite = 'same-origin' } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (method !== 'GET') {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    if (origin !== null) headers.origin = origin;
    if (fetchSite !== null) headers['sec-fetch-site'] = fetchSite;
  }
  return fetch(base + path, {
    method,
    headers,
    body: fields ? new URLSearchParams(fields) : undefined,
    redirect: 'manual',
  });
}

export function register(base, fields = ANNA, extra = {}) {
  return send(base, '/registreren', { method: 'POST', fields, ...extra });
}

export function login(base, email, wachtwoord) {
  return send(base, '/inloggen', { method: 'POST', fields: { email, wachtwoord } });
}

export function sessionCookie(response) {
  const line = response.headers.getSetCookie().find((c) => c.startsWith('sessie='));
  return line?.split(';')[0];
}

export function alertText(html) {
  return html.match(/class="alert alert-error[^"]*"[^>]*>([^<]*)</)?.[1].trim();
}

export function countUsers(db) {
  return db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
}

// Het token uit de link in de nieuwste mail in het testpostvak.
export function confirmationToken(mailer) {
  return mailer.outbox[0]?.text.match(/e-mail-bevestigen\?token=([A-Za-z0-9_-]+)/)?.[1];
}

// Maakt een account, bevestigt het e-mailadres en geeft de sessiecookie terug.
export async function registerConfirmed(base, mailer, fields = ANNA) {
  const cookie = sessionCookie(await register(base, fields));
  await send(base, '/e-mail-bevestigen', {
    method: 'POST', fields: { token: confirmationToken(mailer) },
  });
  return cookie;
}

// Een nepversie van Have I Been Pwned voor in de tests. Hij onthoudt welke adressen
// er gevraagd zijn (calls) en geeft de datalekken in `breaches` terug (een lijst, of
// een functie die per adres een lijst geeft). Met `error` gooit hij die fout.
export function fakeHibp({ breaches = [], error = null, hasKey = true } = {}) {
  const fake = {
    breaches,
    error,
    hasKey,
    calls: [],
    hasKeyFor: () => fake.hasKey,
    async breachesFor(email) {
      fake.calls.push(email);
      if (fake.error) throw fake.error;
      return typeof fake.breaches === 'function' ? fake.breaches(email) : fake.breaches;
    },
  };
  return fake;
}

export const ADOBE = {
  name: 'Adobe',
  title: 'Adobe',
  domain: 'adobe.com',
  breachDate: '2013-10-04',
  pwnCount: 152445165,
  dataClasses: ['Email addresses', 'Password hints', 'Passwords', 'Usernames'],
  description: 'In oktober 2013 lekten de gegevens van miljoenen Adobe-klanten.',
};

export const GAWKER = {
  name: 'Gawker',
  title: 'Gawker',
  domain: 'gawker.com',
  breachDate: '2010-12-11',
  pwnCount: 1247574,
  dataClasses: ['Email addresses', 'Passwords', 'Usernames'],
  description: 'In december 2010 lekte het forum van Gawker.',
};

// --- XposedOrNot, de gratis bron voor datalekken -----------------------------------------

export const jsonResponse = (status, body) => new Response(
  typeof body === 'string' ? body : JSON.stringify(body),
  { status, headers: { 'content-type': 'application/json' } },
);

// Zo ziet een lek er in de lijst van XposedOrNot uit (zie hun handleiding).
export const xonRaw = (breachID, extra = {}) => ({
  breachID,
  breachedDate: '2013-10-04T00:00:00+00:00',
  addedDate: '2014-01-01T00:00:00+00:00',
  domain: `${breachID.toLowerCase()}.com`,
  exposedData: ['Email addresses', 'Passwords'],
  exposedRecords: 152445165,
  exposureDescription: `In 2013 lekten de gegevens van <b>${breachID}</b> &amp; meer.`,
  industry: 'Technology',
  logo: 'https://xposedornot.com/static/logos/x.png',
  passwordRisk: 'easytocrack',
  referenceURL: `https://example.com/${breachID.toLowerCase()}`,
  searchable: true,
  sensitive: false,
  verified: true,
  ...extra,
});

// De lijst met alle lekken: twee gewone, een gevoelige en een die niet doorzoekbaar is.
export const XON_LIST = {
  exposedBreaches: [
    xonRaw('Adobe'),
    xonRaw('LinkedIn', { breachedDate: '2012-06-05T00:00:00+00:00', exposedRecords: 164611595, referenceURL: '' }),
    xonRaw('Datingsite', { sensitive: true }),
    xonRaw('Verborgen', { searchable: false }),
  ],
  status: 'success',
};

// Het antwoord van /v1/check-email als een adres in deze lekken zit.
export const xonFound = (...names) => ({ breaches: [names], email: 'x@example.com', status: 'success' });

// Een nep-fetch voor XposedOrNot, met een antwoord per soort aanvraag. Hij onthoudt alles
// wat er gevraagd is (calls). `count('/v1/breaches')` telt de aanvragen van één soort.
export function fakeXonFetch({
  email = () => jsonResponse(200, xonFound('Adobe')),
  list = () => jsonResponse(200, XON_LIST),
} = {}) {
  const fake = {
    calls: [],
    email,
    list,
    async impl(url, init) {
      fake.calls.push({ url, init });
      if (url.includes('/v1/check-email/')) return fake.email(url);
      if (url.includes('/v1/breaches')) return fake.list(url);
      throw new Error(`onverwachte aanvraag: ${url}`);
    },
  };
  fake.count = (part) => fake.calls.filter((call) => call.url.includes(part)).length;
  return fake;
}

// Een nepzoekdienst voor in de tests. Hij onthoudt de zoekopdrachten (calls) en geeft
// de resultaten in `results` terug (een lijst, of een functie die per opdracht een
// lijst geeft). Met `error` gooit hij die fout. Met `retainsResults: false` gedraagt hij zich als
// Brave: de resultaten mogen maar kort bewaard worden.
export function fakeSearch({
  results = [], error = null, isDemo = false, name = 'nep', retainsResults = true,
} = {}) {
  const fake = {
    name,
    isDemo,
    retainsResults,
    results,
    error,
    calls: [],
    async search(request) {
      fake.calls.push(request);
      if (fake.error) throw fake.error;
      return typeof fake.results === 'function' ? fake.results(request) : fake.results;
    },
  };
  return fake;
}

// Een nep-fetch voor Brave Search, voor de tests die de hele site (of de koppeling) met Brave laten
// werken zonder iets naar het internet te sturen. Hij onthoudt elke aanvraag (calls) en antwoordt met
// wat `answer(url, init)` teruggeeft.
export function fakeBraveFetch(answer) {
  const fake = {
    calls: [],
    answer,
    async impl(url, init) {
      fake.calls.push({ url: String(url), init });
      return fake.answer(url, init);
    },
  };
  return fake;
}

export const CLUB = {
  title: 'Uitslagen clubkampioenschappen',
  url: 'https://example.org/club/uitslagen',
  snippet: 'Anna de Vries werd tweede bij de clubkampioenschappen.',
};

export const GIDS = {
  title: 'Online telefoongids',
  url: 'https://example.net/gids/anna-de-vries',
  snippet: 'Anna de Vries, Utrecht. Telefoonnummer en adres.',
};

export const NAAMGENOOT = {
  title: 'Een andere Anna de Vries',
  url: 'https://example.com/profiel/anna-de-vries-2',
  snippet: 'Fotograaf in Groningen.',
};
