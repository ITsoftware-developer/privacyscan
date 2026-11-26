// De pagina "Zoekgegevens" (/profiel): de gegevens waarop we voor jou zoeken. Je naam en e-mailadres komen
// uit je account. Hier kies je verder:
//   - je telefoonnummer. Dat onderzoeken we pas als je het bevestigd hebt met een code per sms: een
//     bevestigd e-mailadres bewijst niet dat een nummer van jou is (zie phone-codes.js);
//   - of we ook op je e-mailadres op het web mogen zoeken. Dan gaat het adres als zoekopdracht naar de
//     zoekdienst, en dat doen we alleen als je dat wilt;
//   - je woonplaats, maar alleen als je op naam mag zoeken (zie owner.js). Anders vragen we er niet om:
//     we bewaren niets wat we niet gebruiken.
// Plus het testpostvak voor sms'jes, op je eigen computer (/dev/sms).
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { requireConfirmed, requireLogin } from './auth.js';
import { SqliteStore } from './limit-store.js';
import { canSearchByName as mayUseName } from './owner.js';
import { normalizePhone } from './phone.js';
import {
  CODE_ATTEMPTS, CODE_DIGITS, CODE_MINUTES, checkCode, createCodeHasher, newCode, pendingVerification,
  removePhone, savePhone, startVerification, cancelVerification,
} from './phone-codes.js';
import { isLoopback, noStore } from './routes-scan.js';
import { parseCity } from './search.js';

const ONE_HOUR = 60 * 60 * 1000;

// Meldingen bovenaan de pagina. Ze komen uit de adresbalk (/profiel?bevestigd), maar we tonen alleen
// vaste teksten van onszelf.
const NOTICES = {
  opgeslagen: 'Je woonplaats is opgeslagen.',
  'code-verstuurd': `We hebben een sms met een code gestuurd. Vul hem hieronder in: hij is ${CODE_MINUTES} minuten geldig.`,
  bevestigd: 'Je telefoonnummer is bevestigd. Bij je volgende Deep Scan onderzoeken we het ook.',
  verwijderd: 'Je telefoonnummer is verwijderd. We onderzoeken het niet meer.',
  geannuleerd: 'De code is vervallen. Er is geen nummer toegevoegd.',
  'e-mail-aan': 'Bij je volgende Deep Scan zoeken we ook op het web naar je e-mailadres.',
  'e-mail-uit': 'We zoeken niet meer op het web naar je e-mailadres.',
};

function noticeFrom(query) {
  const key = Object.keys(NOTICES).find((name) => query[name] !== undefined);
  return key ? NOTICES[key] : null;
}

