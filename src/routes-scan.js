// De pagina's voor wie is ingelogd: het dashboard, je e-mailadres bevestigen, zoeken (in
// datalekken, op het web, of alles tegelijk met de Deep Scan), de resultaten en het testpostvak
// voor op je eigen computer. Je zoekgegevens (telefoonnummer, woonplaats) staan in routes-profile.js.
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { requireConfirmed, requireLogin } from './auth.js';
import { CHECKED as BROKERS_CHECKED } from './brokers/registry.js';
import { CONFIRM_MINUTES, confirmEmail, isConfirmationValid } from './confirm.js';
import {
  WEB_CHOICES, countFindings, lastRun, lastScan, listFindings, setWebStatus,
} from './findings.js';
import { logEvent } from './events.js';
import { SqliteStore } from './limit-store.js';
import { activeJob, enqueueJob, latestJob } from './jobs/queue.js';
import { createMonitor } from './monitor.js';
import { canSearchByName as mayUseName, hasOwnerAddress, isOwner } from './owner.js';
import { brokerOverview } from './research/broker-scan.js';
import { ScanError } from './scan-error.js';
import { plannedSteps } from './scanner.js';
import { scanBreaches, scanWeb } from './scans.js';
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
    no_search: [503, 'Er is geen zoekdienst ingesteld, dus we kunnen niet op het web zoeken. Zet BRAVE_API_KEY in je .env (zie de README). Staat hij er al in? Start de site dan opnieuw: hij leest .env alleen bij het starten.'],
    paused: [503, `${source.name} is tijdelijk uitgezet door de beheerder. Probeer het later nog eens.`],
    search_paused: [503, 'Zoeken op het web is tijdelijk uitgezet door de beheerder. Probeer het later nog eens.'],
    search_budget: [429, 'De site heeft het maximum aantal zoekopdrachten voor vandaag of deze maand bereikt (een grens tegen hoge kosten). Probeer het later opnieuw.'],
    search_budget_scan: [429, 'De grens van het aantal zoekopdrachten voor één onderzoek is bereikt.'],
    search_failed: [502, 'De zoekdienst gaf een fout. Probeer het later nog eens.'],
    search_bad_key: [502, 'De zoekdienst accepteerde de sleutel niet. Controleer BRAVE_API_KEY in je .env.'],
    search_rate_limited: [429, 'De zoekdienst staat nu geen aanvragen meer toe: de limiet of het tegoed is op. Probeer het later nog eens.'],
    search_unavailable: [502, 'De zoekdienst is nu niet bereikbaar. Probeer het later nog eens.'],
    search_unexpected: [502, 'De zoekdienst gaf een onverwacht antwoord. Probeer het later nog eens.'],
    search_disabled: [403, 'Zoeken op naam staat uit op een openbare site. Een bevestigd e-mailadres bewijst niet dat de naam van jou is.'],
  };
}

const TOO_OFTEN = 'Je hebt het afgelopen uur al een paar keer gezocht. Probeer het later opnieuw.';

// Pagina's met een token in de link horen niet in de cache van de browser.
export function noStore(res) {
  res.set('Cache-Control', 'no-store');
}

