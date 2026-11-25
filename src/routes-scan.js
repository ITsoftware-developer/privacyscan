// De pagina's van fase 2: het dashboard, je e-mailadres bevestigen, je
// zoekgegevens, zoeken (in datalekken en op het web), de resultaten en het
// testpostvak voor op je eigen computer.
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { requireLogin } from './auth.js';
import { CONFIRM_MINUTES, confirmEmail, isConfirmationValid } from './confirm.js';
import {
  WEB_CHOICES, countFindings, lastScan, listFindings, setWebStatus,
} from './findings.js';
import { SqliteStore } from './limit-store.js';
import { hasOwnerAddress, isOwner } from './owner.js';
import { ScanError } from './scan-error.js';
import { scanBreaches, scanWeb } from './scans.js';
import { parseCity } from './search.js';
import { sourceById } from './sources.js';

const ONE_HOUR = 60 * 60 * 1000;
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

// Komt een verzoek van deze computer zelf?
export function isLoopback(address) {
  return LOOPBACK.has(address);
}

// Korte meldingen bovenaan het dashboard. Ze komen uit de adresbalk
// (/dashboard?verstuurd), maar we tonen alleen vaste teksten van onszelf.
const NOTICES = {
  verstuurd: 'We hebben een nieuwe bevestigingsmail gestuurd.',
  opgeslagen: 'Je woonplaats is opgeslagen.',
};

function noticeFrom(query) {
  const key = Object.keys(NOTICES).find((name) => query[name] !== undefined);
  return key ? NOTICES[key] : null;
}

// Wat de bezoeker te zien krijgt als een scan niet lukt: [HTTP-status, tekst]. De teksten
// over datalekken noemen de bron die het adres opzoekt (Have I Been Pwned of XposedOrNot).
function problemsFor(source) {
  return {
    no_key: [503, 'Voor dit e-mailadres is een HIBP-sleutel nodig. Zonder sleutel werken alleen testadressen, zoals account-exists@hibp-integration-tests.com. Zet de gratis controle aan (FREE_BREACH_CHECK=on) of zie de README.'],
    bad_key: [502, 'Have I Been Pwned accepteerde de sleutel niet. Controleer HIBP_API_KEY in je .env.'],
    rate_limited: source.id === 'xon'
      ? [429, 'De gratis dienst XposedOrNot staat maar 25 controles per uur en 100 per dag toe, en die zijn nu op. Probeer het later nog eens, of neem een HIBP-sleutel (zie de README).']
      : [429, `${source.name} vraagt om even te wachten. Probeer het over een minuutje opnieuw.`],
    busy: [429, 'Er lopen al veel controles tegelijk. Probeer het over een minuutje opnieuw.'],
    unavailable: [502, `${source.name} is nu niet bereikbaar. Probeer het later nog eens.`],
    unexpected: [502, `${source.name} gaf een onverwacht antwoord. Probeer het later nog eens.`],
    name_too_short: [400, 'Je naam bevat te weinig letters om op te zoeken.'],
    search_failed: [502, 'De zoekdienst gaf een fout. Probeer het later nog eens.'],
    search_disabled: [403, 'Zoeken op naam staat uit op een openbare site. Een bevestigd e-mailadres bewijst niet dat de naam van jou is.'],
  };
}

const TOO_OFTEN = 'Je hebt het afgelopen uur al een paar keer gezocht. Probeer het later opnieuw.';

// Pagina's met een token in de link horen niet in de cache van de browser.
function noStore(res) {
  res.set('Cache-Control', 'no-store');
}

// Zoeken mag pas als je e-mailadres bevestigd is: dan weten we dat er echt iemand
// achter dit adres zit.
function requireConfirmed(req, res, next) {
  if (req.user.email_confirmed_at) return next();
  res.status(403).render('fout', {
    title: 'Bevestig eerst je e-mailadres',
    message: 'Zolang je e-mailadres niet bevestigd is, zoeken we niets voor je op. Klik op de link in de bevestigingsmail, of vraag op je dashboard een nieuwe aan.',
  });
}