export function createProfileRoutes({
  db,
  production = false,
  ownerEmail = null,
  sms,                    // verstuurt de code (zie sms.js)
  phoneCodeLimit = 3,     // codes per uur, per account en per telefoonnummer
  hashCode = createCodeHasher(),
  clock = () => Date.now(),
}) {
  const router = Router();
  const canSearchByName = (user) => mayUseName(user, { production, ownerEmail });

  // Toont de pagina, eventueel met een foutmelding bij één van de onderdelen.
  function renderProfile(req, res, { status = 200, error = null, section = null, phoneValue = '', cityValue } = {}) {
    noStore(res);
    res.status(status).render('profiel', {
      notice: status === 200 ? noticeFrom(req.query) : null,
      error,
      section,             // bij welk onderdeel de foutmelding hoort: telefoon, code, e-mail of woonplaats
      canUseName: canSearchByName(req.user),
      cityValue: cityValue ?? req.user.city ?? '',
      phoneValue,
      pending: pendingVerification(db, req.user.id, clock()),
      smsAvailable: sms.available,
      devSms: !production,
      codeMinutes: CODE_MINUTES,
      codeDigits: CODE_DIGITS,
    });
  }

  const limiter = (prefix, keyGenerator) => rateLimit({
    windowMs: ONE_HOUR,
    limit: phoneCodeLimit,
    standardHeaders: false,
    legacyHeaders: false,
    keyGenerator,
    store: new SqliteStore(db, prefix),
    handler: (req, res) => renderProfile(req, res, {
      status: 429,
      section: 'telefoon',
      error: 'Je hebt al een paar codes laten sturen. Probeer het over een uur opnieuw.',
      phoneValue: String(req.body.telefoon ?? '').trim().slice(0, 30),
    }),
  });
  // Per account, en per nummer: zo kan niemand met een stapel accounts iemand anders bestoken met sms'jes.
  const perAccount = limiter('phone-code:', (req) => String(req.user.id));
  const perNumber = limiter('phone-code-number:', (req) => req.phone);

  // --- De pagina --------------------------------------------------------------------------------

  router.get('/profiel', requireLogin, (req, res) => renderProfile(req, res));

  // --- Woonplaats (alleen voor wie op naam mag zoeken) -----------------------------------------
  // Voor alle anderen bestaat dit formulier niet: dan valt het verzoek door naar de 404-pagina.

  const requireNameSearch = (req, res, next) => (canSearchByName(req.user) ? next() : next('route'));

  router.post('/profiel', requireLogin, requireNameSearch, (req, res) => {
    const { city, error } = parseCity(req.body.woonplaats);
    if (error) {
      return renderProfile(req, res, {
        status: 400, error, section: 'woonplaats', cityValue: String(req.body.woonplaats ?? '').trim().slice(0, 60),
      });
    }
    db.prepare('UPDATE users SET city = ? WHERE id = ?').run(city, req.user.id);
    res.redirect(303, '/profiel?opgeslagen#woonplaats');
  });

  // --- Telefoonnummer ----------------------------------------------------------------------------

  // Zonder sms-dienst kunnen we geen code sturen, en dus geen nummer bevestigen.
  function requireSms(req, res, next) {
    if (sms.available) return next();
    renderProfile(req, res, {
      status: 503,
      section: 'telefoon',
      error: 'Bevestigen per sms kan op deze site nog niet: er is nog geen sms-dienst gekoppeld.',
    });
  }

  // Eerst het nummer controleren, en dan pas tellen: een typfout kost je geen code.
  function validPhone(req, res, next) {
    const { phone, error } = normalizePhone(req.body.telefoon);
    if (error) {
      return renderProfile(req, res, {
        status: 400, error, section: 'telefoon', phoneValue: String(req.body.telefoon ?? '').trim().slice(0, 30),
      });
    }
    req.phone = phone;
    next();
  }

  router.post('/profiel/telefoon', requireLogin, requireConfirmed, requireSms, validPhone, perAccount, perNumber, async (req, res) => {
    const now = clock();
    const code = newCode();
    startVerification(db, {
      userId: req.user.id, phone: req.phone, codeHash: hashCode(req.user.id, req.phone, code), now,
    });
    try {
      await sms.send(req.phone, `Je code voor ${req.app.locals.appName}: ${code}. Hij is ${CODE_MINUTES} minuten geldig. Heb je dit niet zelf aangevraagd? Dan hoef je niets te doen.`);
    } catch (error) {
      cancelVerification(db, req.user.id);
      console.error(`Sms versturen mislukte (${error?.name ?? 'Error'}).`);
      return renderProfile(req, res, {
        status: 502, section: 'telefoon', error: 'De sms kon niet worden verstuurd. Probeer het later nog eens.',
      });
    }
    res.redirect(303, '/profiel?code-verstuurd#telefoon');
  });

  router.post('/profiel/telefoon/bevestigen', requireLogin, requireConfirmed, (req, res) => {
    const code = String(req.body.code ?? '').replace(/\s/g, '');
    if (!new RegExp(`^\\d{${CODE_DIGITS}}$`).test(code)) {
      return renderProfile(req, res, { status: 400, section: 'code', error: `Vul de ${CODE_DIGITS} cijfers van de code in.` });
    }
    const now = clock();
    const result = checkCode(db, {
      userId: req.user.id, code, hashCode, now,
    });
    if (result.ok) {
      savePhone(db, req.user.id, result.phone, now);
      return res.redirect(303, '/profiel?bevestigd#telefoon');
    }
    const errors = {
      none: 'Er staat geen geldige code open: hij is verlopen of al gebruikt. Vraag een nieuwe code aan.',
      too_many: `Je hebt ${CODE_ATTEMPTS} keer een verkeerde code ingevuld. Die code werkt niet meer: vraag een nieuwe aan.`,
      wrong: `Deze code klopt niet. Je kunt het nog ${result.left === 1 ? '1 keer' : `${result.left} keer`} proberen.`,
    };
    renderProfile(req, res, {
      status: 400, section: result.reason === 'wrong' ? 'code' : 'telefoon', error: errors[result.reason],
    });
  });

  // Een code die openstaat intrekken, bijvoorbeeld bij een typfout in het nummer.
  router.post('/profiel/telefoon/annuleren', requireLogin, (req, res) => {
    cancelVerification(db, req.user.id);
    res.redirect(303, '/profiel?geannuleerd#telefoon');
  });

  router.post('/profiel/telefoon/verwijderen', requireLogin, (req, res) => {
    removePhone(db, req.user.id);
    res.redirect(303, '/profiel?verwijderd#telefoon');
  });

  // --- Zoeken op je e-mailadres -----------------------------------------------------------------

  router.post('/profiel/e-mail-zoeken', requireLogin, requireConfirmed, (req, res) => {
    const choice = String(req.body.keuze ?? '');
    if (choice !== 'aan' && choice !== 'uit') {
      return renderProfile(req, res, { status: 400, section: 'e-mail', error: 'Kies aan of uit.' });
    }
    db.prepare('UPDATE users SET email_web_at = ? WHERE id = ?').run(choice === 'aan' ? clock() : null, req.user.id);
    res.redirect(303, `/profiel?e-mail-${choice}#e-mail`);
  });

  // --- Testpostvak voor sms'jes (alleen op je eigen computer) -------------------------------------

  if (!production) {
    router.get('/dev/sms', (req, res, next) => {
      if (!isLoopback(req.socket.remoteAddress)) return next(); // dan krijg je de 404-pagina
      noStore(res);
      res.render('dev-sms', { messages: sms.outbox });
    });
  }

  return router;
}