export function createScanRoutes({
  db, production, mailer, hibp, search, sendConfirmation, resendLimit, scanLimit, ownerEmail = null,
  monitor = createMonitor(db),
  jobs = null,              // de werker van de onderzoekswachtrij (zie jobs/worker.js)
  runJobsInline = false,    // de tests: een onderzoek meteen uitvoeren in plaats van op de achtergrond
}) {
  const router = Router();

  // Voert een onderzoek uit en zet de uitkomst in het systeemlog: alleen de soort, de aantallen, de
  // duur of de foutcode, nooit wie het was of wat er gevonden is. Op de beheerpagina zie je zo ook
  // wat er op dit moment loopt (monitor.track).
  async function tracked(scan, work) {
    const started = Date.now();
    try {
      const result = await monitor.track(scan, work);
      logEvent(db, 'scan_done', { scan, found: result.found, added: result.added, ms: Date.now() - started });
      return result;
    } catch (error) {
      if (error instanceof ScanError) logEvent(db, 'scan_failed', { scan, code: error.code });
      throw error;
    }
  }

  // Welke bron zoekt de datalekken van dit account op? (Die van HIBP, of de gratis
  // XposedOrNot, als de site geen HIBP-sleutel heeft.)
  const sourceOf = (user) => sourceById(hibp.sourceFor?.(user.email));

  // Zoeken op naam mag niet voor iedereen op een openbare site: een bevestigd
  // e-mailadres bewijst niet dat de naam van jou is (zie scans.js). Alleen de
  // beheerder (OWNER_EMAIL) mag er dan wel op zoeken. Op je eigen computer mag
  // iedereen die erbij kan, want dat ben jij.
  const canSearchByName = (user) => mayUseName(user, { production, ownerEmail });

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

  const tooOften = (req, res) => {
    logEvent(db, 'limit_reached', { what: 'scan' });
    renderResults(req, res, { status: 429, error: TOO_OFTEN });
  };

  const breachLimiter = limiter({ prefix: 'scan-breach:', limit: scanLimit, handler: tooOften });
  const webLimiter = limiter({ prefix: 'scan-web:', limit: scanLimit, handler: tooOften });

  // Toont de resultatenpagina, eventueel met een melding of een foutmelding.
  function renderResults(req, res, { status = 200, error = null, notice = null } = {}) {
    const { breaches, web } = listFindings(db, req.user.id);
    // Loopt er een Deep Scan op de achtergrond, dan ververst de pagina zichzelf tot hij klaar is.
    const job = activeJob(db, req.user.id);
    const last = job ? null : latestJob(db, req.user.id);
    res.status(status).render('resultaten', {
      job,
      failedJob: last?.status === 'failed' ? last : null,
      refreshSeconds: job ? 3 : null,
      breaches,
      web,
      choices: WEB_CHOICES,
      breachScan: lastScan(db, req.user.id, 'breach'),
      webScan: lastScan(db, req.user.id, 'web'),
      run: lastRun(db, req.user.id),
      checkSource: sourceOf(req.user),
      sourceById,
      // De Data Broker Engine: per databroker uit het register wat we weten (zie research/broker-scan.js).
      brokers: brokerOverview(db, req.user.id),
      brokersChecked: BROKERS_CHECKED,
      searchAllowed: canSearchByName(req.user),
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
    if (query.gescand === 'deep') {
      if (activeJob(db, userId)) {
        return 'Je Deep Scan loopt op de achtergrond. Je mag deze pagina sluiten: het rapport komt hier, en op je dashboard zie je hoe ver hij is.';
      }
      const run = lastRun(db, userId);
      if (!run) return null;
      const done = run.steps.filter((step) => step.status === 'done').length;
      return `Deep Scan klaar: ${done} van ${run.steps.length} stappen voltooid. Bij elke stap staat wat er gedaan is, en waarom iets niet kon.`;
    }
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
      const found = scan.found_count === 1 ? '1 mogelijke vermelding' : `${scan.found_count} mogelijke vermeldingen`;
      return `Gezocht: ${found} gevonden${scan.new_count > 0 ? `, waarvan ${scan.new_count} nieuw` : ''}. Beoordeel ze hieronder: het zegt niet dat ze over jou gaan.`;
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
      run: lastRun(db, req.user.id),
      job: activeJob(db, req.user.id),
      searchAllowed: canSearchByName(req.user),
      ownerMode: production && isOwner(req.user, ownerEmail),
      // De beheerder die nog niet bevestigd heeft, krijgt de uitnodiging om dat te doen
      // en niet te horen dat zoeken uit staat.
      ownerPending: production && !req.user.email_confirmed_at && hasOwnerAddress(req.user, ownerEmail),
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

  // --- Zoeken ----------------------------------------------------------------

  // De Deep Scan: alle stappen achter elkaar, op de gegevens van dit account. Net als de
  // losse scans heeft hij geen invoer. Een stap die niet lukt, komt als stap in het rapport;
  // hij stopt de rest niet. Hij vraagt één keer aan de bron van datalekken en één keer aan de
  // zoekdienst, dus hij telt voor allebei mee in de limieten: zo kun je de aanvragen die de
  // bronnen ons toestaan niet verdubbelen door de Deep Scan naast de losse knoppen te gebruiken.
  //
  // De Deep Scan loopt op de achtergrond (zie jobs/ en research/orchestrator.js): de knop zet hem in de
  // wachtrij, en de resultatenpagina laat zien hoe ver hij is. Staat er al een in de wachtrij, dan
  // telt de knop niet nog een keer mee in de limieten.
  const alreadyQueued = (req, res, next) => (activeJob(db, req.user.id)
    ? res.redirect(303, '/resultaten?gescand=deep#rapport')
    : next());

  router.post('/scan/deep', requireLogin, requireConfirmed, alreadyQueued, breachLimiter, webLimiter, async (req, res) => {
    enqueueJob(db, { userId: req.user.id, kind: 'deep', steps: plannedSteps() });
    if (runJobsInline && jobs) await jobs.drain();
    res.redirect(303, '/resultaten?gescand=deep#rapport');
  });

  // Het formulier heeft geen invoervelden: er wordt altijd gezocht naar het
  // e-mailadres van het ingelogde account. Ook als iemand zelf een veld meestuurt,
  // lezen we dat nergens.
  router.post('/scan/datalekken', requireLogin, requireConfirmed, breachLimiter, async (req, res) => {
    try {
      await tracked('breach', () => scanBreaches({ db, user: req.user, hibp }));
    } catch (error) {
      if (error instanceof ScanError) return showProblem(req, res, error);
      throw error;
    }
    res.redirect(303, '/resultaten?gescand=datalekken');
  });

  // Ook hier geen invoer: de zoekopdracht wordt gemaakt van je naam en woonplaats.
  router.post('/scan/web', requireLogin, requireConfirmed, webLimiter, async (req, res) => {
    try {
      await tracked('web', () => scanWeb({ db, user: req.user, search, allowed: canSearchByName(req.user) }));
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
