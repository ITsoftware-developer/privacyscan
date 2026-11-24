// Alles rond wachtwoorden en sessies.
import { hash, verify } from '@node-rs/argon2';
import { createHash, randomBytes } from 'node:crypto';

// ---------------------------------------------------------------------------
// Wachtwoorden
// ---------------------------------------------------------------------------

// Argon2id met de minimuminstellingen die OWASP aanraadt: 19 MiB geheugen,
// 2 rondes, 1 thread. Elke hash krijgt automatisch een eigen willekeurige salt.
const ARGON2_OPTIONS = { memoryCost: 19456, timeCost: 2, parallelism: 1 };

export function hashPassword(password) {
  return hash(password, ARGON2_OPTIONS);
}

export function verifyPassword(passwordHash, password) {
  return verify(passwordHash, password);
}

// Wordt gebruikt als iemand inlogt met een e-mailadres dat niet bestaat. We
// rekenen dan tóch een hash uit, zodat een aanvaller aan de reactietijd niet
// kan zien welke e-mailadressen een account hebben.
export const DUMMY_HASH = await hashPassword(randomBytes(32).toString('hex'));

// ---------------------------------------------------------------------------
// Sessies
// ---------------------------------------------------------------------------
// Na het inloggen krijgt de browser een willekeurig token in een cookie. In de
// database bewaren we alleen de SHA-256-hash daarvan: lekt de database ooit
// uit, dan kan niemand met die gegevens inloggen.

export const COOKIE_NAME = 'sessie';
const SESSION_DAYS = 7;

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

export function createSession(db, userId) {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;

  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now()); // oude sessies opruimen
  db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)')
    .run(hashToken(token), userId, expiresAt);

  return { token, expiresAt };
}

export function findSessionUser(db, token) {
  if (!token) return null;
  const user = db.prepare(`
    SELECT users.id, users.name, users.email, users.created_at
    FROM sessions JOIN users ON users.id = sessions.user_id
    WHERE sessions.id = ? AND sessions.expires_at > ?
  `).get(hashToken(token), Date.now());
  return user ?? null;
}

export function deleteSession(db, token) {
  if (token) db.prepare('DELETE FROM sessions WHERE id = ?').run(hashToken(token));
}

// ---------------------------------------------------------------------------
// Middleware (stukjes code die bij elk verzoek meedraaien)
// ---------------------------------------------------------------------------

// Zoekt bij elk verzoek de ingelogde gebruiker op (of null).
export function loadUser(db) {
  return (req, res, next) => {
    req.user = findSessionUser(db, req.cookies[COOKIE_NAME]);
    res.locals.user = req.user;
    next();
  };
}

// Stuurt je naar de inlogpagina als je niet bent ingelogd.
export function requireLogin(req, res, next) {
  if (!req.user) return res.redirect(303, '/inloggen');
  next();
}

// Bescherming tegen CSRF: een andere website mag geen formulier naar onze site
// sturen namens jou. Moderne browsers vertellen bij elk verzoek waar het
// vandaan komt; wij laten alleen verzoeken van onze eigen site door. (De
// SameSite-cookie is een tweede vangnet.)
export function checkOrigin(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (comesFromOurSite(req)) return next();

  res.status(403).render('fout', {
    title: 'Niet toegestaan',
    message: 'Dit formulier kwam niet van deze website en is daarom geweigerd.',
  });
}

function comesFromOurSite(req) {
  // 1. Sec-Fetch-Site: de duidelijkste aanwijzing. Browsers sturen hem mee via
  //    https en op je eigen computer (localhost).
  //    'same-origin' = van onze eigen pagina's, 'none' = door de gebruiker zelf
  //    gestart (bijvoorbeeld een bladwijzer). Al het andere komt van elders.
  const fetchSite = req.get('sec-fetch-site');
  if (fetchSite !== undefined) {
    return fetchSite === 'same-origin' || fetchSite === 'none';
  }

  // 2. Origin: sturen browsers mee bij elk formulier, ook via gewone http.
  const origin = req.get('origin');
  if (origin !== undefined) {
    try {
      return new URL(origin).host === req.get('host');
    } catch {
      return false; // "null" of iets onleesbaars: niet vertrouwen
    }
  }

  // 3. Geen van beide: dan is het geen moderne browser. Deze site heeft geen API
  //    voor andere programma's, dus weigeren we het voor de zekerheid.
  return false;
}
