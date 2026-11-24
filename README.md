# Privacyscan, fase 1: de basis

Je eigen privacy-tool, stap voor stap gebouwd. Fase 1 is het fundament:
een account maken, inloggen, uitloggen, je account verwijderen en een simpel dashboard.

## Wat heb je nodig

- **Node.js 22.13 of nieuwer.** Download de LTS-versie via [nodejs.org](https://nodejs.org).
- Verder niets: de database (SQLite) zit al in Node.js ingebouwd.

## Starten

Open een terminal in deze map en typ:

```
npm install
npm start
```

Ga daarna naar **http://localhost:3000** en maak een account aan.

Instellingen zoals de poort zet je in een bestand `.env`. Kopieer daarvoor
`.env.example` naar `.env` en pas het aan; `.env` komt nooit in Git.

| Commando                | Wat het doet                                                      |
|-------------------------|-------------------------------------------------------------------|
| `npm start`             | Start de site                                                     |
| `npm run dev`           | Start de site en herstart automatisch als je een bestand wijzigt  |
| `npm test`              | Draait alle tests (36 stuks, een paar seconden)                   |
| `npm run test:coverage` | Draait de tests en laat zien welke regels code ze niet raken      |

Alle gegevens staan in `data/privacyscan.db`. Gooi je die map weg, dan begin je opnieuw.

## Hoe het in elkaar zit

```
src/
  server.js         start de webserver en leest de instellingen
  app.js            bouwt de app op: beveiligingsheaders, cookies, routes
  routes.js         de pagina's: registreren, inloggen, dashboard, account verwijderen, privacy
  auth.js           wachtwoorden hashen, sessies en de CSRF-check
  limit-store.js    bewaart de tellers tegen wachtwoorden raden in de database
  pwned.js          checkt of een wachtwoord in een bekend datalek staat
  db.js             de database en de tabellen
views/              de pagina's (HTML met EJS)
public/             de vormgeving (CSS)
test/               de tests
.github/workflows/  laat GitHub de tests draaien bij elke push
.env.example        voorbeeld van de instellingen
```

## Beveiliging in het kort

- **Wachtwoorden** worden opgeslagen als argon2id-hash, met de minimuminstellingen
  die OWASP aanraadt (19 MiB geheugen, 2 rondes, 1 thread). Het wachtwoord zelf
  wordt nergens bewaard.
- **Gelekte wachtwoorden** worden bij het registreren geweigerd. De app vraagt dat
  anoniem na bij Pwned Passwords van Have I Been Pwned: alleen de eerste 5 tekens
  van de hash gaan de deur uit. Is die dienst niet bereikbaar, dan gaat de
  registratie gewoon door.
- **Sessies:** na het inloggen krijgt je browser een willekeurig token in een cookie
  (`HttpOnly`, `SameSite=Lax`). In de database staat alleen de hash van dat token.
- **CSRF:** de app laat alleen formulieren van de eigen site door. Hij kijkt eerst
  naar `Sec-Fetch-Site`, en als die ontbreekt naar `Origin`. Ontbreken ze allebei,
  dan is het geen moderne browser en wordt het verzoek geweigerd.
- **Wachtwoorden raden:** na 10 mislukte inlogpogingen per IP-adres, of 5 per
  account, volgt een pauze van een kwartier. De tellers staan gehasht in de
  database, dus een herstart zet ze niet op nul. Keerzijde: wie je e-mailadres
  kent, kan je account zo een kwartier blokkeren; daarom duurt de pauze niet langer.
- **Geen hints voor aanvallers:** bij een fout e-mailadres en een fout wachtwoord zie
  je dezelfde melding, en het antwoord duurt even lang.
- **Helmet** zet veilige HTTP-headers, zoals een Content-Security-Policy.
- De server is standaard **alleen bereikbaar vanaf je eigen computer**.

## Privacy

- Gebruikers kunnen **hun account verwijderen** via het dashboard. Dat wist hun naam,
  e-mailadres, wachtwoord-hash en sessies in één keer. Geef nieuwe tabellen
  `ON DELETE CASCADE`, dan blijft dat zo.
- De **privacyverklaring** staat op `/privacy`. Vul `CONTACT_NAME` en `CONTACT_EMAIL`
  in je `.env` in voordat je de site online zet, en werk de tekst bij zodra de app
  meer gegevens verwerkt (fase 2 en 3).

## Bewust (nog) niet gedaan

- **Wachtwoord vergeten** en **e-mailadres bevestigen.** Daarvoor moet de app mail
  kunnen versturen.
- Bij registreren zie je of een e-mailadres al een account heeft. Dat kan pas netter
  als de app mail kan versturen.

## Later online zetten

- Zet `NODE_ENV=production`. Cookies gaan dan alleen nog over https, dus zorg dat
  de site via https bereikbaar is, anders kun je niet inloggen.
- Zet `HOST=0.0.0.0` (en eventueel `PORT`) zodat de server van buitenaf bereikbaar is.
- Draait hij achter een proxy, zoals Caddy, zet dan in `app.js`
  `app.set('trust proxy', 1)`. Dan ziet de pauze na foute inlogpogingen het echte
  IP-adres van de bezoeker.
- **Database:** `node:sqlite` is in Node 22 nog experimenteel (vandaar de
  `--disable-warning` in `package.json`), en vanaf Node 24.15 een "release candidate".
  Voor een site die echt online gaat, is `better-sqlite3` de beproefde keuze. De code
  daarvoor is bijna gelijk; alleen `db.js` verandert.

## Werkwijze

- Commit per stap, met een boodschap die zegt wat er verandert.
- GitHub Actions draait bij elke push naar `main` en bij elke pull request
  `npm test`, op Node 22 en 24. Je ziet het resultaat onder het tabblad **Actions**.

## Volgende stap: fase 2

- **E-mailadres bevestigen** via een link in een mail. Bewaar ook die tokens alleen
  als hash, en laat ze snel verlopen. Test lokaal met Mailpit (een nep-mailserver)
  en verstuur met `nodemailer`.
- **Have I Been Pwned:** begin met de testsleutel van 32 nullen
  (`00000000000000000000000000000000`). Die werkt met testadressen zoals
  `account-exists@hibp-integration-tests.com`, dus je bouwt gratis op nepdata.
  Stuur bij elke aanvraag een `user-agent`-header mee en vermeld HIBP als bron.
- **Zoeken op naam:** een bevestigd e-mailadres bewijst niet dat de naam bij die
  persoon hoort. Zoek daarom alleen op de naam van het eigen account, en zet dit
  deel niet openbaar online zonder extra controle.
- **Online zetten:** later in Docker, achter Caddy (die regelt https automatisch).
