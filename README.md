# Privacyscan, fase 1: de basis

Je eigen privacy-tool, stap voor stap gebouwd. Fase 1 is het fundament:
een account maken, inloggen, uitloggen en een simpel dashboard.

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

| Commando      | Wat het doet                                                  |
|---------------|---------------------------------------------------------------|
| `npm start`   | Start de site                                                 |
| `npm run dev` | Start de site en herstart automatisch als je een bestand wijzigt |
| `npm test`    | Draait de 20 tests (duurt ongeveer een seconde)               |

Alle gegevens staan in `data/privacyscan.db`. Gooi je die map weg, dan begin je opnieuw.

## Hoe het in elkaar zit

```
src/
  server.js   start de webserver
  app.js      bouwt de app op: beveiligingsheaders, cookies, routes
  routes.js   de pagina's: registreren, inloggen, uitloggen, dashboard
  auth.js     wachtwoorden hashen, sessies en de CSRF-check
  pwned.js    checkt of een wachtwoord in een bekend datalek staat
  db.js       de database en de tabellen
views/        de pagina's (HTML met EJS)
public/       de vormgeving (CSS)
test/         de tests
```

## Beveiliging in het kort

- **Wachtwoorden** worden opgeslagen als argon2id-hash, met de minimuminstellingen
  die OWASP aanraadt (19 MiB geheugen, 2 rondes, 1 thread). Het wachtwoord zelf
  wordt nergens bewaard.
- **Gelekte wachtwoorden** worden bij het registreren geweigerd. De app vraagt dat
  anoniem na bij Pwned Passwords van Have I Been Pwned: alleen de eerste 5 tekens
  van de hash gaan de deur uit. Gratis en zonder API-sleutel. Is de dienst niet
  bereikbaar, dan gaat de registratie gewoon door.
- **Sessies:** na het inloggen krijgt je browser een willekeurig token in een cookie
  (`HttpOnly`, `SameSite=Lax`). In de database staat alleen de hash van dat token.
  Uitloggen verwijdert de sessie echt.
- **CSRF:** formulieren die van een andere website komen, worden geweigerd.
- **Wachtwoorden raden:** na 10 mislukte inlogpogingen per kwartier volgt een pauze.
- **Geen hints voor aanvallers:** bij een fout e-mailadres en een fout wachtwoord zie
  je dezelfde melding, en het antwoord duurt even lang.
- **Helmet** zet veilige HTTP-headers, zoals een Content-Security-Policy.
- De server is standaard **alleen bereikbaar vanaf je eigen computer**.

## Bewust (nog) niet gedaan

- **Wachtwoord vergeten** en **e-mailadres bevestigen.** Daarvoor moet de app mail
  kunnen versturen.
- Bij registreren zie je of een e-mailadres al een account heeft. Dat kan pas netter
  als de app mail kan versturen.
- Het aantal inlogpogingen wordt in het geheugen bijgehouden. Na een herstart begint
  de telling opnieuw.

## Later online zetten

- Zet `NODE_ENV=production`. Cookies gaan dan alleen nog over https, dus zorg dat
  de site via https bereikbaar is, anders kun je niet inloggen.
- Zet `HOST=0.0.0.0` (en eventueel `PORT`) zodat de server van buitenaf bereikbaar is.
- Draait hij achter een proxy of hostingplatform, zet dan in `app.js`
  `app.set('trust proxy', 1)`, zodat de pauze na foute inlogpogingen het echte
  IP-adres van de bezoeker gebruikt.

## Volgende stap: fase 2

- Laat gebruikers eerst hun e-mailadres bevestigen (via een link in een mail).
  Dan scan je alleen adressen waarvan iemand heeft laten zien dat ze van hem zijn.
- Begin met de **testsleutel** van Have I Been Pwned: 32 nullen
  (`00000000000000000000000000000000`). Die werkt met testadressen zoals
  `account-exists@hibp-integration-tests.com`, dus je kunt gratis bouwen op nepdata.
- Stuur bij elke aanvraag een `user-agent`-header mee met de naam van je app, en
  vermeld Have I Been Pwned als bron van de gegevens.
