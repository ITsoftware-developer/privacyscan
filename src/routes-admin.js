// De beheerpagina (/beheerder): het technische controlecentrum van de site.
//
// Alleen voor de beheerder: het account met precies het adres uit OWNER_EMAIL, en alleen als dat
// adres bevestigd is (zie owner.js). De server controleert dat bij elk verzoek; een verborgen link
// is geen beveiliging. Wie niet is ingelogd, gaat naar de inlogpagina. Voor elk ander account
// bestaat de pagina niet: dat krijgt de gewone "pagina niet gevonden".
//
// Wat je hier kunt doen: bronnen testen en pauzeren, en accounts blokkeren of deblokkeren. Alles wat
// je doet, komt in het systeemlog. Formulieren van een andere site worden al geweigerd door
// checkOrigin (auth.js), net als overal op de site.
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import {
  accountExists, accountOverview, blockAccount, findingTotals, format, notBuilt, recentRuns, recentScans,
  scannerSettings, searchServiceId, sourceRows, systemStatus, unblockAccount, usageOverview,
} from './admin.js';
import { canPause, setPaused } from './controls.js';
import { countRecentEvents, listEvents, logEvent } from './events.js';
import { SqliteStore } from './limit-store.js';
import { isOwner } from './owner.js';
import { probeHibp, probeSearch, probeXon } from './probes.js';

const ONE_HOUR = 60 * 60 * 1000;

// Meldingen bovenaan de pagina. Ze komen uit de adresbalk (?melding=...), maar we tonen alleen
// vaste teksten van onszelf.
const NOTICES = {
  gepauzeerd: 'De bron staat op pauze. De site stuurt er geen aanvragen meer naartoe tot je hem weer aanzet.',
  hervat: 'De bron staat weer aan.',
  getest: 'De test is klaar. De uitkomst staat bij de bron.',
  'te-vaak': 'Je hebt het afgelopen uur al vaak getest. Elke test is een echte aanvraag (en kost soms tegoed). Probeer het later opnieuw.',
  geblokkeerd: 'Het account is geblokkeerd en meteen uitgelogd. Inloggen kan niet meer tot je het deblokkeert.',
  gedeblokkeerd: 'Het account is gedeblokkeerd. De gebruiker kan weer inloggen.',
};

function noticeFrom(query) {
  const key = String(query.melding ?? '');
  return Object.hasOwn(NOTICES, key) ? NOTICES[key] : null;
}

function notFound(res) {
  res.status(404).render('fout', { title: 'Niet gevonden', message: 'Dit bestaat niet (meer).' });
}

const parseId = (value) => (/^\d{1,15}$/.test(String(value)) ? Number(value) : 0);

