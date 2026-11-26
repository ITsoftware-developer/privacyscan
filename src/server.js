// Start de webserver. Gebruik: npm start (of npm run dev tijdens het bouwen).
import { join } from 'node:path';
import { createApp } from './app.js';
import { DEFAULT_LIMITS, parseLimit } from './budget.js';
import { createBreachCheck, parseFreeBreachCheck } from './breach-check.js';
import { openDatabase, removeExpired } from './db.js';
import { logEvent } from './events.js';
import { createHibp } from './hibp.js';
import { prepareStorage } from './housekeeping.js';
import { createMailer } from './mail.js';
import { createMonitor } from './monitor.js';
import { parseOwnerEmail } from './owner.js';
import { isPwned } from './pwned.js';
import { WEB_RESULT_MINUTES } from './retention.js';
import { createSearch, parseStorageRights } from './search.js';
import { createXon } from './xon.js';

function stopWith(message) {
  console.error(message);
  process.exit(1);
}

const port = Number(process.env.PORT ?? 3000);
// Standaard alleen bereikbaar vanaf je eigen computer. Zet HOST=0.0.0.0 pas
// als je de site echt online zet, en dan alleen achter https.
const host = process.env.HOST ?? '127.0.0.1';
const production = process.env.NODE_ENV === 'production';

// Wie is verantwoordelijk voor de gegevens? Komt in de privacyverklaring.
const contact = { name: process.env.CONTACT_NAME, email: process.env.CONTACT_EMAIL };
if (production && (!contact.name || !contact.email)) {
  console.warn('Let op: vul CONTACT_NAME en CONTACT_EMAIL in voor de privacyverklaring.');
}

// Het adres van de site, voor de links in de mails. Bewust een instelling en niet
// het adres uit het verzoek zelf, want dat kan een bezoeker vervalsen.
const baseUrl = (process.env.BASE_URL || `http://localhost:${port}`).replace(/\/+$/, '');

if (production) {
  if (!process.env.SMTP_URL) {
    stopWith('Zet SMTP_URL in je .env: zonder echte mailserver kan niemand zijn e-mailadres bevestigen.');
  }
  if (!baseUrl.startsWith('https://')) {
    stopWith('Zet BASE_URL op het https-adres van je site, bijvoorbeeld https://privacyscan.example.');
  }
}

// De database, en de teller van het verkeer naar de externe diensten (voor de beheerpagina). Elke
// koppeling hieronder krijgt een fetch die meetelt: welke dienst, gelukt of niet, hoe snel. Nooit wat
// er gevraagd werd.
const db = openDatabase(join(import.meta.dirname, '..', 'data', 'privacyscan.db'));
const monitor = createMonitor(db);

// Zonder SMTP_URL komen mails in een testpostvak op /dev/mails (alleen buiten production).
const mailer = createMailer({
  smtpUrl: process.env.SMTP_URL || undefined,
  from: process.env.MAIL_FROM || undefined,
});

// Datalekken (dashboard en de controle op de startpagina). Met een eigen HIBP_API_KEY
// gaat elk adres naar Have I Been Pwned. Zonder sleutel gebruiken we de gratis dienst
// XposedOrNot, zodat echte adressen ook werken (op je eigen computer standaard aan, online
// standaard uit: zie FREE_BREACH_CHECK in .env.example). De testadressen van HIBP werken
// altijd.
let freeCheck;
try {
  freeCheck = parseFreeBreachCheck(process.env.FREE_BREACH_CHECK, { production });
} catch (error) {
  stopWith(error.message);
}
const hasHibpKey = Boolean(process.env.HIBP_API_KEY);
const hibp = createBreachCheck({
  hibp: createHibp({ apiKey: process.env.HIBP_API_KEY || undefined, fetchImpl: monitor.fetchFor('hibp') }),
  xon: freeCheck && !hasHibpKey ? createXon({ fetchImpl: monitor.fetchFor('xon') }) : null,
});
if (production && !hasHibpKey && !freeCheck) {
  console.warn('Let op: zonder HIBP_API_KEY werkt de controle op de startpagina alleen voor testadressen.');
}
if (production && !hasHibpKey && freeCheck) {
  console.warn('Let op: de gratis dienst XposedOrNot is bedoeld voor persoonlijk gebruik en weinig verkeer (25 controles per uur, 100 per dag voor de hele site).');
}

// De zoekdienst voor je naam: Brave Search zodra er een BRAVE_API_KEY is. Zonder zoekdienst zoekt
// de app niet op het web, en verzint hij niets: de pagina's zeggen dat eerlijk. Alleen met
// SEARCH_PROVIDER=demo krijg je nepdata, om de werking te zien. De sleutel en de zoekopdrachten
// (die je naam en woonplaats bevatten) komen nergens in een logboek.
let search;
try {
  search = createSearch(process.env.SEARCH_PROVIDER, {
    braveKey: process.env.BRAVE_API_KEY,
    storageRights: parseStorageRights(process.env.BRAVE_STORAGE_RIGHTS),
    fetchImpl: monitor.fetchFor('brave'),
  });
} catch (error) {
  stopWith(error.message);
}

