// Zoeken op het web naar je eigen naam. De zoekterm wordt altijd gemaakt van de
// naam van het ingelogde account (en de woonplaats uit het profiel). Er is nergens
// een vak waarin je iets anders kunt intypen, en dat is bewust zo: een open
// zoekbalk werkt net zo goed voor een ex of een stalker als voor jezelf.
import { createThrottle } from './hibp.js';
import { ScanError } from './scan-error.js';
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
// Een zoekdienst heeft één functie: search({ query, name, city }) geeft een lijst met
// { title, url, snippet }, en gooit een ScanError als het niet lukt. Daarnaast heeft hij:
//
//   id              het korte nummer van de dienst ('brave', 'demo'), ook in de database
//   label           de naam voor in de pagina's
//   url             de website van de dienst, of null
//   isDemo          verzint de dienst alles? (alleen de demo)
//   retainsResults  mogen we de resultaten bewaren? Bij Brave niet, tenzij je een abonnement met
//                   opslagrechten hebt (zie hieronder).

// De demo verzint resultaten, zodat de tests en ontwikkelaars de hele werking kunnen zien zonder
// sleutel, kosten of echte gegevens. Hij staat nergens standaard aan: alleen met
// SEARCH_PROVIDER=demo. Er wordt niets naar buiten gestuurd. De adressen horen bij example.org,
// example.net en example.com: domeinen die bestaan om in voorbeelden te gebruiken.
export function createDemoSearch() {
  return {
    id: 'demo',
    name: 'demo',
    label: 'Demo-zoekdienst (nepdata)',
    url: null,
    isDemo: true,
    retainsResults: true,
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

// --- Brave Search ------------------------------------------------------------------
// De echte zoekdienst: de Brave Search API (api.search.brave.com). Voor een sleutel heb je een
// account met een betaalmiddel nodig; je krijgt elke maand een tegoed (zie de README).
//
// Let op de voorwaarden van Brave:
//   - Resultaten bewaren of een database ervan maken mag niet, behalve tijdelijke opslag die de
//     toepassing nodig heeft om te werken. Daarom bewaart deze app ze maximaal een half uur en
//     bewaart hij van jouw keuzes alleen een hash van het adres (zie findings.js). Heb je een
//     abonnement met opslagrechten, zet dan BRAVE_STORAGE_RIGHTS=on.
//   - Je naam en woonplaats gaan als zoekopdracht naar Brave. De privacyverklaring zegt dat.
//   - De sleutel blijft in .env: hij komt nooit in een pagina, een logboek of een foutmelding.
const BRAVE_URL = 'https://api.search.brave.com/res/v1/web/search';
const BRAVE_USER_AGENT = 'Privacyscan (zoekt de eigen naam van de gebruiker op het web)';

// Haalt uit het antwoord van Brave de lijst { title, url, snippet }. Brave laat het onderdeel
// "web" weg als er niets gevonden is; dat is geen fout. Is het antwoord iets anders dan een
// zoekantwoord, dan is het wel een fout: "niets gevonden" zeggen terwijl we het antwoord niet
// begrijpen, zou een leugen zijn.
function braveResults(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new ScanError('unexpected');
  if (data.web === undefined) {
    if (data.type === 'search' || (data.query && typeof data.query === 'object')) return [];
    throw new ScanError('unexpected');
  }
  const { web } = data;
  if (!web || typeof web !== 'object' || Array.isArray(web)) throw new ScanError('unexpected');
  if (web.results === undefined) return [];
  if (!Array.isArray(web.results)) throw new ScanError('unexpected');
  return web.results.map((item) => ({ title: item?.title, url: item?.url, snippet: item?.description }));
}

export function createBraveSearch({
  apiKey,
  fetchImpl = fetch,        // de tests vervangen deze, zodat ze niets echt versturen
  baseUrl = BRAVE_URL,
  country = 'NL',           // wat Brave als "land" gebruikt om de volgorde te bepalen
  retainsResults = false,   // zie hierboven: alleen true met een abonnement met opslagrechten
  minIntervalMs = 1100,     // Brave begrenst het aantal aanvragen per seconde
  maxWaitMs = 20000,
  timeoutMs = 10000,
  log = console.error,
} = {}) {
  const key = String(apiKey ?? '').trim();
  if (!key) throw new Error('Voor Brave Search is een sleutel nodig. Zet BRAVE_API_KEY in je .env (zie de README).');
  // Een sleutel is één stuk tekst van letters, cijfers en een paar tekens, zonder spaties,
  // aanhalingstekens of regeleinden. Zo kan een slordig geplakte waarde niet in een header terechtkomen.
  if (!/^[A-Za-z0-9._~+/=-]{8,200}$/.test(key)) {
    throw new Error('BRAVE_API_KEY ziet er niet goed uit: een sleutel heeft geen spaties of aanhalingstekens. Plak hem opnieuw in je .env.');
  }
  const throttle = createThrottle(minIntervalMs, maxWaitMs);

  return {
    id: 'brave',
    name: 'brave',
    label: 'Brave Search',
    url: 'https://search.brave.com',
    isDemo: false,
    retainsResults,
    // Er komt nooit iets van de zoekopdracht, de naam of de sleutel in de logregels: alleen wat
    // de beheerder moet weten om de fout te vinden.
    async search({ query }) {
      await throttle();

      const url = new URL(baseUrl);
      url.search = new URLSearchParams({
        q: query,
        count: '20',
        country,
        safesearch: 'moderate',
        text_decorations: 'false',
      }).toString();

      let response;
      try {
        response = await fetchImpl(url, {
          headers: { 'X-Subscription-Token': key, Accept: 'application/json', 'User-Agent': BRAVE_USER_AGENT },
          signal: AbortSignal.timeout(timeoutMs),
          redirect: 'error',
        });
      } catch {
        throw new ScanError('unavailable');
      }

      if (response.status === 401 || response.status === 403) {
        log('Brave Search weigerde de sleutel. Controleer BRAVE_API_KEY in je .env.');
        throw new ScanError('bad_key');
      }
      if (response.status === 402 || response.status === 429) {
        log('Brave Search staat nu geen aanvragen meer toe: de limiet of het tegoed is op.');
        throw new ScanError('rate_limited');
      }
      if (response.status >= 500) throw new ScanError('unavailable');
      if (!response.ok) {
        log(`Brave Search gaf onverwacht antwoord (HTTP ${response.status}).`);
        throw new ScanError('unexpected');
      }

      let data;
      try {
        data = await response.json();
      } catch {
        log('Brave Search gaf geen leesbaar antwoord.');
        throw new ScanError('unexpected');
      }
      return braveResults(data);
    },
  };
}

// Kiest de zoekdienst uit de instellingen. Geeft null als er geen is: dan zegt de app eerlijk
// dat er niet gezocht kan worden, en verzint hij niets.
//   SEARCH_PROVIDER leeg  Brave als er een sleutel is, anders geen
//   brave                 Brave (de sleutel is verplicht)
//   demo                  de nepdata van de demo, alleen om uit te proberen
//   none                  geen zoekdienst
export function createSearch(provider = '', { braveKey = '', storageRights = false, fetchImpl } = {}) {
  const wanted = String(provider ?? '').trim().toLowerCase();
  if (wanted === 'demo') return createDemoSearch();
  if (wanted === 'none') return null;
  if (wanted === 'brave' || (wanted === '' && String(braveKey).trim() !== '')) {
    return createBraveSearch({
      apiKey: braveKey,
      retainsResults: storageRights,
      ...(fetchImpl ? { fetchImpl } : {}),
    });
  }
  if (wanted === '') return null;
  throw new Error(`Onbekende zoekdienst "${provider}". Kies "brave", "demo" of "none", of laat SEARCH_PROVIDER leeg.`);
}

// Leest BRAVE_STORAGE_RIGHTS uit .env. Alleen "on" als je bij Brave een abonnement hebt dat het
// bewaren van resultaten toestaat. Leeg of "off": resultaten blijven maximaal een half uur staan.
// Een typfout stopt de server liever dan dat de app stilletjes resultaten gaat bewaren.
export function parseStorageRights(value) {
  const text = String(value ?? '').trim().toLowerCase();
  if (text === '' || ['off', 'false', '0', 'uit', 'no', 'nee'].includes(text)) return false;
  if (['on', 'true', '1', 'aan', 'yes', 'ja'].includes(text)) return true;
  throw new Error('BRAVE_STORAGE_RIGHTS moet "on" of "off" zijn (of leeg). Controleer je .env.');
}