export function createScanRoutes({
  db, production, mailer, hibp, search, sendConfirmation, resendLimit, scanLimit, ownerEmail = null,
}) {
  const router = Router();

  // Welke bron zoekt de datalekken van dit account op? (Die van HIBP, of de gratis
  // XposedOrNot, als de site geen HIBP-sleutel heeft.)
  const sourceOf = (user) => sourceById(hibp.sourceFor?.(user.email));

  // Zoeken op naam mag niet voor iedereen op een openbare site: een bevestigd
  // e-mailadres bewijst niet dat de naam van jou is (zie scans.js). Alleen de
  // beheerder (OWNER_EMAIL) mag er dan wel op zoeken. Op je eigen computer mag
  // iedereen die erbij kan, want dat ben jij.
  const canSearchByName = (user) => !production || isOwner(user, ownerEmail);

  // Alleen wie op naam mag zoeken, heeft een woonplaats nodig. Voor alle anderen
  // bestaat die pagina niet: we bewaren niets wat we niet gebruiken.
  function requireNameSearch(req, res, next) {
    return canSearchByName(req.user) ? next() : next('route');
  }

  const limiter = ({ prefix, limit, handler }) => rateLimit({
    windowMs: ONE_HOUR,
    limit,
    standardHeaders: false,
    legacyHeaders: false,
    keyGenerator: (req) => String(req.user.id),
    store: new SqliteStore(db, prefix),
    handler,
  });

  const resendLimiter = limiter({
    prefix: 'resend-confirmation:',
    limit: resendLimit,
    handler: (req, res) => res.status(429).render('fout', {
      title: 'Even wachten',
      message: 'Je hebt al een paar keer een nieuwe mail laten sturen. Kijk ook in je spam, of probeer het over een uur opnieuw.',
    }),
  });

  const breachLimiter = limiter({
    prefix: 'scan-breach:',
    limit: scanLimit,
    handler: (req, res) => renderResults(req, res, { status: 429, error: TOO_OFTEN }),
  });

  const webLimiter = limiter({
    prefix: 'scan-web:',
    limit: scanLimit,
    handler: (req, res) => renderResults(req, res, { status: 429, error: TOO_OFTEN }),
  });

  // Toont de resultatenpagina, eventueel met een melding of een foutmelding.
  function renderResults(req, res, { status = 200, error = null, notice = null } = {}) {
    const { breaches, web } = listFindings(db, req.user.id);
    res.status(status).render('resultaten', {
      breaches,
      web,
      choices: WEB_CHOICES,
      breachScan: lastScan(db, req.user.id, 'breach'),
      webScan: lastScan(db, req.user.id, 'web'),
      searchIsDemo: Boolean(search.isDemo),
      checkSource: sourceOf(req.user),
      sourceById,
      error,
      notice,
      wide: true,
    });
  }

  function showProblem(req, res, error) {
    const problems = problemsFor(sourceOf(req.user));
    const [status, message] = problems[error.code] ?? problems.unexpected;
    renderResults(req, res, { status, error: message });
  }

  // De melding na een geslaagde scan, uit de gegevens van die scan.
  function scanNotice(user, query) {
    const userId = user.id;
    if (query.gescand === 'datalekken') {
      const scan = lastScan(db, userId, 'breach');
      if (!scan) return null;
      if (scan.found_count === 0) {
        return `Goed nieuws: ${sourceOf(user).name} kent dit e-mailadres niet uit een datalek. Dat is geen garantie, want niet elk lek is bekend.`;
      }
      const found = scan.found_count === 1 ? '1 datalek' : `${scan.found_count} datalekken`;
      return `Gecontroleerd: ${found} gevonden${scan.new_count > 0 ? `, waarvan ${scan.new_count} nieuw` : ''}.`;
    }
    if (query.gescand === 'web') {
      const scan = lastScan(db, userId, 'web');
      if (!scan) return null;
      if (scan.found_count === 0) return 'De zoekdienst vond niets bij deze zoekopdracht.';
      const found = scan.found_count === 1 ? '1 resultaat' : `${scan.found_count} resultaten`;
      return `Gezocht: ${found} gevonden${scan.new_count > 0 ? `, waarvan ${scan.new_count} nieuw` : ''}. Beoordeel ze hieronder.`;
    }
    return null;
  }

  // --- Dashboard -----------------------------------------------------------

  router.get('/dashboard', requireLogin, (req, res) => {
    const memberSince = new Date(req.user.created_at).toLocaleDateString('nl-NL', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });
    res.render('dashboard', {
      memberSince,
      confirmMinutes: CONFIRM_MINUTES,
      notice: noticeFrom(req.query),
      confirmed: Boolean(req.user.email_confirmed_at),
      canScanBreaches: hibp.hasKeyFor(req.user.email),
      checkSource: sourceOf(req.user),
      breachScan: lastScan(db, req.user.id, 'breach'),
      webScan: lastScan(db, req.user.id, 'web'),
      searchAllowed: canSearchByName(req.user),
      ownerMode: production && isOwner(req.user, ownerEmail),
      // De beheerder die nog niet bevestigd heeft, krijgt de uitnodiging om dat te doen
      // en niet te horen dat zoeken uit staat.
      ownerPending: production && !req.user.email_confirmed_at && hasOwnerAddress(req.user, ownerEmail),
      searchIsDemo: Boolean(search.isDemo),
      counts: countFindings(db, req.user.id),
      wide: true,
    });
  });

  // --- E-mailadres bevestigen ------------------------------------------------

  // De link in de mail brengt je eerst naar een pagina met een knop. Bewust twee
  // stappen: sommige mailprogramma's openen links automatisch om ze te controleren,
  // en dan zou een link die meteen bevestigt al gebruikt zijn voordat jij erop klikt.
  router.get('/e-mail-bevestigen', (req, res) => {
    noStore(res);
    const token = String(req.query.token ?? '');
    if (!isConfirmationValid(db, token)) {
      return res.status(400).render('bevestigen', { state: 'invalid', token: '' });
    }
    res.render('bevestigen', { state: 'form', token });
  });

  router.post('/e-mail-bevestigen', (req, res) => {
    noStore(res);
    if (!confirmEmail(db, String(req.body.token ?? ''))) {
      return res.status(400).render('bevestigen', { state: 'invalid', token: '' });
    }
    res.render('bevestigen', { state: 'done', token: '' });
  });

  router.post('/bevestiging-opnieuw', requireLogin, resendLimiter, async (req, res) => {
    if (req.user.email_confirmed_at) return res.redirect(303, '/dashboard');

    try {
      await sendConfirmation(req.user);
    } catch (error) {
      console.error(`Bevestigingsmail versturen mislukte: ${error.message}`);
      return res.status(502).render('fout', {
        title: 'Mail versturen mislukt',
        message: 'We konden de mail nu niet versturen. Probeer het later nog eens.',
      });
    }
    res.redirect(303, '/dashboard?verstuurd');
  });

  // --- Zoekgegevens ----------------------------------------------------------
  // Je naam en e-mailadres komen uit je account. Alleen de woonplaats vul je hier in.
  // Die is alleen nuttig als je op naam mag zoeken (zie requireNameSearch).

  router.get('/profiel', requireLogin, requireNameSearch, (req, res) => {
    res.render('profiel', { error: null, value: req.user.city ?? '' });
  });

  router.post('/profiel', requireLogin, requireNameSearch, (req, res) => {
    const { city, error } = parseCity(req.body.woonplaats);
    if (error) {
      return res.status(400).render('profiel', {
        error,
        value: String(req.body.woonplaats ?? '').trim().slice(0, 60),
      });
    }
    db.prepare('UPDATE users SET city = ? WHERE id = ?').run(city, req.user.id);
    res.redirect(303, '/dashboard?opgeslagen');
  });

  // --- Zoeken ----------------------------------------------------------------

  // Het formulier heeft geen invoervelden: er wordt altijd gezocht naar het
  // e-mailadres van het ingelogde account. Ook als iemand zelf een veld meestuurt,
  // lezen we dat nergens.
  router.post('/scan/datalekken', requireLogin, requireConfirmed, breachLimiter, async (req, res) => {
    try {
      await scanBreaches({ db, user: req.user, hibp });
    } catch (error) {
      if (error instanceof ScanError) return showProblem(req, res, error);
      throw error;
    }
    res.redirect(303, '/resultaten?gescand=datalekken');
  });

  // Ook hier geen invoer: de zoekopdracht wordt gemaakt van je naam en woonplaats.
  router.post('/scan/web', requireLogin, requireConfirmed, webLimiter, async (req, res) => {
    try {
      await scanWeb({ db, user: req.user, search, allowed: canSearchByName(req.user) });
    } catch (error) {
      if (error instanceof ScanError) return showProblem(req, res, error);
      throw error;
    }
    res.redirect(303, '/resultaten?gescand=web#web');
  });

  router.get('/resultaten', requireLogin, (req, res) => {
    renderResults(req, res, { notice: scanNotice(req.user, req.query) });
  });

  // Jouw keuze bij een webresultaat: Dit ben ik / Dit ben ik niet / Weet ik niet.
  // Alleen je eigen webresultaten kun je zo beoordelen.
  router.post('/resultaten/:id', requireLogin, (req, res) => {
    const status = String(req.body.status ?? '');
    if (!Object.hasOwn(WEB_CHOICES, status)) {
      return res.status(400).render('fout', {
        title: 'Onbekende keuze',
        message: 'Kies Dit ben ik, Dit ben ik niet of Weet ik niet.',
      });
    }
    const id = /^\d{1,15}$/.test(req.params.id) ? Number(req.params.id) : 0;
    if (!id || !setWebStatus(db, req.user.id, id, status)) {
      return res.status(404).render('fout', {
        title: 'Resultaat niet gevonden',
        message: 'Dit resultaat bestaat niet (meer).',
      });
    }
    res.redirect(303, `/resultaten#resultaat-${id}`);
  });

  // --- Testpostvak (alleen op je eigen computer) -------------------------------

  if (!production) {
    router.get('/dev/mails', (req, res, next) => {
      if (!isLoopback(req.socket.remoteAddress)) return next(); // dan krijg je de 404-pagina
      noStore(res);
      res.render('dev-mails', { mails: mailer.outbox, usesSmtp: mailer.usesSmtp, wide: true });
    });
  }

  return router;
}
