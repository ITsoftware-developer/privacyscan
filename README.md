# Privacyscan: wat weet het internet over jou?

Privacyscan **zoekt persoonsgegevens op, toont ze en zegt waar het ze vond**: in bekende datalekken, op het
web (met een zoekdienst, nu Brave Search) en straks ook bij databrokers en in openbare documenten. De app
**verwijdert niets van het internet** en **stuurt geen verwijderverzoeken**. Dat is een bewuste keuze en
geen ontbrekende functie: Privacyscan vindt en laat zien, wat je daarna doet bepaal je zelf.

> **De app verzint niets.** Elke bevinding heeft een bron die je zelf kunt nalopen, een datum waarop het
> onderzocht is en een zekerheid, met de reden erbij. Zonder zoekdienst zoekt de app niet op het web, en
> dat staat er dan ook: geen nepresultaten. En het rapport zegt welke bronnen niet toegankelijk of nog niet
> gebouwd waren, in plaats van te doen alsof alles gelukt is.

> **Wat de app ook niet doet: beweren dat iets van jou is.** Een webresultaat is een *mogelijke
> overeenkomst* met je naam. Pas als jij het bevestigt ("Dit ben ik"), geldt het als van jou. En dat een
> soort gegeven in een datalek zat (bijvoorbeeld telefoonnummers) betekent niet dat jouw nummer eruit
> gelekt is: niet elk slachtoffer van een lek verloor elke soort gegeven.

## Wat is er nieuw in 0.7.0? De beheerpagina

Op `/beheerder` staat een technisch controlecentrum, alleen voor jou als beheerder. Je ziet er wat de site doet,
welke bronnen hij gebruikt, waar het vastloopt en hoeveel aanvragen het kost:

| Onderdeel | Wat je ziet of doet |
|---|---|
| Systeemstatus | Wanneer de site gestart is en met welke instellingen (zoekdienst, datalekbron, mail), de database en de aantallen bevindingen. Is de site gestart zonder `BRAVE_API_KEY`, dan staat dat bovenaan, met de oplossing. |
| Databronnen | Per bron de toestand (actief, niet ingesteld, alleen testadressen, gepauzeerd) en de laatste aanvraag: gelukt of niet, de HTTP-status en de duur. **Testen** doet een neutrale proefaanvraag. **Pauzeren** zet een bron tijdelijk uit: de site stuurt er dan niets meer heen, en wie zoekt, hoort dat de bron tijdelijk uit staat. |
| API-verbruik | Het aantal aanvragen per dienst vandaag, deze maand en vorige maand, en hoeveel daarvan mislukten. Voor Brave ook de limieten die Brave zelf bij elk antwoord meegeeft, en een schatting van de kosten. |
| Onderzoeken | Wat er nu loopt, de laatste Deep Scans met de uitkomst per stap, en de laatste losse scans (alleen de aantallen). |
| Systeemlog | Storingen van bronnen, scans met aantallen en duur, onverwachte fouten, en wat jij als beheerder deed. Zonder persoonsgegevens, en hooguit 30 dagen. |
| Accounts | De aantallen, en per account het e-mailadres, de datums en de status. **Blokkeren** bij misbruik: inloggen kan dan niet meer, en een open sessie stopt meteen. Deblokkeren maakt het ongedaan. |
| Scannerinstellingen | De limieten en instellingen die nu gelden. Alleen om te zien: ze staan in de code en in `.env`. |
| Nog niet gebouwd | De AI-engine, de Data Broker Engine, onderzoek op de achtergrond, pagina's zelf onderzoeken, automatisch opnieuw scannen en tweestapsverificatie. |

