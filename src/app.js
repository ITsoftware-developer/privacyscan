// Bouwt de webapp op. Dit staat los van server.js, zodat de tests de app
// ook kunnen starten (met een lege database in het geheugen).
import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { join } from 'node:path';
import { checkOrigin, loadUser } from './auth.js';
import { CONFIRM_MINUTES, sendConfirmationMail } from './confirm.js';
import { DEFAULT_LIMITS, budgetedSearch } from './budget.js';
import { pausableBreachCheck, pausableSearch } from './controls.js';
import { JOB_ERRORS, logEvent } from './events.js';
import { createHibp } from './hibp.js';
import { viaText } from './findings.js';
import { createWorker } from './jobs/worker.js';
import { createMailer } from './mail.js';
import { confidenceLabel, decisionLabel } from './confidence.js';
import { dataClassLabel } from './data-classes.js';
import { describeStep } from './engine.js';
import { describeWebResult } from './extract.js';
import { createMonitor } from './monitor.js';
import { isOwner, parseOwnerEmail } from './owner.js';
import { isPwned } from './pwned.js';
import { WEB_RESULT_MINUTES } from './retention.js';
import { createRoutes } from './routes.js';
import { createAdminRoutes } from './routes-admin.js';
import { createPublicRoutes } from './routes-public.js';
import { createProfileRoutes } from './routes-profile.js';
import { createScanRoutes } from './routes-scan.js';
import { createResearchHandlers } from './research/orchestrator.js';
import { formatPhone } from './phone.js';
import { CODE_MINUTES } from './phone-codes.js';
import { createSmsSender } from './sms.js';
import { PHASES, evidenceSource, sourceById, sourceHost } from './sources.js';

const ROOT = join(import.meta.dirname, '..');

