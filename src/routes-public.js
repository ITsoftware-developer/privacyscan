// De openbare pagina's: de startpagina en de e-mailcontrole, zoals Have I Been Pwned
// die zelf ook heeft. Iedereen mag hier een e-mailadres intypen, ook zonder account.
//
// Dat kan veilig omdat het antwoord klein blijft:
//   - We tonen alleen de NAAM van elk datalek, de datum en welke SOORTEN gegevens er
//     gelekt zijn. Nooit de gegevens zelf (geen wachtwoorden, adressen of namen).
//   - Gevoelige lekken, zoals die van datingsites, tonen we nooit.
//   - Het adres dat iemand intypt, bewaren we nergens: niet in de database, niet in een
//     logboek, niet in de URL en niet in de cache van de browser.
//
// Wat hier juist NIET bestaat, is een zoekvak om iemand op naam op het web te zoeken.
// Dat blijft beperkt tot je eigen account (zie routes-scan.js).
//
// Verder staat hier de pagina /bronnen: het bronnenregister en de roadmap. Die bevat geen
// persoonsgegevens en laat eerlijk zien wat er werkt en wat nog niet bestaat.
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { isValidEmail, normalizeEmail } from './email.js';
import { publicPlan, publicRun, withEvidence } from './engine.js';
import { breachLink } from './findings.js';
import { SqliteStore } from './limit-store.js';
import { ScanError } from './scan-error.js';
import { PHASES, describeRegister, sourceById } from './sources.js';

const ONE_HOUR = 60 * 60 * 1000;
const MAX_EMAIL = 254;

// Wat de bezoeker te zien krijgt als de controle niet lukt: [HTTP-status, tekst]. De
// teksten noemen de bron die het adres opzoekt (Have I Been Pwned of XposedOrNot).
// Anders dan op het dashboard staat hier niets over instellingen: een bezoeker kan
// daar niets mee, en technische details gaan nooit naar buiten.
function problemsFor(source) {
  return {
    no_key: [503, 'Deze site kan nu alleen testadressen controleren, zoals account-exists@hibp-integration-tests.com. Voor andere adressen moet de beheerder eerst een sleutel van Have I Been Pwned instellen.'],
    bad_key: [502, 'De controle is nu niet beschikbaar. Probeer het later nog eens.'],
    rate_limited: source.id === 'xon'
      ? [429, 'De gratis dienst achter deze controle staat maar een beperkt aantal controles per uur toe, en die zijn nu op. Probeer het later nog eens.']
      : [429, `${source.name} vraagt om even te wachten. Probeer het over een minuutje opnieuw.`],
    busy: [429, 'Er lopen al veel controles tegelijk. Probeer het over een minuutje opnieuw.'],
    unavailable: [502, `${source.name} is nu niet bereikbaar. Probeer het later nog eens.`],
    unexpected: [502, `${source.name} gaf een onverwacht antwoord. Probeer het later nog eens.`],
  };
}

// Dit hoort de beheerder te weten. Het staat alleen in de terminal, nooit op de pagina,
// en er staat nooit een e-mailadres bij.
function forTheOwner(code, source) {
  if (code === 'bad_key') return 'Have I Been Pwned accepteerde de sleutel niet. Controleer HIBP_API_KEY in je .env.';
  if (code === 'unexpected') return `${source.name} gaf een onverwacht antwoord.`;
  return null;
}

const TOO_OFTEN = 'Je hebt het afgelopen uur al een paar keer gecontroleerd. Probeer het later opnieuw.';

const newestFirst = (a, b) => String(b.breachDate ?? '').localeCompare(String(a.breachDate ?? ''));

export function createPublicRoutes({ db, hibp, search = null, checkLimit }) {
  const router = Router();

  // Naar welke bron(nen) gaan de adressen van bezoekers? Dat staat op de pagina.
  const emailSources = (hibp.emailSources ?? ['hibp']).map(sourceById);

  // Toont de pagina met het formulier, eventueel met een foutmelding of het resultaat.
  // `noStore`: pagina's met een adres erin horen niet in de cache van de browser.
  function page(res, { status = 200, noStore = false, email = '', ...values } = {}) {
    if (noStore) res.set('Cache-Control', 'no-store');
    const testMode = !hibp.hasKey; // zonder sleutel (of gratis dienst) werken alleen de testadressen van HIBP
    const result = values.result ?? null;
    res.status(status).render('controle', {
      email: email.slice(0, MAX_EMAIL),
      error: null,
      result: null,
      testMode,
      // De stappen van de Research Engine. Na een controle komt alles uit het resultaat dat de
      // bezoeker nu ziet (en dat niet bewaard wordt); anders staat er wat er te doen is.
      steps: result ? publicRun({ breaches: result.breaches, source: result.source }) : publicPlan({ testMode }),
      emailSources,
      wide: true,
      ...values,
    });
  }

  // Per IP-adres, zodat één bezoeker de aanvragen die HIBP ons toestaat niet kan opmaken.
  // Een typfout of een storing bij HIBP telt niet mee. De teller bevat alleen een hash van
  // het IP-adres, nooit het adres dat iemand controleert.
  const checkLimiter = rateLimit({
    windowMs: ONE_HOUR,
    limit: checkLimit,
    skipFailedRequests: true,
    standardHeaders: false,
    legacyHeaders: false,
    store: new SqliteStore(db, 'check-ip:'),
    handler: (req, res) => page(res, {
      status: 429,
      noStore: true,
      email: normalizeEmail(req.body?.email),
      error: TOO_OFTEN,
    }),
  });

  // De startpagina is de controle zelf. Wie is ingelogd, gaat naar zijn dashboard.
  router.get('/', (req, res) => {
    if (req.user) return res.redirect(303, '/dashboard');
    page(res);
  });

  // Het bronnenregister en de roadmap: wat werkt, wat staat uit en wat bestaat nog niet.
  router.get('/bronnen', (req, res) => {
    res.render('bronnen', {
      register: describeRegister({
        emailSources: hibp.emailSources ?? ['hibp'],
        hasKey: Boolean(hibp.hasKey),
        search,
      }),
      phases: PHASES,
      wide: true,
    });
  });

  // Een adres in de URL (?email=...) lezen we bewust nergens: adressen horen niet in
  // de adresbalk, in de geschiedenis van de browser of in het logboek van een server.
  router.get('/controle', (req, res) => {
    page(res);
  });

  router.post('/controle', checkLimiter, async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    const show = (values) => page(res, { noStore: true, email, ...values });

    if (!isValidEmail(email)) return show({ status: 400, error: 'Vul een geldig e-mailadres in.' });

    // Welke bron zoekt dit adres op? Dat bepaalt ook wat we bij een fout zeggen.
    const source = sourceById(hibp.sourceFor?.(email));
    const problem = (code) => {
      const problems = problemsFor(source);
      const [status, error] = problems[code] ?? problems.unexpected;
      return show({ status, error });
    };

    if (!hibp.hasKeyFor(email)) return problem('no_key');

    let breaches;
    try {
      breaches = await hibp.breachesFor(email);
    } catch (error) {
      if (!(error instanceof ScanError)) throw error;
      const note = forTheOwner(error.code, source);
      if (note) console.error(note);
      return problem(error.code);
    }

    const visible = withEvidence(
      breaches
        .filter((breach) => !breach.isSensitive)
        .sort(newestFirst)
        .map((breach) => ({ ...breach, url: breachLink(breach) })),
      { source },
    );
    show({ result: { breaches: visible, source } });
  });

  return router;
}