export function createAdminRoutes({
  db, production, ownerEmail, monitor, search, check, mailer, limits,
}) {
  const router = Router();

  // De toegang. Elke pagina en elk formulier hieronder gaat eerst hierlangs.
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    res.set('X-Robots-Tag', 'noindex, nofollow');
    if (!req.user) return res.redirect(303, '/inloggen');
    if (isOwner(req.user, ownerEmail)) return next();
    // Op je eigen computer zonder OWNER_EMAIL: zeg hoe je de pagina aanzet. Online nooit.
    if (!production && ownerEmail === null) {
      return res.status(404).render('fout', {
        title: 'De beheerpagina staat uit',
        message: 'Zet OWNER_EMAIL met jouw e-mailadres in je .env en start de site opnieuw. Alleen het account met dat adres komt op de beheerpagina, en alleen als het adres bevestigd is.',
      });
    }
    next('router'); // de gewone 404-pagina, alsof de pagina niet bestaat
  });

  // De testknoppen. Ze gebruiken de koppelingen zelf, zonder pauzeknop ervoor: een test is een
  // bewuste keuze van de beheerder, ook als de bron op pauze staat. Elke test is een echte aanvraag.
  const probes = {};
  if (searchServiceId(search) === 'brave') probes.brave = () => probeSearch(search);
  if (check?.adapters?.xon?.listSize) probes.xon = () => probeXon(check.adapters.xon);
  if (check?.adapters?.hibp) probes.hibp = () => probeHibp(check.adapters.hibp);

  const testLimiter = rateLimit({
    windowMs: ONE_HOUR,
    limit: limits.testLimit,
    standardHeaders: false,
    legacyHeaders: false,
    keyGenerator: (req) => String(req.user.id),
    store: new SqliteStore(db, 'admin-test:'),
    handler: (req, res) => {
      logEvent(db, 'limit_reached', { what: 'test' });
      res.redirect(303, '/beheerder?melding=te-vaak#bronnen');
    },
  });

  router.get('/', (req, res) => {
    const now = Date.now();
    const live = monitor.live();
    const onlyProblems = req.query.log === 'problemen';
    res.render('beheerder', {
      notice: noticeFrom(req.query),
      status: systemStatus({ db, monitor, production, search, check, mailer, now }),
      sources: sourceRows({ db, search, check, live }),
      usage: usageOverview({ usage: monitor.usage(now), live }),
      running: monitor.running(),
      runs: recentRuns(db),
      scans: recentScans(db),
      totals: findingTotals(db, now),
      events: listEvents(db, { limit: 60, onlyProblems }),
      eventCounts: countRecentEvents(db, now),
      onlyProblems,
      overview: accountOverview(db, { now }),
      settings: scannerSettings({ limits, search, check }),
      plans: notBuilt(),
      meId: req.user.id,
      now,
      fmt: format,
      wide: true,
    });
  });

  // Een bron pauzeren of weer aanzetten.
  router.post('/bronnen/:id/pauze', (req, res) => {
    const id = String(req.params.id);
    const action = String(req.body?.actie ?? '');
    if (!canPause(id)) return notFound(res);
    if (action !== 'pauzeren' && action !== 'hervatten') {
      return res.status(400).render('fout', { title: 'Onbekende keuze', message: 'Kies pauzeren of hervatten.' });
    }
    const pause = action === 'pauzeren';
    if (setPaused(db, id, pause)) logEvent(db, pause ? 'source_paused' : 'source_resumed', { service: id });
    res.redirect(303, `/beheerder?melding=${pause ? 'gepauzeerd' : 'hervat'}#bronnen`);
  });

  // Een bron testen met een neutrale proefaanvraag (zie probes.js).
  router.post(
    '/bronnen/:id/test',
    (req, res, next) => (Object.hasOwn(probes, req.params.id) ? next() : notFound(res)),
    testLimiter,
    async (req, res) => {
      const id = req.params.id;
      const result = await probes[id]();
      monitor.setTest(id, result);
      logEvent(db, result.ok ? 'source_test_ok' : 'source_test_failed', { service: id });
      res.redirect(303, '/beheerder?melding=getest#bronnen');
    },
  );

  // Een account blokkeren of deblokkeren. Je eigen account kun je niet blokkeren.
  function accountAction(block) {
    return (req, res) => {
      const id = parseId(req.params.id);
      if (!id || !accountExists(db, id)) return notFound(res);
      if (block && id === req.user.id) {
        return res.status(400).render('fout', { title: 'Dat kan niet', message: 'Je kunt je eigen beheerdersaccount niet blokkeren.' });
      }
      const changed = block ? blockAccount(db, id) : unblockAccount(db, id);
      if (changed) logEvent(db, block ? 'account_blocked' : 'account_unblocked', { account: id });
      res.redirect(303, `/beheerder?melding=${block ? 'geblokkeerd' : 'gedeblokkeerd'}#accounts`);
    };
  }

  router.post('/accounts/:id/blokkeren', accountAction(true));
  router.post('/accounts/:id/deblokkeren', accountAction(false));

  return router;
}