**Zo kom je erop.** Zet in je `.env` de regel `OWNER_EMAIL=` met je eigen e-mailadres en start de site opnieuw.
Log in met het account met dat adres (het moet bevestigd zijn): je komt dan meteen op de beheerpagina. Vanaf je
dashboard kom je er via **Beheer** rechtsboven. De server controleert bij elk verzoek of jij het bent; een
verborgen link is geen beveiliging. Voor ieder ander account bestaat de pagina niet (de gewone "pagina niet
gevonden"), en wie niet is ingelogd, gaat naar de inlogpagina.

**Wat er bewust niet op staat:** namen, woonplaatsen, zoekopdrachten en wat er over iemand gevonden is. Het
systeemlog bevat alleen vaste meldingen met getallen en vaste woorden (zie `events.js`): er kan geen
e-mailadres, naam, zoekopdracht, webadres of sleutel in komen, ook niet via de foutmelding van een andere dienst.
De sleutels zelf zie je nergens: alleen of ze ingesteld zijn.

**Wat er nog niet is** (uit dezelfde beoordeling): de scanner leest nog steeds alleen de titel, het fragment en
het adres die de zoekdienst teruggeeft, en opent de pagina zelf niet. Het zoeken begint bij je naam en
woonplaats, niet bij je e-mailadres. Er is geen AI-agent, geen eigen onderzoek bij databrokers en geen wachtrij
op de achtergrond. En tweestapsverificatie voor de beheerder ontbreekt nog: zet de site niet openbaar voordat
die er is.

## Wat was er nieuw in 0.6.0?

Versie 0.5.0 kreeg een kritische beoordeling met zes punten. Zo is er mee omgegaan, en wat er nog niet is:

| Punt uit de beoordeling | Wat er nu is | Wat er nog niet is |
|---|---|---|
| 1. Alleen soorten gegevens, geen echte gegevens | Op het web: telefoonnummers, e-mailadressen en postcodes die in een resultaat lijken te staan, gemaskeerd, met erbij of het je eigen account-adres is. Bij datalekken zegt de app voorzichtiger wat een lek betekent: een soort gegeven in een lek betekent niet dat jouw gegeven eruit gelekt is. | Bij een datalek weten we alleen welke soorten gegevens het lek had; welke van jou erin zaten, zegt de bron niet. |
| 2. "Verifiëren" is geen echte verificatie | De stap heet *Bewijs controleren* en zegt zelf dat hij onze eigen administratie controleert, niet de bron. | Echte bronverificatie bestaat niet. Dat kan jij alleen door de bron te openen. |
| 3. De zekerheid is te optimistisch | Een webresultaat is een *mogelijke overeenkomst*. Volledige naam + woonplaats is *Mogelijk*, niet meer. Alleen je bevestigde e-mailadres in de tekst geeft een *sterke* overeenkomst. Jouw oordeel staat apart. | Een identiteitscontrole (zie "Bewust (nog) niet gedaan"). |
| 4. De databroker-engine ontbreekt | De stap staat er eerlijk als "Nog niet gebouwd". Het soort site (mogelijke personenzoeksite of telefoongids) wordt wel herkend aan het adres. | De databroker-engine zelf: gericht zoeken op bekende databrokersites. |
| 5. Nog geen autonome AI | Eerst echte onderzoeksfuncties: een echte zoekdienst, echte resultaten, eerlijke staten. Er is nu geen AI in de app. | De AI-agent (fase 5). De voorwaarden van Brave beperken wat er met hun resultaten mag. |
| 6. Geen echte achtergrondscanner | Niet in deze versie. | Een wachtrij met voortgang en aparte onderzoeksprocessen: de volgende stap. |

En het belangrijkste: **er is geen verzonnen data meer**. Zonder zoekdienst zoekt de site niet op het web en zegt
dat, in plaats van nepresultaten te tonen. De demo bestaat nog, maar alleen als je hem zelf aanzet met
`SEARCH_PROVIDER=demo`, en wat de demo eerder verzon, wordt bij het starten gewist.

## Wat kan het, en wat niet?

Alleen wat hier **Werkt** heet, doet de app echt. De pagina `/bronnen` in de app toont dezelfde stand van
zaken, afgestemd op jouw instellingen.

| Onderdeel | Stand | Toelichting |
|---|---|---|
| Datalekken van een e-mailadres opsporen | **Werkt** | Twee bronnen: XposedOrNot (gratis) en Have I Been Pwned (met sleutel). Per lek: de naam, de datum, het aantal accounts en de soorten gegevens die gelekt zijn. |
| Blootstelling van persoonsgegevens | **Werkt** | Uit de gevonden lekken: welke *soorten* gegevens zijn blootgesteld (inloggegevens, telefoonnummers, adressen, identiteit, betaalgegevens, online activiteit), met een korte raad. Nooit de gegevens zelf. |
| Gelekte inloggegevens signaleren | Deels | Je ziet dat wachtwoorden of gebruikersnamen in een lek zaten, niet welke. Een wachtwoord laten nakijken kan nu alleen bij het maken van een account; een eigen pagina daarvoor staat gepland. |
| Telefoonnummers en adressen | Deels | Als soort gegevens in een datalek, en gemaskeerd (`+31 6 •••• 5678`) als iets dat erop lijkt in de titel of het fragment van een webresultaat staat. Wat de app daar ziet, is een gok op het uiterlijk. |
| Zoeken op het web naar je eigen naam | **Werkt met een sleutel** | Via Brave Search, zodra je `BRAVE_API_KEY` hebt ingesteld. Elk resultaat is een *mogelijke overeenkomst*, met de reden erbij. Zonder sleutel zoekt de site niet en verzint hij niets. De koppeling is gebouwd naar de documentatie van Brave en getest met nagebootste antwoorden, nog niet tegen de echte dienst: draai `npm run controleer` met je eigen sleutel. |
| Soort site (socialemedia, personenzoeksite, openbaar document) | Deels | Een voorzichtige inschatting aan het adres van een webresultaat. Gericht zoeken op die soorten sites volgt. |
| Zoeken op de achtergrond, met voortgang | Gepland | Nu loopt een scan terwijl je wacht. Een wachtrij met voortgang is de volgende stap. |
| Databrokers | Gepland | Fase 3. Alleen via toegestane bronnen; alleen vinden en tonen. |
| Darkweb via geautoriseerde bronnen | Gepland | Alleen via een aanbieder die dit legaal levert. Geen eigen crawler. |
| Zelfstandig onderzoek door een AI-agent | Gepland | Fase 5. Er is nu geen AI in de app: eerst moeten de onderzoeksfuncties zelf echt werken. De voorwaarden van Brave verbieden bovendien om hun resultaten te gebruiken om AI-modellen te trainen of te beoordelen. |
| Doorlopende monitoring | Gepland | Fase 6. |
| Gegevens van het internet verwijderen | Bewust niet | De app zoekt en toont. |
| Verwijderverzoeken versturen | Bewust niet | Idem. Je eigen account bij Privacyscan wissen kan wel altijd. |

### De zes fases

| Fase | Onderdeel | Stand |
|---|---|---|
| 1 | Veilig fundament: account, inloggen, e-mail bevestigen, database, dashboard | Klaar |
| 2 | Breach Intelligence Engine: datalekken en blootstelling, met twee bronnen | Klaar (darkweb volgt zodra er een geautoriseerde aanbieder is) |
| 3 | Data Broker Engine | Nog niet gebouwd |
| 4 | Deep Research Engine: openbare internetbronnen en documenten | Begonnen: de Deep Scan, zoeken op het web met Brave, de bewijscontrole en de gemaskeerde gegevens bestaan; een achtergrondscanner met voortgang en gericht zoeken naar sites en documenten nog niet |
| 5 | Eigen AI-agent | Nog niet gebouwd |
| 6 | Continuous Monitoring | Nog niet gebouwd |

Een fase heet pas klaar als alles erin echt werkt. De pagina `/bronnen` en het dashboard tonen dezelfde stand.

**Uitgangspunten:** zoek alleen naar jezelf (je eigen, bevestigde e-mailadres en je eigen naam), test op
nepdata, en laat foto's zoeken en gezichtsherkenning weg. De openbare controle laat alleen zien *in welk
lek* een adres zat, nooit de gelekte gegevens, en is geen manier om mensen op naam op te zoeken.
Onderzoek naar iemand anders, ook met toestemming, bestaat nog niet (zie "Bewust (nog) niet gedaan").

## Wat heb je nodig

- **Node.js 22.13 of nieuwer.** Download de LTS-versie via [nodejs.org](https://nodejs.org).
- Verder niets: de database (SQLite) zit al in Node.js ingebouwd, en mails komen standaard in een
  testpostvak in de app zelf.
- Echte e-mailadressen controleren kan zonder sleutel, via de gratis dienst
  [XposedOrNot](https://xposedornot.com) (25 controles per uur, voor persoonlijk gebruik). Die koppeling
  is gebouwd naar hun gepubliceerde beschrijving en getest met nagebootste antwoorden, maar nog niet
  tegen de echte dienst geprobeerd: zie "Waar de gegevens vandaan komen".
- Voor zoeken op het web: een sleutel voor de [Brave Search API](https://brave.com/search/api)
  (zie "Echt op het web zoeken"). Zonder sleutel werkt de rest van de site gewoon, alleen zoekt hij dan niet op het web.
- Later, als je meer wilt: een [HIBP-sleutel](https://haveibeenpwned.com/API/Key) (betaald) en
  eventueel Mailpit (een nep-mailserver).

## Starten

Open een terminal in deze map en typ:

```
npm install
npm start
```

Ga daarna naar **http://localhost:3000**.

Kom je uit een eerdere versie? Dan hoeft er niets te gebeuren: in 0.6.0 zijn er geen nieuwe pakketten
bijgekomen, dus `npm install` is niet nodig. De database wordt bij het starten vanzelf bijgewerkt en je
account en je datalekken blijven staan.

Let op twee dingen:

- **De verzonnen demo-resultaten worden bij het starten gewist**, zodra de zoekdienst niet meer de demo is.
  Dat is bedoeld: nepdata hoort niet tussen echte bevindingen te staan. Wat jij bij die nepresultaten koos,
  gaat dan ook weg.
- **Stond er in je `.env` een regel `SEARCH_PROVIDER=demo`?** Die stond in het oude voorbeeld. Haal hem weg
  (of maak hem leeg), anders blijf je nepdata zien. De site waarschuwt daar bij het starten voor als er ook
  een `BRAVE_API_KEY` staat.

### Proberen met nepdata (begin hier)

**De openbare controle (zonder account).** Ga naar http://localhost:3000, typ een e-mailadres en
klik op *Start Deep Scan*. Op de startpagina draait dat alleen de datalekcontrole (stap 1); de andere
stappen staan er zoals ze zijn: wat zonder account niet kan, staat er als overgeslagen of als nog
niet gebouwd. Echte adressen gaan naar de gratis dienst XposedOrNot, of naar Have I Been Pwned als je
daar een sleutel voor hebt. Wil je liever testen met nepdata? Typ dan
**`multiple-breaches@hibp-integration-tests.com`**: dat is een testadres van Have I Been Pwned en geeft
drie (verzonnen) lekken. Probeer ook `account-exists@hibp-integration-tests.com` (één lek) en
`not-active-breach@hibp-integration-tests.com` (geen lek, dus "goed nieuws"). Zet je de gratis dienst
uit (`FREE_BREACH_CHECK=off`) en heb je geen HIBP-sleutel, dan werken alleen die testadressen en
zegt de pagina dat eerlijk ("Testmodus").

**Met een account.**

1. Maak een account met als e-mailadres **`multiple-breaches@hibp-integration-tests.com`**.
   Dat is een testadres van Have I Been Pwned; het werkt zonder betaalde sleutel en geeft drie
   (verzonnen) datalekken terug. Andere testadressen: `account-exists@…` (één datalek) en
   `not-active-breach@…` (geen datalekken, dan zie je het "goed nieuws"-bericht). Allemaal op
   `@hibp-integration-tests.com`.
2. De bevestigingsmail komt in het **testpostvak**: http://localhost:3000/dev/mails (alleen
   bereikbaar vanaf je eigen computer). Open de mail, klik op de link en dan op de knop
   "Ja, dit is mijn e-mailadres".
3. Op je dashboard: **Start Deep Scan**. De scanner loopt alle stappen af en je krijgt een rapport
   met per stap een status, de bronnen, de blootgestelde soorten gegevens en bij elke bevinding de
   bron, de datum en de zekerheid. Je kunt ook per bron zoeken: **Zoek in datalekken** en **Zoek op het web**.
4. Vul eventueel een woonplaats in ("Woonplaats toevoegen" op het dashboard). Zonder zoekdienst zoekt de
   site niet op het web: het dashboard en het rapport zeggen dat ("Niet beschikbaar"). Wil je alleen de
   werking zien, dan kun je `SEARCH_PROVIDER=demo` in je `.env` zetten: dan krijg je vijf **verzonnen**
   resultaten op `example.org/net/com`, er gaat niets naar buiten, en het rapport zegt dat ook
   ("Voltooid (demo)"). Voor echte resultaten: zie "Echt op het web zoeken".

Met een betaalde `HIBP_API_KEY` gaat elk adres naar Have I Been Pwned in plaats van naar XposedOrNot.
Is er geen bron beschikbaar voor een adres, dan zegt de app dat eerlijk in plaats van iets te verzinnen.

### Echt op het web zoeken (Brave Search)

1. Maak een account op [brave.com/search/api](https://brave.com/search/api) en kies een abonnement voor de
   Search API. Op het moment van schrijven is er per maand een klein tegoed (ongeveer 1.000 zoekopdrachten),
   en vraagt Brave om een betaalmiddel bij het aanmelden. Kijk op hun site voor de actuele prijzen.
2. Zet de sleutel in je `.env`: `BRAVE_API_KEY=...`. **Alleen daar**: niet in een chat, een mail of Git
   (`.env` staat in `.gitignore`). De sleutel staat nergens op een pagina en in geen logboek.
3. Probeer de koppeling: `npm run controleer`. Dat stuurt één neutrale zoekopdracht (niet je naam) naar
   Brave en twee aanvragen naar XposedOrNot, en zegt per bron of het werkt. Met
   `npm run controleer -- jij@voorbeeld.nl` controleert het ook je eigen adres bij XposedOrNot.
4. Start de site (`npm start`), kies op het dashboard **Zoek op het web**, en beoordeel de resultaten.

**Wat naar Brave gaat:** je naam, en je woonplaats als je die hebt ingevuld, als zoekopdracht
(`"Anna de Vries" "Utrecht"`). Je e-mailadres en je wachtwoord gaan er nooit heen. Voor wat Brave met de
zoekopdracht doet, gelden hun eigen voorwaarden.

**Wat de voorwaarden van Brave betekenen** (gecontroleerd in november 2026; lees ze zelf na):

- **Resultaten niet bewaren** (3(b)(i)). Daarom blijven webresultaten maar **30 minuten** staan: net lang genoeg
  om na een zoekopdracht je resultaten te zien en te beoordelen. Daarna zijn ze weg, en zoek je opnieuw. Wat je
  koos (*Dit ben ik*, *Dit ben ik niet*, *Weet ik niet*) blijft bewaard, maar alleen als vingerafdruk (SHA-256)
  van het adres, niet als adres, titel of tekst. Vindt een nieuwe zoekopdracht hetzelfde adres weer, dan geldt
  jouw keuze weer. Heb je bij Brave een abonnement waarin bewaren is toegestaan, zet dan
  `BRAVE_STORAGE_RIGHTS=on`: dan blijven resultaten staan zolang je account bestaat.
- **Geen AI-training of -beoordeling met de resultaten** (3(b)(xiii)). De app doet dat niet, en er komt niets
  in dat die kant op gaat zolang je Brave gebruikt. Dit telt zwaar voor de AI-agent van fase 5.
- **Alleen van jezelf.** Zoeken gaat altijd op de naam van het ingelogde account; er is geen zoekvak voor
  een andere naam, en online mag alleen de beheerder zoeken. De voorwaarden noemen onder meer "surveillance"
  en illegale activiteiten als verboden gebruik (3(b)(xv)); de app is bewust beperkt tot het controleren van
  jezelf. Of jouw gebruik binnen hun voorwaarden past, blijft jouw verantwoordelijkheid.
- "Powered by Brave" tonen is volgens de voorwaarden optioneel; de app noemt Brave wel bij naam in de
  privacyverklaring en op de resultaatpagina's. Er staat nergens dat Brave de app aanbeveelt of sponsort.

### Mailpit gebruiken (optioneel)

Wil je zien hoe de mail er in een echt mailprogramma uitziet? Download
[Mailpit](https://mailpit.axllent.org), start het, en zet in `.env`:

```
SMTP_URL=smtp://127.0.0.1:1025
```

Je leest de mails dan op http://localhost:8025. Het testpostvak in de app staat dan uit.

## Instellingen

Zet ze in een bestand `.env`: kopieer `.env.example` naar `.env` en pas het aan. `.env` komt nooit in Git.

| Instelling         | Standaard                   | Wat het doet                                                                                  |
|--------------------|-----------------------------|-----------------------------------------------------------------------------------------------|
| `PORT`             | `3000`                      | De poort van de site                                                                          |
| `HOST`             | `127.0.0.1`                 | Alleen bereikbaar vanaf je eigen computer. Online: `0.0.0.0`                                  |
| `NODE_ENV`         | `development`               | Met `production` gelden de strengere regels voor een openbare site (zie onderaan)             |
| `CONTACT_NAME`, `CONTACT_EMAIL` | leeg           | Wie verantwoordelijk is voor de gegevens; komt in de privacyverklaring                        |
| `BASE_URL`         | `http://localhost:3000`     | Het adres van je site, voor de links in de mails. Komt nooit uit het verzoek zelf             |
| `SMTP_URL`         | leeg                        | Mailserver. Leeg = testpostvak op `/dev/mails`. Online verplicht                              |
| `MAIL_FROM`        | `Privacyscan <noreply@localhost>` | Afzender van de mails                                                                   |
| `FREE_BREACH_CHECK`| aan (online: uit)           | `on` of `off`. Gratis controle van echte adressen via XposedOrNot, als je geen HIBP-sleutel hebt   |
| `HIBP_API_KEY`     | leeg                        | Sleutel van Have I Been Pwned (betaald). Met sleutel gaat elk adres naar HIBP. Leeg = alleen de testadressen van HIBP, plus de gratis dienst als die aanstaat |
| `BRAVE_API_KEY`    | leeg                        | Sleutel van Brave Search. Met sleutel zoekt de site op het web. Zet hem alleen in `.env`      |
| `SEARCH_PROVIDER`  | leeg                        | Leeg = Brave als er een sleutel is, anders geen zoekdienst. `brave`, `demo` (verzonnen nepdata) of `none` |
| `BRAVE_STORAGE_RIGHTS` | leeg                    | `on` alleen als je abonnement bij Brave het bewaren van resultaten toestaat. Anders blijven ze 30 minuten staan |
| `OWNER_EMAIL`      | leeg                        | Jouw e-mailadres: dat account komt op de beheerpagina (`/beheerder`), en mag online als enige op naam zoeken (zie "Later online zetten") |

| Commando                | Wat het doet                                                      |
|-------------------------|-------------------------------------------------------------------|
| `npm start`             | Start de site                                                     |
| `npm run dev`           | Start de site en herstart automatisch als je een bestand wijzigt  |
| `npm run controleer`    | Probeert Brave en XposedOrNot echt uit, met je eigen sleutel      |
| `npm test`              | Draait alle tests (513 stuks, een paar seconden)                  |
| `npm run test:coverage` | Draait de tests en laat zien welke regels code ze niet raken      |

Alle gegevens staan in `data/privacyscan.db`. Gooi je die map weg, dan begin je opnieuw.

## Hoe het in elkaar zit

```
src/
  server.js         start de webserver en leest de instellingen
  app.js            bouwt de app op: beveiligingsheaders, cookies, routes
  routes-public.js  de startpagina, de openbare e-mailcontrole (zonder account) en de pagina /bronnen
  routes.js         de pagina's van fase 1: registreren, inloggen, account verwijderen, privacy
  routes-scan.js    de pagina's met account: dashboard, bevestigen, zoekgegevens, zoeken, de Deep Scan, resultaten
  routes-admin.js   de beheerpagina (/beheerder): wie erop mag, testen, pauzeren, blokkeren
  admin.js          wat de beheerpagina laat zien (status, bronnen, verbruik, onderzoeken, accounts, instellingen)
  monitor.js        telt de aanvragen naar elke externe dienst, leest de limieten van Brave, weet wat er nu loopt
  events.js         het systeemlog: vaste meldingen, zonder persoonsgegevens
  controls.js       de pauzeknoppen van de beheerpagina
  probes.js         de proefaanvragen: voor de testknoppen en voor `npm run controleer`
  services.js       de externe diensten (Brave, XposedOrNot, HIBP, Pwned Passwords) op één plek
  auth.js           wachtwoorden hashen, sessies en de CSRF-check
  confirm.js        e-mailadres bevestigen: tokens, geldigheid en de bevestigingsmail
  email.js          de regels voor e-mailadressen (netjes maken, controleren), op één plek
  owner.js          de beheerder (OWNER_EMAIL): wie op de beheerpagina komt en online op naam mag zoeken
  mail.js           mail versturen (SMTP) of in het testpostvak zetten
  hibp.js           praat met Have I Been Pwned (datalekken van een e-mailadres)
  xon.js            praat met XposedOrNot, de gratis bron (zonder sleutel, met een lage limiet)
  breach-check.js   kiest per adres welke van die twee bronnen zoekt, en leest FREE_BREACH_CHECK
  sources.js        de bronnen van datalekken, het bronnenregister en de zes fases
  confidence.js     hoe zeker is een bevinding? De regels, met bij elke beoordeling de reden
  engine.js         de onderdelen van de Deep Scan: stappen en statussen, blootstelling, verificatie
  scanner.js        de Deep Scan zelf: voert de stappen uit en bewaart het rapport
  data-classes.js   Nederlandse namen voor de soorten gelekte gegevens ("Passwords" wordt "Wachtwoorden")
  search.js         de zoekopdracht opbouwen, resultaten opschonen, de zoekdiensten (Brave en de demo)
  scans.js          het eigenlijke zoeken: vraag het aan een dienst, bewaar wat terugkomt
  extract.js        wat er in een webresultaat op een telefoonnummer, e-mailadres of postcode lijkt (gemaskeerd), en wat voor soort site het is
  retention.js      hoe lang webresultaten blijven staan (30 minuten) en de vingerafdruk van een adres
  housekeeping.js   wat er bij het starten met bewaarde gegevens gebeurt (demo wissen, verlopen wissen)
  findings.js       resultaten (met bron, datum en zekerheid) en je keuzes bewaren en lezen
  scan-error.js     de fouten die een scan kan geven, zonder technische details
  text.js           tekst van buiten (HTML eruit halen, inkorten)
  limit-store.js    bewaart de tellers tegen misbruik in de database
  pwned.js          checkt of een wachtwoord in een bekend datalek staat
  db.js             de database, de tabellen en het bijwerken van oudere databases
views/              de pagina's (HTML met EJS)
  bronnen.ejs             het bronnenregister en de roadmap
  beheerder.ejs           de beheerpagina
  partials/engine.ejs     het paneel "Research Engine" met de vijf stappen
  partials/evidence.ejs   de bron, datum en zekerheid bij een bevinding
public/             de vormgeving (CSS)
scripts/            controleer-bronnen.js: `npm run controleer`
test/               de tests
.github/workflows/  laat GitHub de tests draaien bij elke push
.env.example        voorbeeld van de instellingen
```

## Hoe het zoeken werkt

**De Deep Scan.** Op het dashboard staat **Start Deep Scan**. Eén klik laat de scanner vijf stappen
doorlopen, in deze volgorde:

1. *Datalekdatabases onderzoeken.* Een echte controle van het bevestigde e-mailadres van je account,
   bij XposedOrNot of Have I Been Pwned.
2. *Databrokers controleren.* Nog niet gebouwd, en dat staat er ook zo in het rapport.
3. *Openbare internetbronnen onderzoeken.* Een zoekopdracht op je eigen naam (en woonplaats), bij Brave
   Search. Zonder zoekdienst staat deze stap als "Niet beschikbaar"; online mag alleen de beheerder op
   naam zoeken.
4. *Mogelijke blootstelling beoordelen.* Rekenwerk op de gevonden lekken: welke soorten gegevens zaten in
   die lekken, met een korte raad. Nooit de gegevens zelf, want die hebben we niet, en niet wat er van jou
   in stond: een soort gegeven in een lek betekent niet dat jouw gegeven eruit gelekt is.
5. *Bewijs controleren.* Heeft elke bevinding een bron, een datum en een zekerheid? Dit is een **controle van
   onze eigen administratie** en geen controle van de bron zelf. Of een lek echt jouw gegevens bevatte, of
   een webpagina echt over jou gaat, kun jij alleen nagaan door de bron te openen.

Elke stap eindigt in één van deze toestanden, en dat staat altijd als tekst bij (kleur is nooit het enige):

| Status | Wat het betekent |
|---|---|
| Voltooid | De stap is gelopen. Bij de demo-zoekdienst staat er "Voltooid (demo)". |
| Niet toegankelijk | De bron bestaat, maar we kwamen er niet bij: een storing, een bereikte limiet of een geweigerde sleutel. |
| Niet beschikbaar | Er is geen bron ingesteld: geen HIBP-sleutel en de gratis dienst staat uit, of geen zoekdienst (`BRAVE_API_KEY`). |
| Overgeslagen | Het mag of kan nu niet, bijvoorbeeld zoeken op naam op een openbare site. |
| Nog niet gebouwd | De stap bestaat nog niet. |
| Mislukt | Er ging iets mis in de scanner zelf. In het rapport staat alleen een korte vaste tekst; in de terminal staan de soort fout en de eerste regel van de melding. |

Eén stap die niet lukt, stopt de rest niet, en een stap die niet gelopen is, krijgt nooit de status
"Voltooid". Het rapport van je laatste Deep Scan blijft bewaard en staat op het dashboard en bij je
resultaten. De Deep Scan telt voor de limiet als één datalekcontrole én één webzoekopdracht.

**Bewijs bij elke bevinding.** Elke bevinding heeft drie dingen die je kunt nalopen:

- **Een bron:** welke datalekbron of zoekdienst het gaf, met een link naar de bron.
- **Een datum:** wanneer het is onderzocht. Dat is een andere datum dan het moment waarop jij "Dit ben ik"
  koos.
- **Een zekerheid, met de reden erbij.** Bij een datalek is dat *Hoog*: de bron zegt zelf dat het adres
  erin staat (een letterlijke overeenkomst). Dat zegt iets over het adres, niet over elk gegeven dat bij
  het lek hoort.
  Een webresultaat is altijd een **mogelijke overeenkomst**, nooit meer. De app beoordeelt het met vaste
  regels, alleen op de titel en het fragment dat de zoekdienst gaf (de pagina zelf lezen we niet):

  | Wat er in de titel of het fragment staat | Wat de pagina zegt |
  |---|---|
  | Het bevestigde e-mailadres van je account, als geheel adres | *Sterke overeenkomst* |
  | Je volledige naam én je woonplaats | *Mogelijke overeenkomst* |
  | Je volledige naam zonder woonplaats, of alle delen van je naam los van elkaar | *Zwakke overeenkomst* |
  | Je naam niet | *Geen overeenkomst in titel of fragment* |

  Een naam met een woonplaats is dus niet meer dan *Mogelijk*: een naamgenoot in dezelfde plaats komt voor.
  Een demo-resultaat heet *Demo (verzonnen)*.

**Jouw oordeel staat los van onze beoordeling.** Onder elk webresultaat staat apart wat jij ervan vindt:
*Nog niet beoordeeld*, *Door jou bevestigd: dit ben jij*, *Door jou afgewezen: niet van jou* of
*Je weet het (nog) niet*. Pas bij bevestigd door jou beschouwt de app een resultaat als van jou.

**Gemaskeerde gegevens.** Staat er in de titel of het fragment van een webresultaat iets wat op een
telefoonnummer, e-mailadres of postcode lijkt, dan toont de pagina dat apart en gemaskeerd, bijvoorbeeld
`+31 6 •••• 5678`, `a•••@example.com` of `35•• AB`, met erbij of het e-mailadres van je account is. Het
fragment zelf tonen we ongewijzigd, zoals de zoekdienst het gaf. De maskering is een samenvatting van wat er
volgens ons in staat, geen verbergen van de brontekst. Het is een gok op het uiterlijk (datums, KvK-nummers
en rekeningnummers worden niet voor een nummer aangezien, maar fouten kunnen er zijn), en niets ervan wordt
bewaard: het wordt bij elke weergave opnieuw uit de tekst gehaald. Daarnaast staat er een voorzichtige
inschatting van het soort site (*sociale media*, *mogelijke personenzoeksite of telefoongids*,
*openbaar document*), gebaseerd op het adres en een korte lijst bekende sites. Een site die niet op de lijst
staat, is niet "veilig".

Zekerheid is geen bewijs: ook bij *Sterke overeenkomst* kan het een toeval zijn. Daarom blijft het
oordeel "Dit ben ik" altijd aan jou.

**Het bronnenregister (`/bronnen`).** Eén pagina die laat zien welke bronnen de scanner gebruikt of gaat
gebruiken (datalekken, gelekte wachtwoorden, webzoekdienst, databrokers, sociale media, openbare
documenten, darkweb), met per bron de stand: *Actief*, *Alleen testadressen*, *Demo (nepdata)*, *Niet
ingesteld*, *Uit* of *Gepland*. Het register verzint niets: een bron die niet bestaat, staat er als "Gepland" en nooit als
"Actief". De pagina toont ook de zes fases.

**E-mailadres bevestigen.** Na het registreren krijg je een mail met een link. De link brengt je naar
een pagina met een knop, en pas die knop bevestigt. Zo niet, dan zou een mailprogramma dat links
automatisch opent om ze te controleren de link al gebruiken voordat jij erop klikt. De code in de
link is willekeurig (32 bytes), staat in de database alleen als hash, is 30 minuten geldig en
werkt één keer. Vraag je een nieuwe mail aan, dan werken oudere links niet meer. Zoeken kan pas na
bevestiging: zo weten we dat er echt iemand achter het adres zit.

**Waar de gegevens vandaan komen.** De app kent twee bronnen voor datalekken en kiest per adres:

| | Have I Been Pwned (HIBP) | XposedOrNot |
|---|---|---|
| Kosten | betaalde sleutel, ongeveer US$5,29 per maand (opzegbaar) | gratis, geen sleutel |
| Grenzen | ongeveer 10 aanvragen per minuut | 25 per uur en 100 per dag, voor de hele site |
| Bedoeld voor | ook een openbare site | persoonlijk gebruik en weinig verkeer |
| Instelling | `HIBP_API_KEY` | `FREE_BREACH_CHECK` (standaard aan op je eigen computer, online uit) |

Heb je een eigen HIBP-sleutel, dan gaat elk adres naar HIBP. Anders gaan de testadressen van HIBP
(`@hibp-integration-tests.com`) nog steeds naar HIBP, en elk ander adres naar XposedOrNot, als de
gratis controle aanstaat. Bij elk resultaat staat welke bron het was. HIBP-gegevens vallen onder
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), dus daar staat altijd een zichtbare
verwijzing naar haveibeenpwned.com bij.

Zo werkt XposedOrNot (`xon.js`): `/v1/check-email/{adres}` geeft alleen de **namen** van de lekken.
Voor de datum, het aantal accounts en de soorten gegevens gebruiken we hun lijst met alle lekken
(`/v1/breaches`), die we één keer per dag ophalen en in het geheugen houden. Die lijst bevat nooit een
adres. Staat een lek erin als gevoelig, of als niet doorzoekbaar, dan tonen we het niet. Alleen een
lek dat uitdrukkelijk "niet gevoelig" heet, mag getoond worden; is de vlag weg of vreemd, dan tonen we
het niet. Een lek dat niet in de lijst staat, tonen we ook niet: als we niet weten wat het is, tonen
we het niet. Kunnen we de lijst niet ophalen of gebruiken (bijvoorbeeld omdat XposedOrNot hun
formaat verandert en de vlag "sensitive" ontbreekt), dan krijgt de bezoeker een foutmelding en staat
er in de terminal wat er mis was. Dat is bewust: "geen lek gevonden" zeggen terwijl we het niet
kunnen controleren, zou een leugen zijn. De limiet van de gratis dienst geldt voor de hele site
samen, dus bij een 429 zegt de app dat de grens bereikt is.

**Let op:** de koppelingen met XposedOrNot en Brave Search zijn gebouwd naar hun gepubliceerde beschrijving
en getest met nagebootste antwoorden, maar nog niet tegen de echte diensten geprobeerd (de omgeving waarin
de app gebouwd is, kan er niet bij). Probeer ze met `npm run controleer`, en met je eigen adres:
`npm run controleer -- jij@voorbeeld.nl`. Gaat er iets mis, dan zegt het script wat er was; de site zelf
toont een korte melding en zet in de terminal wat er was.

**Datalekken (dashboard).** Vanaf het dashboard gaat alleen het bevestigde adres van je eigen account
naar de bron. Er is op het dashboard geen veld waarin je een ander adres kunt typen, en een
adres dat je zelf meestuurt wordt genegeerd. (Een ander adres controleren kan op de openbare pagina,
hieronder.) Dat een adres niet gevonden wordt, is geen garantie dat het nooit gelekt is: niet elk lek
is bekend, en de app zegt dat ook. Met een gewone HIBP-sleutel mag je ongeveer 10 aanvragen
per minuut doen; de app wacht daarom even tussen aanvragen, en vraagt je het anders straks nog eens
te proberen. Bij elk bewaard resultaat staat de bron, zodat de bronvermelding klopt, ook als je later
van bron wisselt.

**De openbare e-mailcontrole.** Op de startpagina (`/`, en `/controle`) kan iedereen een e-mailadres
intypen, ook zonder account en ook het adres van iemand anders. Dat doet Have I Been Pwned zelf ook,
en het is verantwoord omdat het antwoord klein blijft:

- Je ziet alleen de **naam** van elk lek, de datum, het aantal accounts en welke **soorten** gegevens
  er gelekt zijn, met bij elk lek de bron, de datum van de controle en de zekerheid. Nooit de gegevens
  zelf, en niets over wie achter het adres zit.
- **Gevoelige lekken** (zoals die van datingsites) tonen we nooit. HIBP houdt ze zelf al uit dit
  antwoord; wij filteren er voor de zekerheid ook op. Bij XposedOrNot filteren we op hun vlaggen
  `sensitive` en `searchable` (zie hierboven).
- Het adres wordt **nergens bewaard**: niet in de database, niet in een logboek, niet in de URL (het
  formulier gebruikt POST, een `?email=` in de adresbalk wordt genegeerd) en niet in de cache van de
  browser (`Cache-Control: no-store`). Er blijft alleen een teller over met een hash van het IP-adres.
  Ook het "Research Engine"-paneel op die pagina wordt berekend uit wat je op dat moment ziet, en niets
  daarvan wordt bewaard.
- Er is **geen zoekvak voor namen**. Zoeken op het web blijft beperkt tot je eigen account (zie boven).

Per IP-adres zijn er maximaal 10 controles per uur (`checkLimit` in `app.js`), dus één bezoeker kan de
25 per uur van de gratis dienst niet in zijn eentje opmaken. Een typfout of een storing bij de
bron telt niet mee. De limiet geldt per IP-adres en nooit per ingetypt adres, anders zou
het adres in de tellers terechtkomen. Is er geen bron voor een adres (geen `HIBP_API_KEY` en
`FREE_BREACH_CHECK=off`), dan werken alleen de testadressen van HIBP en staat er op de pagina een
melding "Testmodus".

**Op het web.** De zoekopdracht wordt altijd gemaakt van de naam (en woonplaats) van je account,
bijvoorbeeld `"Anna de Vries" "Utrecht"`, en nooit van een formulierveld. Naam én woonplaats staan
tussen aanhalingstekens en zoekoperatoren (`OR`, `-`, `site:`) worden eruit gehaald. Anders zou
een "woonplaats" als `OR Jan Jansen` een tweede zoekterm worden, en kon je via je profiel toch de
naam van iemand anders laten opzoeken. Wat een zoekdienst teruggeeft wordt opgeschoond: geen
HTML, alleen `http(s)`-adressen zonder wachtwoord, geen dubbelen, hooguit 20 stuks. Alles wat van
buiten komt, wordt als gewone tekst getoond.

Een webresultaat blijft bij Brave maximaal 30 minuten staan (zie "Echt op het web zoeken"). De resultaten
hebben daarom een einddatum (`expires_at`): daarna tonen en tellen we ze niet meer, en elke minuut wist de
server ze echt. Bij het starten krijgt ook wat nog zonder einddatum van een eerdere instelling stond er
alsnog een. Zoek je opnieuw en komt een resultaat terug, dan loopt de termijn weer vanaf nu.

**Online alleen de beheerder.** Op een openbare site (`NODE_ENV=production`) staat zoeken op naam
voor gebruikers uit, want een bevestigd e-mailadres bewijst niet dat de naam van die gebruiker is.
Met `OWNER_EMAIL` wijs je één account aan dat het wel mag: het account met precies dat adres
(hoofdletters maken niet uit), mits dat adres bevestigd is. Een bijna gelijk adres, zoals
`anna+x@example.com`, telt niet, en een account dat nog niet bevestigd is ook niet. Dit is
**vertrouwen en geen bewijs**: de site gelooft dat de naam op dat account de jouwe is. Voor andere
gebruikers blijft alles uit, en hun naam gaat nooit naar een zoekdienst. In de Deep Scan staat die
stap dan als "Overgeslagen", met de reden erbij. Op je eigen computer (zonder `production`) maakt de
instelling niets uit: wie erbij kan, mag zoeken.

**Jij beslist.** Bij elk webresultaat kies je *Dit ben ik*, *Dit ben ik niet* of *Weet ik niet*. Veel
resultaten zijn van naamgenoten. De app raadt niets, ook niet "op de gok". Je keuze blijft staan als
je opnieuw zoekt, en de volgorde verandert er niet door. Bij een zoekdienst die bewaren niet toestaat
blijft je keuze als vingerafdruk van het adres bestaan, ook als het resultaat zelf al weg is.

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
  dan is het geen moderne browser en wordt het verzoek geweigerd. Dat geldt ook voor
  zoeken, voor de Deep Scan en voor je keuze bij een resultaat.
- **Alleen van jezelf:** elk resultaat en elk rapport hoort bij één account. Een id van iemand anders (of
  van een datalek) kun je niet beoordelen, en je ziet alleen je eigen resultaten.
- **Openbare controle:** formulieren van andere websites worden geweigerd (CSRF), zodat andere sites
  jouw aanvragen bij HIBP of XposedOrNot niet kunnen gebruiken. Fouten van de bron geven een korte
  vaste melding zonder woorden als `.env`; wat de beheerder moet weten (bijvoorbeeld een geweigerde
  sleutel, of een antwoord in een onverwacht formaat) staat alleen in de terminal, nooit met een
  e-mailadres erbij. Een link uit de gegevens van XposedOrNot nemen we alleen over als het een
  `https`-link is.
- **Wachtwoorden raden en misbruik:** na 10 mislukte inlogpogingen per IP-adres, of 5 per
  account, volgt een pauze van een kwartier. Nieuwe bevestigingsmails (3 per uur) en
  zoekopdrachten (5 per uur, voor datalekken en web elk apart; de Deep Scan telt voor allebei)
  hebben een eigen grens per account. De openbare controle heeft er een per IP-adres (10 per uur).
  De tellers staan gehasht in de database, dus een herstart zet ze niet op nul. Keerzijde: wie je
  e-mailadres kent, kan je account zo een kwartier blokkeren; daarom duurt de pauze niet langer.
- **Geen hints voor aanvallers:** bij een fout e-mailadres en een fout wachtwoord zie
  je dezelfde melding, en het antwoord duurt even lang.
- **Links in mails** worden gemaakt van `BASE_URL` en nooit van de `Host`-header van een verzoek. Anders
  kan iemand met een verzonnen header een mail laten versturen met een link naar zijn eigen site.
- **Meldingen zonder details:** een fout van Have I Been Pwned, XposedOrNot of een zoekdienst laat je
  alleen een korte, vaste tekst zien, ook in het rapport van de Deep Scan. Sleutels en technische
  berichten komen nergens op een pagina.
- **Sleutels en zoekopdrachten staan in geen logboek.** De Brave-sleutel gaat alleen in een header naar
  Brave (nooit in een URL, een pagina of een logregel), de koppeling volgt geen omleidingen en heeft een
  tijdslimiet. De zoekopdracht bevat je naam en woonplaats en wordt niet gelogd, ook niet bij een fout.
  De tests controleren dit voor elke soort fout.
- **De beheerpagina** (`/beheerder`) controleert bij elk verzoek of je het bevestigde account met `OWNER_EMAIL`
  bent. Voor ieder ander bestaat de pagina niet (404), ook de formulieren niet. De knoppen werken met dezelfde
  CSRF-controle als de rest van de site, de pagina komt niet in de cache van de browser (`no-store`), en elke
  actie van de beheerder komt in het systeemlog. Een geblokkeerd account kan niet inloggen, en een sessie van
  dat account werkt meteen niet meer. Je kunt je eigen account niet blokkeren. Testknoppen: 20 per uur.
  Nog niet gedaan: tweestapsverificatie. Wie jouw wachtwoord heeft, komt nu op de beheerpagina.
- **Het systeemlog** bevat alleen vaste meldingen. De details zijn getallen en woorden uit vaste lijsten; al het
  andere gooit de code weg, voordat er iets wordt opgeslagen. De tests proberen er een e-mailadres, naam,
  zoekopdracht, webadres en sleutel in te krijgen, en controleren dat dat niet lukt.
- **Helmet** zet veilige HTTP-headers, zoals een Content-Security-Policy.
- De server is standaard **alleen bereikbaar vanaf je eigen computer**, en het testpostvak
  (`/dev/mails`) bestaat alleen buiten `production` en alleen voor verzoeken van die computer zelf.

## Privacy

- Gebruikers kunnen **hun account verwijderen** via het dashboard. Dat wist hun naam,
  e-mailadres, woonplaats, wachtwoord-hash, sessies, bevestigingslinks, gevonden datalekken en
  webresultaten, hun keuzes, hun scans en het rapport van hun laatste Deep Scan in één keer. Dat werkt
  omdat elke tabel met gebruikersgegevens `ON DELETE CASCADE` heeft. Geef nieuwe tabellen dat ook, dan
  blijft het zo. (Dit is het enige wat de app verwijdert: je eigen gegevens bij Privacyscan, op jouw verzoek.)
- **Webresultaten** (titel, adres, fragment) blijven bij Brave maximaal 30 minuten bewaard, en worden dan
  gewist. Van jouw keuze per resultaat blijft een vingerafdruk van het adres over (een SHA-256-code),
  met je keuze en het moment waarop je koos. Geen adres, geen titel, geen tekst. Een account verwijderen
  wist ook die keuzes.
- Het **rapport van de Deep Scan** bewaart per stap een status en een korte tekst, en per soort
  blootgestelde gegevens de namen van de lekken. Geen gelekte gegevens, want die hebben we nooit. Er
  wordt alleen het laatste rapport bewaard.
- De **privacyverklaring** staat op `/privacy`. Vul `CONTACT_NAME` en `CONTACT_EMAIL`
  in je `.env` in voordat je de site online zet. De tekst past zich aan op de instellingen:
  met `production` staat er dat zoeken op naam uit staat (of dat alleen de beheerder zoekt, als je
  `OWNER_EMAIL` hebt ingesteld), zonder zoekdienst dat er niet op het web gezocht wordt, bij de demo
  dat er niets naar buiten gaat, en met een echte zoekdienst staat er welke dienst je naam als
  zoekopdracht krijgt en, als die dienst bewaren niet toestaat, dat webresultaten maar 30 minuten
  blijven staan en wat er van je keuzes bewaard blijft. Ook de openbare controle staat erin: dat het
  adres naar HIBP of XposedOrNot gaat en niet bewaard wordt, en dat bij elke bevinding de bron, de
  datum en de zekerheid staan. Werk hem bij zodra de app meer gegevens verwerkt, bijvoorbeeld bij
  automatisch opnieuw zoeken. De tekst over de wettelijke grondslag is een concept: laat hem
  controleren voordat je de site openbaar maakt.
- De **beheerpagina** toont per account het nummer, het e-mailadres, de datums, of het bevestigd of
  geblokkeerd is en wanneer er gezocht is (met de aantallen). Geen namen, woonplaatsen, zoekopdrachten of
  bevindingen: die heeft de beheerder niet nodig. Het **systeemlog** heeft geen persoonsgegevens (alleen het
  nummer van een account als de beheerder het blokkeert of deblokkeert, of als een geblokkeerd account probeert
  in te loggen) en blijft 30 dagen. De **tellers van het verbruik** zijn alleen aantallen per dienst per dag. De
  privacyverklaring zegt dit allemaal onder "Wat de beheerder ziet".
- De **openbare e-mailcontrole** bewaart niets over het adres dat iemand intypt: niet in de
  database, niet in een logboek en niet in de URL. Het adres gaat wel naar de bron (Have I Been Pwned
  of XposedOrNot, anders is er niets om te controleren), en de privacyverklaring noemt de bron die
  jouw instellingen echt gebruiken. Van de bezoeker bewaren we
  alleen een teller per IP-adres (als hash, hooguit een uur), tegen misbruik.

## Bewust (nog) niet gedaan

- **Gegevens van het internet verwijderen en verwijderverzoeken sturen (AVG, artikel 17).** Dit is geen
  ontbrekende functie maar een uitgangspunt: de app zoekt en toont. Hij verwijdert niets bij anderen en
  stuurt geen verzoeken. Alleen je eigen account bij Privacyscan kun je wissen (zie "Privacy").
- **Onderzoek naar iemand anders, ook met toestemming.** Dat bestaat niet. De app zoekt alleen op het
  bevestigde adres en de naam van je eigen account. Onderzoek met toestemming van een ander kan pas als
  die toestemming echt gecontroleerd kan worden, met een identiteitscheck van beiden.
- **Een identiteitscheck.** Een bevestigd e-mailadres bewijst niet dat de naam in het account van
  jou is: de naam typ je zelf in bij het registreren, en hij is nu niet te wijzigen. Op je eigen
  computer is dat jouw verantwoordelijkheid (zoek alleen naar jezelf). Op een openbare site is het
  een gat, want iedereen zou de naam van een ander kunnen laten opzoeken. Daarom staat **zoeken op
  naam uit zodra `NODE_ENV=production` is**, en bestaat de woonplaats-pagina dan ook niet, behalve
  voor de beheerder (`OWNER_EMAIL`, zie "Later online zetten"). Voor iedereen aanzetten kan pas
  met een echte controle, zoals iDIN of een ID-scan met selfie.
- **Een tweede zoekdienst.** Er is Brave Search, en de demo. Lees voor je een andere koppelt eerst hun
  voorwaarden, zoals hierboven bij Brave: mag je resultaten bewaren, en mag je ze voor AI gebruiken? Leg in
  `search.js` een nieuwe dienst naast `createBraveSearch()`: met `retainsResults: false` (of zonder dat
  veld) behandelt de app hem als een dienst die bewaren niet toestaat. Bewaren moet een dienst dus
  uitdrukkelijk toestaan.
- **De achtergrondscanner.** Een scan loopt nu terwijl je wacht. Een echte scanner met een wachtrij,
  voortgang per stap, aparte onderzoeksprocessen en een herstart die een lopende klus niet kwijtraakt,
  staat als volgende stap gepland.
- **Databrokers, gericht zoeken op sociale media en openbare documenten, en darkweb.** De databrokers
  hebben een eigen onderzoeksstap nodig; de rest staat als "Gepland" in het bronnenregister. Er is niets
  gebouwd wat doet alsof het werkt. Voor het darkweb komt er geen eigen crawler en kopen of bewaren
  we geen gestolen gegevens: alleen via een aanbieder die dit legaal en geautoriseerd levert.
- **Een AI-agent (fase 5).** Komt er een, dan geldt dezelfde regel als nu: geen bevinding zonder
  controleerbare bron, datum en zekerheid. De agent mag onderzoek plannen, samenvatten en beoordelen,
  maar niets verzinnen, en bronnen die niet toegankelijk waren, moeten genoemd worden.
- **Doorlopende monitoring (fase 6).** Automatisch opnieuw scannen met een mail bij iets nieuws. Eerst
  is er een echte bron nodig om steeds opnieuw te bevragen.
- **De betaalde dienst van XposedOrNot (xonAPI+).** Die heeft hogere limieten en is bedoeld voor
  producten die op hun gegevens bouwen. De koppeling bestaat nog niet; de gratis dienst is genoeg
  voor persoonlijk gebruik.
- **Bescherming tegen bots op de openbare controle.** Nu houdt alleen de limiet per IP-adres
  misbruik tegen. Voor een druk bezochte site hoort er een bot-controle bij, bijvoorbeeld Cloudflare
  Turnstile (zoals HIBP zelf).
- **Zoeken op telefoonnummer.** Een sms bevestigen is weinig waard als bewijs en kost geld, en er is
  niets wat we er veilig mee kunnen opzoeken.
- **Zelf lekgegevens verzamelen.** De app gebruikt alleen bestaande diensten (Have I Been Pwned en
  XposedOrNot). Er komt geen eigen verzameling van gelekte wachtwoorden of andere gestolen gegevens.
- **Foto's zoeken en gezichtsherkenning.** Bewust niet.
- **Wachtwoord vergeten.** Dat kan nu technisch (de app kan mailen) maar is nog niet gebouwd.
- Bij registreren zie je of een e-mailadres al een account heeft. Dat kan nu netter, want we kunnen
  mailen: altijd "kijk in je mail" zeggen, en het bestaande account een mail sturen. Staat nog open.
- Resultaten die een zoekdienst bij een volgende keer niet meer teruggeeft, blijven staan, zodat je
  keuzes niet verdwijnen. Een scan die ze opruimt komt bij fase 4.

## Later online zetten

- Zet `NODE_ENV=production`. Cookies gaan dan alleen nog over https, dus zorg dat
  de site via https bereikbaar is, anders kun je niet inloggen. De server weigert te starten
  zonder `SMTP_URL` (zonder echte mailserver kan niemand zijn adres bevestigen) en zonder een
  https-`BASE_URL`.
- Zoeken op naam staat dan uit voor iedereen (zie hierboven). Voor de **openbare controle** op de
  startpagina heb je een betaalde `HIBP_API_KEY` nodig. De gratis dienst XposedOrNot staat online
  **standaard uit**, want die is bedoeld voor persoonlijk gebruik en weinig verkeer (25 controles per
  uur voor de hele site). Wil je hem online toch gebruiken, voor een kleine site, zet dan bewust
  `FREE_BREACH_CHECK=on`; de privacyverklaring noemt hem dan. Zonder sleutel en zonder gratis
  dienst werken online alleen de testadressen, en dat staat er ook bij. Met de gewone HIBP-sleutel
  (Core 1) mag je ongeveer 10 aanvragen per minuut doen. Alle bezoekers delen die ruimte; bij drukte
  wacht de app even en vraagt de bezoeker daarna het later nog eens te proberen. Houd de kosten in de
  gaten (de sleutel is een maandabonnement dat je kunt opzeggen) en laat de bronvermelding bij de
  resultaten staan: voor HIBP is dat een voorwaarde van het gebruik van hun gegevens.
- **Wil je zelf wel op naam kunnen zoeken?** Zet in `.env` `OWNER_EMAIL=jouw@adres.nl`, registreer
  je met precies dat adres, bevestig het via de mail en herstart de server. Doe dat voordat je de
  site aan anderen laat zien: gebruikt iemand anders dat adres eerder om te registreren, dan kan
  die het niet bevestigen (en dus niet zoeken), maar jij kunt je dan niet meer met dat adres
  registreren. Het is vertrouwen en geen bewijs: de naam typ je zelf in bij het registreren en de
  site gelooft dat hij van jou is. Zet je een typfout in `OWNER_EMAIL`, dan start de server niet.
- Zet `HOST=0.0.0.0` (en eventueel `PORT`) zodat de server van buitenaf bereikbaar is.
- Draait hij achter een proxy, zoals Caddy, zet dan in `app.js`
  `app.set('trust proxy', 1)`. Dan zien de tellers het echte IP-adres van de bezoeker. Doe je dat
  niet, dan lijken alle bezoekers van het IP-adres van de proxy te komen en delen ze samen één
  teller: na 10 controles per uur kan dan niemand meer controleren.
- Een openbare controle trekt bots aan. Zet er voor je de site echt openbaar maakt een bot-controle
  voor (zie "Bewust (nog) niet gedaan").
- De pagina `/bronnen` is voor iedereen te lezen en toont welke bronnen bij jouw instellingen aanstaan
  (bijvoorbeeld of er een HIBP-sleutel is). Dat is bedoeld, maar weet dat het zichtbaar is. Er staan
  geen sleutels of persoonsgegevens op.
- **Database:** `node:sqlite` is in Node 22 nog experimenteel (vandaar de
  `--disable-warning` in `package.json`), en vanaf Node 24.15 een "release candidate".
  Voor een site die echt online gaat, is `better-sqlite3` de beproefde keuze. De code
  daarvoor is bijna gelijk; alleen `db.js` verandert.

## Werkwijze

- Commit per stap, met een boodschap die zegt wat er verandert.
- GitHub Actions draait bij elke push naar `main` en bij elke pull request
  `npm test`, op Node 22 en 24. Je ziet het resultaat onder het tabblad **Actions**.

## Volgende stappen

De app zoekt en toont. Dit zijn de logische vervolgstappen, in de volgorde die ik zou kiezen. Begin
pas aan een stap als je hem echt wilt.

- **De echte diensten proberen**: `npm run controleer` met je eigen Brave-sleutel en je eigen e-mailadres,
  zodat die koppelingen ook tegen de echte diensten getest zijn. Dit kost vrijwel niets (één zoekopdracht en
  twee aanvragen) en is de snelste manier om te zien of het echt werkt.
- **Een wachtwoordcontrole-pagina**, zoals pwnedpasswords bij Have I Been Pwned. Het wachtwoord wordt
  in de browser tot een hash gemaakt, en alleen de eerste 5 tekens daarvan gaan naar de dienst
  (k-anonimiteit). Het wachtwoord zelf verlaat de browser nooit. Dit werkt echt, zonder betaalde
  sleutel; `pwned.js` doet hetzelfde al bij het registreren.
- **Tweestapsverificatie voor de beheerder** (een code uit een app als Microsoft Authenticator), voordat de site
  openbaar gaat: nu komt iedereen met jouw wachtwoord op de beheerpagina.
- **Een achtergrondscanner met voortgang**: een wachtrij van klussen, een proces dat ze afwerkt, voortgang per
  stap die je op de pagina en op de beheerpagina ziet, en herstel na een herstart van de server. Daarna gericht
  zoeken naar bekende databrokersites (met de zoekdienst, alleen vinden en tonen) en naar sociale media en
  openbare documenten.
- **Pagina's zelf onderzoeken**: alleen bij bronnen waar dat mag, en met de afwegingen die daarbij horen (de
  voorwaarden van de site, robots.txt, wat je bewaart).
- **Een identiteitscontrole** (bijvoorbeeld iDIN of een ID-scan) voordat zoeken op naam voor andere
  gebruikers opengaat.
- **Een toestemmingsprocedure voor onderzoek naar iemand anders**, pas ná de identiteitscontrole.
- **Automatisch opnieuw zoeken** met een mail als er iets nieuws is (fase 6).
- **Een bot-controle** (bijvoorbeeld Cloudflare Turnstile) op de openbare controle, `trust proxy` en een
  gecontroleerde privacyverklaring, voor je de site online zet.
- **Een AI-agent** (fase 5), pas als de onderzoeksfuncties zelf echt werken en gecontroleerd zijn. Let op
  de voorwaarden van Brave: hun resultaten mogen niet gebruikt worden om AI-modellen te trainen, te
  beoordelen of te verbeteren. Een agent die onderzoek plant, kan daarom niet zomaar op Brave-resultaten
  getraind of geëvalueerd worden.

## Bronnen

- [Have I Been Pwned API v3](https://haveibeenpwned.com/API/v3): aanroepen, testadressen, limieten en voorwaarden.
- [XposedOrNot API](https://xposedornot.com/api_doc): de gratis bron, met de aanroepen, antwoorden en limieten
  (2 per seconde, 25 per uur, 100 per dag per IP-adres), en
  [XposedOrNot-API op GitHub](https://github.com/XposedOrNot/XposedOrNot-API) voor de voorwaarden
  ("voor persoonlijk gebruik en weinig verkeer").
- [Brave Search API: limieten](https://api-dashboard.search.brave.com/documentation/guides/rate-limiting): de headers
  `X-RateLimit-Limit`, `-Policy`, `-Remaining` en `-Reset` die de beheerpagina leest, en dat alleen geslaagde
  aanvragen meetellen en betaald worden.
- [Brave Search API](https://brave.com/search/api): de actuele prijzen, en de
  [voorwaarden](https://api-dashboard.search.brave.com/terms-of-service): niet bewaren (3(b)(i)), geen afgeleide
  werken (3(b)(ii)), geen AI-training of -beoordeling (3(b)(xiii)), "Powered by Brave" tonen is optioneel (4(d)).
