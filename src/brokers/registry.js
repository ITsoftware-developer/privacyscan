// Het register van de Data Broker Engine: welke databrokers en online telefoongidsen de site kent, wat
// ze volgens hun eigen omschrijving verwerken, in welke landen, en hoe wij ze mogen onderzoeken.
//
// Alles hieronder is nagekeken op 26 november 2026, met de bron erbij (`source`). Wat we niet hebben
// kunnen nakijken, staat er niet in. Een site die hier niet staat, is niet "veilig": dit is een korte,
// voorzichtige lijst.
//
// Hoe we zoeken (`access`):
//   search   via de zoekdienst, met een site:-zoekopdracht op je eigen naam (zie broker-scan.js). We
//            openen de site van de databroker zelf niet en gebruiken hun eigen zoekfunctie niet.
//   closed   afgeschermd: geen openbare pagina's om te doorzoeken. Wat zo'n bedrijf over je heeft, weet
//            je alleen via een geautoriseerde gegevensdienst of met een inzageverzoek (AVG art. 15).
export const CHECKED = '2026-11-26';

export const BROKERS = [
  {
    id: 'detelefoongids',
    name: 'De Telefoongids',
    domain: 'detelefoongids.nl',
    countries: ['Nederland'],
    kind: 'Telefoongids',
    data: ['naam', 'adres', 'telefoonnummer'],
    about: 'Toont naam, adres en telefoonnummer van mensen die via hun telecomaanbieder in de gids staan (uitgever: Youvia).',
    access: 'search',
    source: 'https://youvia.nl/media/dr5evzot/2024-16-05-privacy-verklaring-detelefoongids_final-20240418-003.pdf',
  },
  {
    id: 'telefoonboek',
    name: 'Telefoonboek.nl',
    domain: 'telefoonboek.nl',
    countries: ['Nederland'],
    kind: 'Telefoongids',
    data: ['naam', 'telefoonnummer', 'adres'],
    about: 'Zoeken naar personen, op adres en omgekeerd op telefoonnummer; je kunt je eigen vermelding claimen.',
    access: 'search',
    source: 'https://www.telefoonboek.nl/personen/',
  },
  {
    id: 'dasoertliche',
    name: 'Das Örtliche',
    domain: 'dasoertliche.de',
    countries: ['Duitsland'],
    kind: 'Telefoongids',
    data: ['naam', 'adres', 'telefoonnummer', 'e-mailadres'],
    about: 'Personensuche en Rückwärtssuche (van nummer naar naam en adres), voor wie zijn gegevens heeft laten opnemen.',
    access: 'search',
    source: 'https://www.dasoertliche.de/personensuche/',
  },
  {
    id: 'dastelefonbuch',
    name: 'Das Telefonbuch',
    domain: 'dastelefonbuch.de',
    countries: ['Duitsland'],
    kind: 'Telefoongids',
    data: ['naam', 'adres', 'telefoonnummer'],
    about: 'Telefoongids met Rückwärtssuche voor vaste en mobiele nummers.',
    access: 'search',
    source: 'https://www.dastelefonbuch.de/R%C3%BCckw%C3%A4rts-Suche',
  },
  {
    id: '11880',
    name: '11880.com',
    domain: '11880.com',
    countries: ['Duitsland'],
    kind: 'Telefoongids',
    data: ['naam', 'adres', 'telefoonnummer'],
    about: 'Telefoon- en bedrijvengids met personensuche en een gratis Rückwärtssuche (naam en adres bij een nummer).',
    access: 'search',
    source: 'https://www.11880.com/rueckwaertssuche/0',
  },
  {
    id: '192',
    name: '192.com',
    domain: '192.com',
    countries: ['Verenigd Koninkrijk'],
    kind: 'Personenzoeksite',
    data: ['naam', 'adres', 'telefoonnummer', 'kiezersregister', 'bestuursfuncties'],
    about: 'Britse personenzoeksite met adressen, telefoonnummers, het openbare kiezersregister (sinds 2002) en bestuurders uit Companies House. Uitgebreide gegevens kosten credits.',
    access: 'search',
    source: 'https://192.com/info/about-us/',
  },
  {
    id: 'spokeo',
    name: 'Spokeo',
    domain: 'spokeo.com',
    countries: ['Verenigde Staten'],
    kind: 'Personenzoeksite',
    data: ['naam', 'adres', 'telefoonnummer', 'e-mailadres', 'sociale media', 'familieleden', 'leeftijd'],
    about: 'Zoeken op naam, telefoon, adres, e-mail of gebruikersnaam. Op naam, telefoon en adres alleen voor mensen in de VS; op e-mail en gebruikersnaam wereldwijd.',
    access: 'search',
    source: 'https://ca.trustpilot.com/review/www.spokeo.com?page=9',
  },
  {
    id: 'whitepages',
    name: 'Whitepages',
    domain: 'whitepages.com',
    countries: ['Verenigde Staten'],
    kind: 'Personenzoeksite',
    data: ['naam', 'adres', 'telefoonnummer', 'e-mailadres', 'werk'],
    about: 'Zoeken op naam, telefoon, adres of e-mail, met omgekeerd zoeken; uitgebreide gegevens zijn betaald.',
    access: 'search',
    source: 'https://apps.apple.com/us/app/id287734809',
  },
  {
    id: 'truepeoplesearch',
    name: 'TruePeopleSearch',
    domain: 'truepeoplesearch.com',
    countries: ['Verenigde Staten'],
    kind: 'Personenzoeksite',
    data: ['naam', 'adresgeschiedenis', 'telefoonnummer', 'familieleden'],
    about: 'Gratis Amerikaanse personenzoeksite met omgekeerd zoeken (van telefoon naar naam, van adres naar bewoner).',
    access: 'search',
    source: 'https://redact.dev/data-brokers/truepeoplesearch-com',
  },
  {
    id: 'fastpeoplesearch',
    name: 'FastPeopleSearch',
    domain: 'fastpeoplesearch.com',
    countries: ['Verenigde Staten'],
    kind: 'Personenzoeksite',
    data: ['naam', 'adres', 'telefoonnummer'],
    about: 'Gratis Amerikaanse personenzoeksite: zoeken op naam, adres of telefoonnummer.',
    access: 'search',
    source: 'https://beebom.com/best-people-search-engines',
  },
  {
    id: 'radaris',
    name: 'Radaris',
    domain: 'radaris.com',
    countries: ['Verenigde Staten'],
    kind: 'Personenzoeksite',
    data: ['naam', 'adresgeschiedenis', 'telefoonnummer', 'e-mailadres', 'domeinnamen'],
    about: 'Netwerk van personenzoeksites met huidige en vorige adressen, telefoonnummers, e-mailadressen en domeinnamen.',
    access: 'search',
    source: 'https://krebsonsecurity.com/2024/03/a-close-up-look-at-the-consumer-data-broker-radaris/',
  },
  {
    id: 'thatsthem',
    name: 'ThatsThem',
    domain: 'thatsthem.com',
    countries: ['Verenigde Staten'],
    kind: 'Personenzoeksite',
    data: ['naam', 'adres', 'telefoonnummer', 'e-mailadres', 'IP-adres', 'voertuig'],
    about: 'Amerikaanse personenzoeksite; zoeken op naam, adres, telefoon, e-mail, IP-adres of kenteken (VIN).',
    access: 'search',
    source: 'https://www.optery.com/data-brokers/thatsthem/',
  },
  {
    id: 'beenverified',
    name: 'BeenVerified',
    domain: 'beenverified.com',
    countries: ['Verenigde Staten'],
    kind: 'Personenzoeksite',
    data: ['naam', 'adres', 'telefoonnummer', 'e-mailadres', 'sociale media', 'strafblad'],
    about: 'Amerikaanse personenzoeksite op basis van openbare registers; zoeken op naam, telefoon, e-mail of adres.',
    access: 'search',
    source: 'https://seon.io/resources/comparisons/pipl-alternatives-competitors',
  },
  {
    id: 'peekyou',
    name: 'PeekYou',
    domain: 'peekyou.com',
    countries: ['Verenigde Staten'],
    kind: 'Personenzoeksite',
    data: ['naam', 'sociale media', 'nieuws', 'websites'],
    about: 'Bundelt informatie van sociale media, nieuwssites, homepages en blogs tot een online profiel.',
    access: 'search',
    source: 'https://www.cbinsights.com/company/peekyou',
  },
  {
    id: 'pipl',
    name: 'Pipl',
    domain: 'pipl.com',
    countries: ['Wereldwijd'],
    kind: 'Identiteitsdata voor bedrijven',
    data: ['naam', 'e-mailadres', 'telefoonnummer', 'adres', 'sociale media', 'werk'],
    about: 'Verkoopt identiteitsgegevens via een betaalde API aan bedrijven (fraude- en identiteitscontrole). Geen openbare zoekpagina.',
    access: 'closed',
    source: 'https://pipl.com/product/pipl-search-api',
  },
];

