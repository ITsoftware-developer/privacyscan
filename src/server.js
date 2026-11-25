// Start de webserver. Gebruik: npm start (of npm run dev tijdens het bouwen).
import { join } from 'node:path';
import { createApp } from './app.js';
import { createBreachCheck, parseFreeBreachCheck } from './breach-check.js';
import { openDatabase, removeExpired } from './db.js';
import { createHibp } from './hibp.js';
import { createMailer } from './mail.js';
import { parseOwnerEmail } from './owner.js';
import { createSearch } from './search.js';
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
  hibp: createHibp({ apiKey: process.env.HIBP_API_KEY || undefined }),
  xon: freeCheck && !hasHibpKey ? createXon() : null,
});
if (production && !hasHibpKey && !freeCheck) {
  console.warn('Let op: zonder HIBP_API_KEY werkt de controle op de startpagina alleen voor testadressen.');
}
if (production && !hasHibpKey && freeCheck) {
  console.warn('Let op: de gratis dienst XposedOrNot is bedoeld voor persoonlijk gebruik en weinig verkeer (25 controles per uur, 100 per dag voor de hele site).');
}

// De zoekdienst voor je naam. Nu alleen "demo" (nepdata).
let search;
try {
  search = createSearch(process.env.SEARCH_PROVIDER || 'demo');
} catch (error) {
  stopWith(error.message);
}

// De beheerder: op een openbare site mag alleen dit account op naam zoeken.
let ownerEmail;
try {
  ownerEmail = parseOwnerEmail(process.env.OWNER_EMAIL);
} catch (error) {
  stopWith(error.message);
}

const db = openDatabase(join(import.meta.dirname, '..', 'data', 'privacyscan.db'));
const app = createApp({ db, production, contact, mailer, baseUrl, hibp, search, ownerEmail });

// Elke minuut verlopen sessies en tellers wissen, zodat we niets langer
// bewaren dan in de privacyverklaring staat. (unref: de timer houdt het
// programma niet in leven als het verder klaar is.)
removeExpired(db);
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
