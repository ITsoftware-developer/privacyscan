# Privacyscan: datalekken controleren en je eigen gegevens opzoeken

Je eigen privacy-tool, stap voor stap gebouwd. De app **zoekt en toont**; hij verwijdert niets
en stuurt geen verzoeken naar anderen.

- **Fase 1** (klaar): een account maken, inloggen, uitloggen, je account verwijderen en een dashboard.
- **Fase 2** (klaar): je e-mailadres bevestigen, kijken of dat adres in een bekend **datalek** staat
  (Have I Been Pwned), en **op het web zoeken naar je eigen naam**. Per resultaat kies je:
  *Dit ben ik*, *Dit ben ik niet* of *Weet ik niet*, zodat je overzicht houdt tussen naamgenoten.
- **Openbare e-mailcontrole**: op de startpagina kan iedereen een e-mailadres controleren,
  zonder account, zoals bij Have I Been Pwned zelf. Je ziet alleen in welke bekende lekken het adres
  zat, en het adres wordt nergens bewaard. **Werkt voor echte adressen, gratis, via XposedOrNot**
  (of via Have I Been Pwned als je daar een sleutel voor hebt).
- Nog te doen: een echte zoekdienst voor het web, een wachtwoordcontrole-pagina, en automatisch
  opnieuw zoeken met een mail (zie "Volgende stappen"). Verwijderverzoeken zijn bewust geschrapt.

**Uitgangspunten:** test alleen op jezelf en op nepdata, zoek alleen naar je eigen naam, en laat
foto's zoeken en gezichtsherkenning weg. De openbare controle laat alleen zien *in welk lek* een
adres zat, nooit de gelekte gegevens, en is geen manier om mensen op naam op te zoeken.

## Wat heb je nodig