const byDomain = new Map(BROKERS.map((broker) => [broker.domain, broker]));

export function brokerById(id) {
  return BROKERS.find((broker) => broker.id === id) ?? null;
}

// Bij welke databroker hoort dit adres? Ook subdomeinen (www., nl.) tellen mee.
export function brokerForUrl(url) {
  let host;
  try {
    host = new URL(String(url)).hostname.toLowerCase();
  } catch {
    return null;
  }
  for (;;) {
    if (byDomain.has(host)) return byDomain.get(host);
    const dot = host.indexOf('.');
    if (dot === -1) return null;
    host = host.slice(dot + 1);
  }
}

// De databrokers waar we met een zoekopdracht naar kunnen zoeken, in groepjes per zoekopdracht. Eén
// zoekopdracht per groep (site:a OR site:b ...) houdt het aantal betaalde aanvragen laag. Europa en de
// VS apart, zodat de beste resultaten van de ene groep die van de andere niet wegdrukken.
export function searchGroups(maxPerGroup = 8) {
  const searchable = BROKERS.filter((broker) => broker.access === 'search');
  const europe = searchable.filter((broker) => !broker.countries.includes('Verenigde Staten'));
  const rest = searchable.filter((broker) => broker.countries.includes('Verenigde Staten'));
  const groups = [];
  for (const list of [europe, rest]) {
    for (let i = 0; i < list.length; i += maxPerGroup) groups.push(list.slice(i, i + maxPerGroup));
  }
  return groups;
}
