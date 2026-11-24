// Start de webserver. Gebruik: npm start (of npm run dev tijdens het bouwen).
import { join } from 'node:path';
import { createApp } from './app.js';
import { openDatabase, removeExpired } from './db.js';

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

const db = openDatabase(join(import.meta.dirname, '..', 'data', 'privacyscan.db'));
const app = createApp({ db, production, contact });

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
});
