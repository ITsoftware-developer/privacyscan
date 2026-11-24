// Bouwt de webapp op. Dit staat los van server.js, zodat de tests de app
// ook kunnen starten (met een lege database in het geheugen).
import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { join } from 'node:path';
import { checkOrigin, loadUser } from './auth.js';
import { isPwned } from './pwned.js';
import { createRoutes } from './routes.js';

const ROOT = join(import.meta.dirname, '..');

export function createApp({
  db,
  production = false,
  pwnedCheck = isPwned, // de tests vervangen deze, zodat ze ook offline werken
  loginLimit = 10,      // mislukte inlogpogingen per kwartier per IP-adres
  registerLimit = 10,   // aanmeldingen per uur per IP-adres
}) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', join(ROOT, 'views'));
  app.locals.appName = 'Privacyscan';

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
  app.use(createRoutes({ db, production, pwnedCheck, loginLimit, registerLimit }));

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
    const status = error.status >= 400 && error.status < 600 ? error.status : 500;
    res.status(status).render('fout', {
      title: 'Er ging iets mis',
      message: 'Probeer het later nog eens.',
    });
  });

  return app;
}
