// Alle pagina's van de site: registreren, inloggen, uitloggen en het dashboard.
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import {
  COOKIE_NAME,
  DUMMY_HASH,
  createSession,
  deleteSession,
  hashPassword,
  requireLogin,
  verifyPassword,
} from './auth.js';
import { SqliteStore } from './limit-store.js';

const FIFTEEN_MINUTES = 15 * 60 * 1000;
const ONE_HOUR = 60 * 60 * 1000;
const MIN_PASSWORD = 12;
const MAX_PASSWORD = 128;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMAIL_TAKEN = 'Er bestaat al een account met dit e-mailadres. Wil je inloggen?';

// Haalt de velden uit een verstuurd formulier en maakt ze netjes.
function readForm(body = {}) {
  return {
    name: String(body.naam ?? '').trim(),
    email: String(body.email ?? '').trim().toLowerCase(),
    password: String(body.wachtwoord ?? ''),
    password2: String(body.wachtwoord2 ?? ''),
  };
}

// Geeft een foutmelding terug, of null als alles klopt.
function checkRegistration({ name, email, password, password2 }) {
  if (!name || name.length > 80) return 'Vul je naam in (maximaal 80 tekens).';
  if (!EMAIL_PATTERN.test(email) || email.length > 254) return 'Vul een geldig e-mailadres in.';
  if (password.length < MIN_PASSWORD) return `Kies een wachtwoord van minimaal ${MIN_PASSWORD} tekens.`;
  if (password.length > MAX_PASSWORD) return `Je wachtwoord mag maximaal ${MAX_PASSWORD} tekens zijn.`;
  if (password !== password2) return 'De twee wachtwoorden zijn niet hetzelfde.';
  return null;
}

export function createRoutes({ db, production, pwnedCheck, loginLimit, accountLimit, registerLimit }) {
  const router = Router();

  // Maakt een sessie aan en zet het token in een cookie.
  function startSession(res, userId) {
    const { token, expiresAt } = createSession(db, userId);
    res.cookie(COOKIE_NAME, token, {
      httpOnly: true,     // JavaScript in de browser kan er niet bij
      sameSite: 'lax',    // andere sites kunnen er geen formulieren mee versturen
      secure: production, // online alleen via https
      path: '/',
      expires: new Date(expiresAt),
    });
  }

  // Tegen wachtwoorden raden. Twee limieten, allebei per kwartier:
  // - per IP-adres: tegen één aanvaller die veel accounts probeert;
  // - per account: tegen een aanvaller met veel IP-adressen die één account probeert.
  // Alleen mislukte pogingen tellen mee, en de tellers staan in de database.
  //
  // Let op de afweging: iemand die jouw e-mailadres kent, kan je account zo
  // ook een kwartier op slot zetten. Daarom duurt de pauze niet langer.
  const tooManyAttempts = (req, res) => res.status(429).render('inloggen', {
    error: 'Te veel mislukte pogingen. Probeer het over een kwartier opnieuw.',
    notice: null,
    values: { email: readForm(req.body).email },
  });

  const loginIpLimiter = rateLimit({
    windowMs: FIFTEEN_MINUTES,
    limit: loginLimit,
    skipSuccessfulRequests: true,
    standardHeaders: false,
    legacyHeaders: false,
    store: new SqliteStore(db, 'login-ip:'),
    handler: tooManyAttempts,
  });

  const loginAccountLimiter = rateLimit({
    windowMs: FIFTEEN_MINUTES,
    limit: accountLimit,
    skipSuccessfulRequests: true,
    standardHeaders: false,
    legacyHeaders: false,
    keyGenerator: (req) => readForm(req.body).email, // tel per ingevuld e-mailadres
    store: new SqliteStore(db, 'login-account:'),
    handler: tooManyAttempts,
  });

  const registerLimiter = rateLimit({
    windowMs: ONE_HOUR,
    limit: registerLimit,
    standardHeaders: false,
    legacyHeaders: false,
    store: new SqliteStore(db, 'register-ip:'),
    handler: (req, res) => {
      const form = readForm(req.body);
      res.status(429).render('registreren', {
        error: 'Te veel aanmeldingen vanaf dit adres. Probeer het over een uur opnieuw.',
        values: { naam: form.name, email: form.email },
      });
    },
  });

  router.get('/', (req, res) => {
    res.redirect(303, req.user ? '/dashboard' : '/inloggen');
  });

  // --- Registreren ---------------------------------------------------------

  router.get('/registreren', (req, res) => {
    if (req.user) return res.redirect(303, '/dashboard');
    res.render('registreren', { error: null, values: {} });
  });

  router.post('/registreren', registerLimiter, async (req, res) => {
    const form = readForm(req.body);
    const fail = (error) => res.status(400).render('registreren', {
      error,
      values: { naam: form.name, email: form.email }, // het wachtwoord sturen we nooit terug
    });

    const problem = checkRegistration(form);
    if (problem) return fail(problem);

    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(form.email)) {
      return fail(EMAIL_TAKEN);
    }
    if (await pwnedCheck(form.password)) {
      return fail('Dit wachtwoord komt voor in bekende datalekken. Kies een ander wachtwoord.');
    }

    const passwordHash = await hashPassword(form.password);
    let userId;
    try {
      ({ lastInsertRowid: userId } = db
        .prepare('INSERT INTO users (name, email, password_hash, created_at) VALUES (?, ?, ?, ?)')
        .run(form.name, form.email, passwordHash, Date.now()));
    } catch (error) {
      // Twee aanmeldingen met hetzelfde adres tegelijk: de database houdt de tweede tegen.
      if (/UNIQUE/.test(error.message)) return fail(EMAIL_TAKEN);
      throw error;
    }

    startSession(res, Number(userId));
    res.redirect(303, '/dashboard');
  });

  // --- Inloggen en uitloggen -------------------------------------------------

  router.get('/inloggen', (req, res) => {
    if (req.user) return res.redirect(303, '/dashboard');
    const notice = req.query.uitgelogd !== undefined ? 'Je bent uitgelogd.' : null;
    res.render('inloggen', { error: null, notice, values: {} });
  });

  router.post('/inloggen', loginIpLimiter, loginAccountLimiter, async (req, res) => {
    const { email, password } = readForm(req.body);
    const user = db.prepare('SELECT id, password_hash FROM users WHERE email = ?').get(email);
    const passwordOk = await verifyPassword(user?.password_hash ?? DUMMY_HASH, password);

    if (!user || !passwordOk) {
      // Bewust één melding voor allebei: zo verraden we niet welke e-mailadressen een account hebben.
      return res.status(401).render('inloggen', {
        error: 'Dit e-mailadres en wachtwoord passen niet bij elkaar.',
        notice: null,
        values: { email },
      });
    }

    startSession(res, user.id);
    await loginAccountLimiter.resetKey(email); // gelukt: de telling voor dit account weer op nul
    res.redirect(303, '/dashboard');
  });

  router.post('/uitloggen', (req, res) => {
    deleteSession(db, req.cookies[COOKIE_NAME]);
    res.clearCookie(COOKIE_NAME, { path: '/' });
    res.redirect(303, '/inloggen?uitgelogd');
  });

  // --- Dashboard -----------------------------------------------------------

  router.get('/dashboard', requireLogin, (req, res) => {
    const memberSince = new Date(req.user.created_at).toLocaleDateString('nl-NL', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });
    res.render('dashboard', { memberSince, wide: true });
  });

  return router;
}