// Kostenlimieten voor de zoekdienst (zie budget.js). Leeg = de standaardwaarden.
let budget;
try {
  budget = {
    perDay: parseLimit(process.env.BRAVE_MAX_PER_DAY, 'BRAVE_MAX_PER_DAY', DEFAULT_LIMITS.perDay),
    perMonth: parseLimit(process.env.BRAVE_MAX_PER_MONTH, 'BRAVE_MAX_PER_MONTH', DEFAULT_LIMITS.perMonth),
    perScan: parseLimit(process.env.MAX_QUERIES_PER_SCAN, 'MAX_QUERIES_PER_SCAN', DEFAULT_LIMITS.perScan),
  };
} catch (error) {
  stopWith(error.message);
}

// De beheerder: komt op de beheerpagina (/beheerder), en mag op een openbare site als enige op naam zoeken.
let ownerEmail;
try {
  ownerEmail = parseOwnerEmail(process.env.OWNER_EMAIL);
} catch (error) {
  stopWith(error.message);
}

// De wachtwoordcheck bij het aanmaken van een account telt ook mee in het verbruik.
const fetchPwned = monitor.fetchFor('pwned-passwords');
const pwnedCheck = (password) => isPwned(password, { fetchFn: fetchPwned });

const app = createApp({
  db, production, contact, mailer, baseUrl, hibp, search, ownerEmail, monitor, pwnedCheck, budget,
});
logEvent(db, 'server_started', { mode: production ? 'production' : 'development' });
// De werker van de onderzoekswachtrij: een Deep Scan loopt op de achtergrond. Wat bij de vorige keer
// nog liep, gaat eerst terug in de wachtrij.
app.jobs.start();

// Bij het starten: verzonnen demo-resultaten wissen als er een andere zoekdienst is, resultaten
// die niet mogen blijven een einddatum geven, en wat verlopen is meteen wissen (zie housekeeping.js).
const { purged, limited } = prepareStorage(db, search);
if (purged > 0) console.log(`Verzonnen demo-resultaten van een eerdere versie gewist: ${purged}.`);
if (purged > 0 || limited > 0) logEvent(db, 'storage_prepared', { purged, limited });

// Daarna elke minuut verlopen sessies, tellers en webresultaten wissen, zodat we niets langer
// bewaren dan in de privacyverklaring staat. (unref: de timer houdt het
// programma niet in leven als het verder klaar is.)
setInterval(() => removeExpired(db), 60 * 1000).unref();

app.listen(port, host, (error) => {
  if (error) {
    console.error(`Kon de server niet starten: ${error.message}`);
    process.exit(1);
  }
  console.log(`Privacyscan draait op http://localhost:${port}`);
  if (production) {
    console.log(ownerEmail
      ? 'Zoeken op naam staat uit, behalve voor de beheerder (OWNER_EMAIL).'
      : 'Zoeken op naam staat uit. Zet OWNER_EMAIL in je .env om het alleen voor jezelf aan te zetten.');
  }
  console.log(ownerEmail
    ? `Beheerpagina: http://localhost:${port}/beheerder (alleen voor het bevestigde account met OWNER_EMAIL).`
    : 'Beheerpagina: uit. Zet OWNER_EMAIL met je eigen e-mailadres in je .env om hem aan te zetten.');
  if (!search) {
    console.log('Zoekdienst: niet ingesteld. De app zoekt niet op het web en verzint niets. Zet BRAVE_API_KEY in je .env en start opnieuw: de site leest .env alleen bij het starten.');
  } else if (search.isDemo) {
    console.log('Zoekdienst: DEMO met verzonnen nepdata. Haal SEARCH_PROVIDER=demo weg en zet een BRAVE_API_KEY voor echte resultaten.');
    if (process.env.BRAVE_API_KEY) {
      console.log('Let op: er staat wel een BRAVE_API_KEY in je .env, maar SEARCH_PROVIDER=demo staat nog aan, dus Brave wordt niet gebruikt. Haal die regel uit je .env.');
    }
  } else {
    console.log(`Zoekdienst: ${search.label}. Je naam en woonplaats gaan als zoekopdracht naar deze dienst. ${search.retainsResults ? 'Resultaten worden bewaard (BRAVE_STORAGE_RIGHTS=on).' : `Resultaten blijven maximaal ${WEB_RESULT_MINUTES} minuten bewaard.`}`);
    console.log(`Kostenlimieten: hooguit ${budget.perDay} zoekopdrachten per dag, ${budget.perMonth} per maand en ${budget.perScan} per Deep Scan.`);
  }
  if (hasHibpKey) {
    console.log('Datalekken: via Have I Been Pwned, met je eigen sleutel.');
  } else if (freeCheck) {
    console.log('Datalekken: gratis via XposedOrNot (25 controles per uur, 100 per dag). Met HIBP_API_KEY gebruikt de app Have I Been Pwned.');
  } else {
    console.log('Datalekken: alleen de testadressen van Have I Been Pwned werken. Zet FREE_BREACH_CHECK=on of een HIBP_API_KEY in je .env.');
  }
  if (!production && !mailer.usesSmtp) {
    console.log(`Mails komen in het testpostvak: http://localhost:${port}/dev/mails`);
  }
});
