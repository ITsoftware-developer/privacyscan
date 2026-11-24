// Start de webserver. Gebruik: npm start (of npm run dev tijdens het bouwen).
import { join } from 'node:path';
import { createApp } from './app.js';
import { openDatabase } from './db.js';

const port = Number(process.env.PORT ?? 3000);
// Standaard alleen bereikbaar vanaf je eigen computer. Zet HOST=0.0.0.0 pas
// als je de site echt online zet, en dan alleen achter https.
const host = process.env.HOST ?? '127.0.0.1';
const production = process.env.NODE_ENV === 'production';

const db = openDatabase(join(import.meta.dirname, '..', 'data', 'privacyscan.db'));
const app = createApp({ db, production });

app.listen(port, host, (error) => {
  if (error) {
    console.error(`Kon de server niet starten: ${error.message}`);
    process.exit(1);
  }
  console.log(`Privacyscan draait op http://localhost:${port}`);
});