- **Node.js 22.13 of nieuwer.** Download de LTS-versie via [nodejs.org](https://nodejs.org).
- Verder niets: de database (SQLite) zit al in Node.js ingebouwd, en mails komen standaard in een
  testpostvak in de app zelf.
- Echte e-mailadressen controleren werkt direct, zonder sleutel, via de gratis dienst
  [XposedOrNot](https://xposedornot.com) (25 controles per uur, voor persoonlijk gebruik).
- Later, als je meer wilt: een [HIBP-sleutel](https://haveibeenpwned.com/API/Key) (betaald) en
  eventueel Mailpit (een nep-mailserver).

## Starten

Open een terminal in deze map en typ:

```
npm install
npm start
```

Ga daarna naar **http://localhost:3000**.

Kom je uit fase 1? Draai dan eerst `npm install` (er is een pakket bijgekomen: `nodemailer`).
De database wordt bij het starten vanzelf bijgewerkt; je account en gegevens blijven staan.

### Proberen met nepdata (begin hier)

**De openbare controle (zonder account).** Ga naar http://localhost:3000, typ een e-mailadres en
klik op *Controleer*. Op je eigen computer werken **echte adressen** direct, zonder sleutel: de app
vraagt het aan de gratis dienst XposedOrNot (zie "Waar de gegevens vandaan komen"). Wil je liever
testen met nepdata? Typ dan **`multiple-breaches@hibp-integration-tests.com`**: dat is een testadres
van Have I Been Pwned en geeft drie (verzonnen) lekken. Probeer ook
`account-exists@hibp-integration-tests.com` (één lek) en `not-active-breach@hibp-integration-tests.com`
(geen lek, dus "goed nieuws"). Zet je de gratis dienst uit (`FREE_BREACH_CHECK=off`) en heb je geen
HIBP-sleutel, dan werken alleen die testadressen en zegt de pagina dat eerlijk ("Testmodus").

**Met een account.**

1. Maak een account met als e-mailadres **`multiple-breaches@hibp-integration-tests.com`**.
   Dat is een testadres van Have I Been Pwned; het werkt zonder betaalde sleutel en geeft drie
   (verzonnen) datalekken terug. Andere testadressen: `account-exists@…` (één datalek) en
   `not-active-breach@…` (geen datalekken, dan zie je het "goed nieuws"-bericht). Allemaal op
   `@hibp-integration-tests.com`.
2. De bevestigingsmail komt in het **testpostvak**: http://localhost:3000/dev/mails (alleen
   bereikbaar vanaf je eigen computer). Open de mail, klik op de link en dan op de knop
   "Ja, dit is mijn e-mailadres".
3. Op je dashboard: **Zoek in datalekken**. Bekijk de resultaten, met bronvermelding.
4. Vul eventueel een woonplaats in ("Woonplaats toevoegen" op het dashboard) en kies
   **Zoek op het web**. Dat is voorlopig een **demo**: vijf verzonnen resultaten op
   `example.org/net/com`, er gaat niets naar buiten. Kies per resultaat of het jou is.

Met een betaalde `HIBP_API_KEY` gaat elk adres naar Have I Been Pwned in plaats van naar XposedOrNot.
Is er geen bron beschikbaar voor een adres, dan zegt de app dat eerlijk in plaats van iets te verzinnen.

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
| `SEARCH_PROVIDER`  | `demo`                      | Zoekdienst voor het web. Nu bestaat alleen `demo` (nepdata)                                   |
| `OWNER_EMAIL`      | leeg                        | Online: de beheerder, die als enige op naam mag zoeken (zie "Later online zetten")            |

| Commando                | Wat het doet                                                      |
|-------------------------|-------------------------------------------------------------------|
| `npm start`             | Start de site                                                     |
| `npm run dev`           | Start de site en herstart automatisch als je een bestand wijzigt  |
| `npm test`              | Draait alle tests (240 stuks, een paar seconden)                  |
| `npm run test:coverage` | Draait de tests en laat zien welke regels code ze niet raken      |

Alle gegevens staan in `data/privacyscan.db`. Gooi je die map weg, dan begin je opnieuw.

## Hoe het in elkaar zit

```
src/
  server.js         start de webserver en leest de instellingen
  app.js            bouwt de app op: beveiligingsheaders, cookies, routes
  routes-public.js  de startpagina en de openbare e-mailcontrole (zonder account)
  routes.js         de pagina's van fase 1: registreren, inloggen, account verwijderen, privacy
  routes-scan.js    de pagina's van fase 2: dashboard, bevestigen, zoekgegevens, zoeken, resultaten
  auth.js           wachtwoorden hashen, sessies en de CSRF-check
  confirm.js        e-mailadres bevestigen: tokens, geldigheid en de bevestigingsmail
  email.js          de regels voor e-mailadressen (netjes maken, controleren), op één plek
  owner.js          de beheerder (OWNER_EMAIL): wie online op naam mag zoeken
  mail.js           mail versturen (SMTP) of in het testpostvak zetten
  hibp.js           praat met Have I Been Pwned (datalekken van een e-mailadres)
  xon.js            praat met XposedOrNot, de gratis bron (zonder sleutel, met een lage limiet)
  breach-check.js   kiest per adres welke van die twee bronnen zoekt, en leest FREE_BREACH_CHECK
  sources.js        de namen en websites van de bronnen, voor de bronvermelding
  data-classes.js   Nederlandse namen voor de soorten gelekte gegevens ("Passwords" wordt "Wachtwoorden")
  search.js         de zoekopdracht opbouwen, resultaten opschonen, de demo-zoekdienst
  scans.js          het eigenlijke zoeken: vraag het aan een dienst, bewaar wat terugkomt
  findings.js       resultaten en je keuzes bewaren en lezen
  scan-error.js     de fouten die een scan kan geven, zonder technische details
  text.js           tekst van buiten (HTML eruit halen, inkorten)
  limit-store.js    bewaart de tellers tegen misbruik in de database
  pwned.js          checkt of een wachtwoord in een bekend datalek staat
  db.js             de database, de tabellen en het bijwerken van oudere databases
views/              de pagina's (HTML met EJS)
public/             de vormgeving (CSS)
test/               de tests
.github/workflows/  laat GitHub de tests draaien bij elke push
.env.example        voorbeeld van de instellingen
```

## Hoe het zoeken werkt

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
  er gelekt zijn. Nooit de gegevens zelf, en niets over wie achter het adres zit.
- **Gevoelige lekken** (zoals die van datingsites) tonen we nooit. HIBP houdt ze zelf al uit dit
  antwoord; wij filteren er voor de zekerheid ook op. Bij XposedOrNot filteren we op hun vlaggen
  `sensitive` en `searchable` (zie hierboven).
- Het adres wordt **nergens bewaard**: niet in de database, niet in een logboek, niet in de URL (het
  formulier gebruikt POST, een `?email=` in de adresbalk wordt genegeerd) en niet in de cache van de
  browser (`Cache-Control: no-store`). Er blijft alleen een teller over met een hash van het IP-adres.
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

**Online alleen de beheerder.** Op een openbare site (`NODE_ENV=production`) staat zoeken op naam
voor gebruikers uit, want een bevestigd e-mailadres bewijst niet dat de naam van die gebruiker is.
Met `OWNER_EMAIL` wijs je één account aan dat het wel mag: het account met precies dat adres
(hoofdletters maken niet uit), mits dat adres bevestigd is. Een bijna gelijk adres, zoals
`anna+x@example.com`, telt niet, en een account dat nog niet bevestigd is ook niet. Dit is
**vertrouwen en geen bewijs**: de site gelooft dat de naam op dat account de jouwe is. Voor andere
gebruikers blijft alles uit, en hun naam gaat nooit naar een zoekdienst. Op je eigen computer
(zonder `production`) maakt de instelling niets uit: wie erbij kan, mag zoeken.

**Jij beslist.** Bij elk webresultaat kies je *Dit ben ik*, *Dit ben ik niet* of *Weet ik niet*. Veel
resultaten zijn van naamgenoten. De app raadt niets, ook niet "op de gok". Je keuze blijft staan als
je opnieuw zoekt, en de volgorde verandert er niet door.

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
  zoeken en voor je keuze bij een resultaat.
- **Alleen van jezelf:** elk resultaat hoort bij één account. Een id van iemand anders (of van een
  datalek) kun je niet beoordelen, en je ziet alleen je eigen resultaten.
- **Openbare controle:** formulieren van andere websites worden geweigerd (CSRF), zodat andere sites
  jouw aanvragen bij HIBP of XposedOrNot niet kunnen gebruiken. Fouten van de bron geven een korte
  vaste melding zonder woorden als `.env`; wat de beheerder moet weten (bijvoorbeeld een geweigerde
  sleutel, of een antwoord in een onverwacht formaat) staat alleen in de terminal, nooit met een
  e-mailadres erbij. Een link uit de gegevens van XposedOrNot nemen we alleen over als het een
  `https`-link is.
- **Wachtwoorden raden en misbruik:** na 10 mislukte inlogpogingen per IP-adres, of 5 per
  account, volgt een pauze van een kwartier. Nieuwe bevestigingsmails (3 per uur) en
  zoekopdrachten (5 per uur, voor datalekken en web elk apart) hebben een eigen grens per account.
  De openbare controle heeft er een per IP-adres (10 per uur).
  De tellers staan gehasht in de database, dus een herstart zet ze niet op nul. Keerzijde: wie je
  e-mailadres kent, kan je account zo een kwartier blokkeren; daarom duurt de pauze niet langer.
- **Geen hints voor aanvallers:** bij een fout e-mailadres en een fout wachtwoord zie
  je dezelfde melding, en het antwoord duurt even lang.
- **Links in mails** worden gemaakt van `BASE_URL` en nooit van de `Host`-header van een verzoek. Anders
  kan iemand met een verzonnen header een mail laten versturen met een link naar zijn eigen site.
- **Meldingen zonder details:** een fout van Have I Been Pwned of een zoekdienst laat je alleen een
  korte, vaste tekst zien. Sleutels en technische berichten komen nergens op een pagina.
- **Helmet** zet veilige HTTP-headers, zoals een Content-Security-Policy.
- De server is standaard **alleen bereikbaar vanaf je eigen computer**, en het testpostvak
  (`/dev/mails`) bestaat alleen buiten `production` en alleen voor verzoeken van die computer zelf.

## Privacy

- Gebruikers kunnen **hun account verwijderen** via het dashboard. Dat wist hun naam,
  e-mailadres, woonplaats, wachtwoord-hash, sessies, bevestigingslinks, gevonden datalekken en
  webresultaten, hun keuzes en hun scans in één keer. Dat werkt omdat elke tabel met
  gebruikersgegevens `ON DELETE CASCADE` heeft. Geef nieuwe tabellen dat ook, dan blijft het zo.
- De **privacyverklaring** staat op `/privacy`. Vul `CONTACT_NAME` en `CONTACT_EMAIL`
  in je `.env` in voordat je de site online zet. De tekst past zich aan op de instellingen:
  met `production` staat er dat zoeken op naam uit staat (of dat alleen de beheerder zoekt, als je
  `OWNER_EMAIL` hebt ingesteld), bij de demo dat er niets naar buiten gaat, en met een echte
  zoekdienst staat er welke dienst de naam krijgt. Ook de openbare controle staat erin: dat het
  adres naar HIBP gaat en niet bewaard wordt. Werk hem bij zodra de app meer gegevens verwerkt,
  bijvoorbeeld bij automatisch opnieuw zoeken. De tekst over de wettelijke grondslag is een
  concept: laat hem controleren voordat je de site openbaar maakt.
- De **openbare e-mailcontrole** bewaart niets over het adres dat iemand intypt: niet in de
  database, niet in een logboek en niet in de URL. Het adres gaat wel naar de bron (Have I Been Pwned
  of XposedOrNot, anders is er niets om te controleren), en de privacyverklaring noemt de bron die
  jouw instellingen echt gebruiken. Van de bezoeker bewaren we
  alleen een teller per IP-adres (als hash, hooguit een uur), tegen misbruik.

## Bewust (nog) niet gedaan

- **Een identiteitscheck.** Een bevestigd e-mailadres bewijst niet dat de naam in het account van
  jou is: de naam typ je zelf in bij het registreren, en hij is nu niet te wijzigen. Op je eigen
  computer is dat jouw verantwoordelijkheid (zoek alleen naar jezelf). Op een openbare site is het
  een gat, want iedereen zou de naam van een ander kunnen laten opzoeken. Daarom staat **zoeken op
  naam uit zodra `NODE_ENV=production` is**, en bestaat de woonplaats-pagina dan ook niet, behalve
  voor de beheerder (`OWNER_EMAIL`, zie "Later online zetten"). Voor iedereen aanzetten kan pas
  met een echte controle, zoals iDIN of een ID-scan met selfie.
- **Een echte zoekdienst.** Er is alleen de demo. Lees voor je er een koppelt eerst hun voorwaarden:
  sommige verbieden het bewaren van resultaten (bij de Brave Search API is dat zo), en deze app
  bewaart ze nu wel, samen met je keuze "Dit ben ik". Met zo'n dienst moeten de resultaten dus live
  getoond worden, en bewaar je alleen je eigen beoordeling. Leg in `search.js` een nieuwe dienst
  naast `createDemoSearch()` en voeg hem toe aan `createSearch()`.
- **De betaalde dienst van XposedOrNot (xonAPI+).** Die heeft hogere limieten en is bedoeld voor
  producten die op hun gegevens bouwen. De koppeling bestaat nog niet; de gratis dienst is genoeg
  voor persoonlijk gebruik.
- **Bescherming tegen bots op de openbare controle.** Nu houdt alleen de limiet per IP-adres
  misbruik tegen. Voor een druk bezochte site hoort er een bot-controle bij, bijvoorbeeld Cloudflare
  Turnstile (zoals HIBP zelf).
- **Zoeken op telefoonnummer.** Een sms bevestigen is weinig waard als bewijs en kost geld, en er is
  niets wat we er veilig mee kunnen opzoeken.
- **Verwijderverzoeken (AVG, artikel 17).** Bewust geschrapt: de app zoekt en toont, en verwijdert
  niets.
- **Zelf lekgegevens verzamelen.** De app gebruikt alleen de bekende dienst Have I Been Pwned. Er
  komt geen eigen verzameling van gelekte wachtwoorden of andere gestolen gegevens.
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

- **Een wachtwoordcontrole-pagina**, zoals pwnedpasswords bij Have I Been Pwned. Het wachtwoord wordt
  in de browser tot een hash gemaakt, en alleen de eerste 5 tekens daarvan gaan naar de dienst
  (k-anonimiteit). Het wachtwoord zelf verlaat de browser nooit. Dit werkt echt, zonder betaalde
  sleutel; `pwned.js` doet hetzelfde al bij het registreren.
- **Een echte zoekdienst voor het web** (bijvoorbeeld de Brave Search API: ongeveer 1.000 zoekopdrachten
  per maand gratis tegoed, een betaalmiddel is nodig). Resultaten mogen daar niet bewaard worden,
  dus ze worden live getoond en alleen je beoordeling wordt bewaard. Alleen op je eigen naam, zoals nu.
- **Automatisch opnieuw zoeken** met een mail als er iets nieuws is.
- **Een bot-controle** (bijvoorbeeld Cloudflare Turnstile) op de openbare controle, voor je hem online zet.

## Bronnen

- [Have I Been Pwned API v3](https://haveibeenpwned.com/API/v3): aanroepen, testadressen, limieten en voorwaarden.
- [XposedOrNot API](https://xposedornot.com/api_doc): de gratis bron, met de aanroepen, antwoorden en limieten
  (2 per seconde, 25 per uur, 100 per dag per IP-adres), en
  [XposedOrNot-API op GitHub](https://github.com/XposedOrNot/XposedOrNot-API) voor de voorwaarden
  ("voor persoonlijk gebruik en weinig verkeer").
