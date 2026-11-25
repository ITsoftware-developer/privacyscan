// Zoeken op het web naar je eigen naam. De zoekterm wordt altijd gemaakt van de
// naam van het ingelogde account (en de woonplaats uit het profiel). Er is nergens
// een vak waarin je iets anders kunt intypen, en dat is bewust zo: een open
// zoekbalk werkt net zo goed voor een ex of een stalker als voor jezelf.
import { plainText } from './text.js';

// Maakt een naam of woonplaats geschikt voor een zoekopdracht: alleen letters,
// spaties, apostrofs, punten en streepjes. Zo kan niemand er aanhalingstekens of
// zoekoperatoren (zoals "-woord" of "site:") in smokkelen.
export function cleanName(value, max = 80) {
  return String(value ?? '')
    .normalize('NFC')
    .replace(/[^\p{L}\p{M}\s'’.-]/gu, ' ')
    .replace(/(^|\s)[-.]+/g, '$1') // een streepje aan het begin van een woord sluit dat woord uit
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .trim();
}

// De zoekopdracht, bijvoorbeeld: "Anna de Vries" "Utrecht". Naam én woonplaats
// staan tussen aanhalingstekens, zodat de zoekdienst op die hele woorden zoekt en
// alles wat erin staat gewoon tekst blijft. Zonder aanhalingstekens rond de
// woonplaats zou een "woonplaats" als OR Jan Jansen een tweede zoekterm worden, en
// dan kon je via je profiel toch de naam van iemand anders laten opzoeken.
// Geeft null als er te weinig letters in de naam zitten om zinvol op te zoeken.
export function buildQuery({ name, city }) {
  const who = cleanName(name);
  if (who.replace(/[^\p{L}]/gu, '').length < 2) return null;
  const where = cleanName(city, 60);
  return `"${who}"${where ? ` "${where}"` : ''}`;
}

// Controleert de woonplaats uit het formulier. Geeft { city } (null als leeg)
// of { error }.
export function parseCity(input) {
  const text = String(input ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();
  if (text === '') return { city: null };
  if (text.length > 60 || !/^[\p{L}\p{M}'’][\p{L}\p{M}\s'’.-]*$/u.test(text)) {
    return { error: 'Gebruik voor je woonplaats alleen letters, spaties, apostrofs en streepjes (maximaal 60 tekens).' };
  }
  return { city: text };
}

// --- Resultaten opschonen ------------------------------------------------------

// Alleen gewone web-adressen. Geen javascript:, data: of adressen met een
// wachtwoord erin, en geen absurd lange adressen.
function safeUrl(value) {
  try {
    const url = new URL(String(value));
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (url.username || url.password) return null;
    return url.href.length <= 2000 ? url.href : null;
  } catch {
    return null;
  }
}

// Maakt van wat een zoekdienst teruggeeft een nette lijst { title, url, snippet }:
// zonder HTML, zonder gevaarlijke of dubbele adressen, hooguit `max` stuks.
export function cleanResults(results, max = 20) {
  const seen = new Set();
  const clean = [];
  for (const raw of Array.isArray(results) ? results : []) {
    const url = safeUrl(raw?.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    clean.push({
      title: plainText(raw.title, 200) || url,
      url,
      snippet: plainText(raw.snippet, 400),
    });
    if (clean.length === max) break;
  }
  return clean;
}

// --- Zoekdiensten ----------------------------------------------------------------
// Een zoekdienst heeft één functie: search({ query, name, city }) geeft een lijst
// met { title, url, snippet }. Een echte dienst (zoals Brave Search of Google) komt
// hier later bij. Lees eerst hun voorwaarden: sommige verbieden het bewaren van
// resultaten, en dat doen we wel.

// De demo-dienst verzint resultaten, zodat je de hele werking kunt zien zonder
// sleutel, kosten of echte gegevens. Er wordt niets naar buiten gestuurd. De
// adressen horen bij example.org, example.net en example.com: domeinen die
// bestaan om in voorbeelden te gebruiken.
export function createDemoSearch() {
  return {
    name: 'demo',
    isDemo: true,
    async search({ name, city }) {
      const where = city ? ` in ${city}` : '';
      return [
        {
          title: `${name} – lid van een oud forum`,
          url: 'https://example.org/voorbeeld/forum',
          snippet: 'Voorbeeldresultaat met nepdata: een profiel dat sinds 2012 niet meer is gebruikt.',
        },
        {
          title: `${name}${where} – online telefoongids`,
          url: 'https://example.net/voorbeeld/telefoongids',
          snippet: 'Voorbeeldresultaat met nepdata: naam, adres en telefoonnummer in een openbare gids.',
        },
        {
          title: `Uitslagen van een sportclub met ${name}`,
          url: 'https://example.com/voorbeeld/sportclub',
          snippet: 'Voorbeeldresultaat met nepdata: een wedstrijdverslag waarin de naam voorkomt.',
        },
        {
          title: `Een andere ${name} (naamgenoot)`,
          url: 'https://example.org/voorbeeld/naamgenoot',
          snippet: 'Voorbeeldresultaat met nepdata: iemand anders met dezelfde naam. Dit ben jij waarschijnlijk niet.',
        },
        {
          title: `${name} – profiel bij een datahandelaar`,
          url: 'https://example.net/voorbeeld/datahandelaar',
          snippet: 'Voorbeeldresultaat met nepdata: leeftijd, woonplaats en familieleden, verzameld uit andere bronnen.',
        },
      ];
    },
  };
}

// Kiest de zoekdienst uit de instelling SEARCH_PROVIDER.
export function createSearch(provider = 'demo') {
  if (provider === 'demo') return createDemoSearch();
  throw new Error(`Onbekende zoekdienst "${provider}". Op dit moment bestaat alleen "demo".`);
}