export function createApp({
  db,
  production = false,
  pwnedCheck = isPwned, // de tests vervangen deze, zodat ze ook offline werken
  loginLimit = 10,      // mislukte inlogpogingen per kwartier per IP-adres
  accountLimit = 5,     // mislukte inlogpogingen per kwartier per account
  registerLimit = 10,   // aanmeldingen per uur per IP-adres
  resendLimit = 3,      // nieuwe bevestigingsmails per uur per account
  scanLimit = 5,        // zoekopdrachten per uur per account (datalekken en web apart; de Deep Scan telt voor allebei)
  checkLimit = 10,      // controles van een e-mailadres per uur per IP-adres (de openbare pagina)
  hibp = createHibp(),  // de bron van datalekken: Have I Been Pwned (zie server.js voor de gratis XposedOrNot); de tests vervangen deze door een nepversie
  search = null,        // zoekdienst voor je naam (zie search.js); zonder zoekdienst zoekt de app niet op het web en verzint hij niets
  mailer = createMailer(),            // zonder SMTP-instelling: een testpostvak in het geheugen
  baseUrl = 'http://localhost:3000',  // voor de links in mails; komt nooit uit het verzoek zelf
  contact = {},         // naam en e-mailadres voor de privacyverklaring
  ownerEmail = null,    // de beheerder: mag op een openbare site als enige op naam zoeken, en komt op /beheerder
  testLimit = 20,       // testknoppen op de beheerpagina per uur (elke test is een echte aanvraag)
  monitor = null,       // telt de aanvragen naar de externe diensten (zie monitor.js en server.js)
  runJobsInline = false, // de tests: een onderzoek meteen uitvoeren; anders loopt het op de achtergrond (app.jobs.start() in server.js)
  budget = DEFAULT_LIMITS, // kostenlimieten voor de zoekdienst: per dag, per maand en per onderzoek (zie budget.js)
  sms = createSmsSender({ production }), // verstuurt de code om je telefoonnummer te bevestigen (zie sms.js)
  phoneCodeLimit = 3,   // sms-codes per uur, per account en per telefoonnummer
}) {
  const owner = parseOwnerEmail(ownerEmail);
  const meter = monitor ?? createMonitor(db);
  // Wat de rest van de site gebruikt: de zoekdienst en de controle op datalekken met de pauzeknop van
  // de beheerpagina ervoor (zie controls.js). De beheerpagina zelf krijgt de originelen, voor de testknoppen.
  const guardedSearch = pausableSearch(budgetedSearch(search, db, budget), db);
  const guardedCheck = pausableBreachCheck(hibp, db);
  // De onderzoekswachtrij: de werker voert een Deep Scan uit op de achtergrond (zie jobs/).
  const jobs = createWorker({
    db,
    handlers: createResearchHandlers({
      db, check: guardedCheck, search: guardedSearch, monitor: meter, production, ownerEmail: owner, perScan: budget.perScan,
    }),
  });
  const app = express();
  app.jobs = jobs;
  app.set('view engine', 'ejs');
  app.set('views', join(ROOT, 'views'));
  app.locals.appName = 'Privacyscan';
  app.locals.contact = { name: contact.name || null, email: contact.email || null };
  // Op je eigen computer zonder echte mailserver wijzen we naar het testpostvak.
  app.locals.devMail = !production && !mailer.usesSmtp;
  // Voor de privacyverklaring: wat er echt gebeurt, volgt uit de instellingen.
  app.locals.confirmMinutes = CONFIRM_MINUTES;
  app.locals.searchPolicy = {
    allowed: !production,                  // iedereen mag op naam zoeken (op je eigen computer)
    ownerOnly: production && owner !== null, // op een openbare site alleen de beheerder
    configured: search !== null,           // is er een zoekdienst ingesteld?
    isDemo: Boolean(search?.isDemo),
    name: search?.label ?? search?.name ?? 'de zoekdienst',
    // Mogen we de resultaten bewaren? Zo niet, dan blijven ze maar even staan (zie retention.js).
    retains: search?.retainsResults === true,
    keepMinutes: WEB_RESULT_MINUTES,
  };
  // Datums netjes in het Nederlands, voor in de pagina's.
  app.locals.formatDateTime = (ms) => new Date(ms).toLocaleString('nl-NL', { dateStyle: 'long', timeStyle: 'short' });
  app.locals.formatDay = (day) => new Date(`${day}T00:00:00Z`)
    .toLocaleDateString('nl-NL', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  app.locals.dataClassLabel = dataClassLabel;
  app.locals.formatPhone = formatPhone;
  // Kan de site een code per sms sturen? (Zie sms.js: op een openbare site nog niet.)
  app.locals.smsAvailable = sms.available;
  app.locals.codeMinutes = CODE_MINUTES;
  // Voor het rapport van de Deep Scan en het bewijs bij elke bevinding.
  app.locals.describeStep = describeStep;
  app.locals.jobErrorText = (code) => JOB_ERRORS[code] ?? JOB_ERRORS.unexpected;
  app.locals.confidenceLabel = confidenceLabel;
  app.locals.decisionLabel = decisionLabel;
  app.locals.describeWebResult = describeWebResult;
  app.locals.viaText = viaText;
  app.locals.evidenceSource = evidenceSource;
  app.locals.phases = PHASES;
  // Voor de privacyverklaring: naar welke dienst gaan de e-mailadressen? (Have I Been Pwned,
  // of de gratis XposedOrNot als de site geen HIBP-sleutel heeft.)
  app.locals.breachSources = (hibp.emailSources ?? ['hibp']).map(sourceById);
  app.locals.sourceHost = sourceHost;

  // Veilige standaardinstellingen voor allerlei HTTP-headers.
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        // Op je eigen computer draait de site via http. Daar moet de browser
        // niet proberen alles naar https om te zetten.
        upgradeInsecureRequests: production ? [] : null,
      },
    },
    // Geen adressen van deze site doorgeven aan andere sites. ("same-origin"
    // en niet "no-referrer", want dan stuurt de browser ook geen Origin-header
    // meer mee bij je eigen formulieren, en die hebben we nodig in checkOrigin.)
    referrerPolicy: { policy: 'same-origin' },
  }));

  app.use(express.static(join(ROOT, 'public')));
  app.use(express.urlencoded({ extended: false, limit: '10kb' }));
  app.use(cookieParser());
  app.use(checkOrigin);
  app.use(loadUser(db));
  // Alleen de beheerder ziet de link naar de beheerpagina (de pagina zelf controleert het opnieuw).
  app.use((req, res, next) => {
    res.locals.isAdmin = isOwner(req.user, owner);
    next();
  });
  const sendConfirmation = (user) => sendConfirmationMail({ db, mailer, baseUrl, user });
  app.use(createPublicRoutes({
    db, hibp: guardedCheck, search: guardedSearch, checkLimit, monitor: meter,
  }));
  app.use(createRoutes({
    db, production, pwnedCheck, loginLimit, accountLimit, registerLimit, sendConfirmation, ownerEmail: owner,
  }));
  app.use(createScanRoutes({
    db, production, mailer, hibp: guardedCheck, search: guardedSearch, sendConfirmation, resendLimit, scanLimit,
    ownerEmail: owner, monitor: meter, jobs, runJobsInline,
  }));
  app.use(createProfileRoutes({
    db, production, ownerEmail: owner, sms, phoneCodeLimit,
  }));
  app.use('/beheerder', createAdminRoutes({
    db,
    production,
    ownerEmail: owner,
    monitor: meter,
    search,
    check: hibp,
    mailer,
    budget,
    limits: {
      loginLimit, accountLimit, registerLimit, resendLimit, scanLimit, checkLimit, testLimit,
    },
  }));

  // Onbekende pagina
  app.use((req, res) => {
    res.status(404).render('fout', {
      title: 'Pagina niet gevonden',
      message: 'Deze pagina bestaat niet (meer).',
    });
  });

  // Onverwachte fout: de details komen alleen in je terminal, niet bij de bezoeker.
  app.use((error, req, res, next) => {
    console.error(error);
    logEvent(db, 'unexpected_error', { error: error?.name });
    const status = error.status >= 400 && error.status < 600 ? error.status : 500;
    res.status(status).render('fout', {
      title: 'Er ging iets mis',
      message: 'Probeer het later nog eens.',
    });
  });

  return app;
}
