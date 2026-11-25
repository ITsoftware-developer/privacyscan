// Praat met XposedOrNot (xposedornot.com): een gratis dienst die, net als Have I Been
// Pwned, laat zien in welke bekende datalekken een e-mailadres voorkomt. Er is geen
// sleutel nodig, zodat echte adressen ook werken zonder betaald abonnement.
// Handleiding: https://xposedornot.com/api_doc
//
// Let op de grenzen van de gratis dienst (per IP-adres, per soort aanvraag):
//   - 2 aanvragen per seconde, 25 per uur en 100 per dag;
//   - volgens de makers bedoeld voor "persoonlijk gebruik en weinig verkeer". Voor een
//     drukke openbare site hoort een HIBP-sleutel of hun betaalde abonnement (xonAPI+).
//
// Zo werkt het:
//   1. /v1/check-email/{adres} geeft alleen de NAMEN van de lekken waarin het adres zat.
//   2. /v1/breaches is de lijst van alle lekken, met datum, aantal accounts, soorten
//      gegevens en de vlaggen "sensitive" en "searchable". Die lijst halen we een keer per
//      dag op en houden we in het geheugen. Het adres zit daar nooit in.
//   3. Daarmee maken we per lek dezelfde kleine gegevens als bij HIBP. Gevoelige lekken
//      (en lekken die zelf niet doorzoekbaar heten) laten we hier al weg, en lekken die we
//      niet in de lijst kunnen vinden ook: als we niet weten wat het is, tonen we het niet.
import { createThrottle } from './hibp.js';
import { ScanError } from './scan-error.js';
import { plainText } from './text.js';

const BASE_URL = 'https://api.xposedornot.com';

// De dienst vraagt om een user-agent die zegt wat voor programma er aanklopt.
const USER_AGENT = 'Privacyscan (controle of een e-mailadres in bekende datalekken staat)';

const LIST_TTL_MS = 24 * 60 * 60 * 1000;   // de lijst met lekken vernieuwen we elke dag
const REFRESH_AFTER_MS = 15 * 60 * 1000;   // komt er een onbekend lek voorbij, dan hooguit zo vaak
const RETRY_AFTER_FAILURE_MS = 5 * 60 * 1000;
const MAX_NAMES = 200;

// Alleen een echte https-link nemen we over (geen javascript: of data:).
function httpsUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === 'https:' ? url.href.slice(0, 500) : null;
  } catch {
    return null;
  }
}

// Maakt van een lek uit de lijst van XposedOrNot hetzelfde kleine object als bij HIBP
// (zie normalizeBreach in hibp.js). Alles wat we niet gebruiken laten we weg, en alle
// tekst gaat door plainText.
export function normalizeXonBreach(raw) {
  if (typeof raw?.breachID !== 'string' || raw.breachID.trim() === '') return null;
  const day = typeof raw.breachedDate === 'string' ? raw.breachedDate.slice(0, 10) : '';
  return {
    name: raw.breachID.trim().slice(0, 100),
    title: plainText(raw.breachID, 120),
    domain: plainText(raw.domain, 100),
    breachDate: /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null,
    pwnCount: Number.isFinite(raw.exposedRecords) ? raw.exposedRecords : null,
    dataClasses: Array.isArray(raw.exposedData)
      ? raw.exposedData.filter((item) => typeof item === 'string').slice(0, 40).map((item) => plainText(item, 60))
      : [],
    description: plainText(raw.exposureDescription, 400),
    // Alleen een lek dat uitdrukkelijk "niet gevoelig" heet, mag getoond worden. Weten we
    // het niet (de vlag ontbreekt of is vreemd), dan tonen we het niet. Hetzelfde geldt
    // voor een lek dat XposedOrNot zelf niet doorzoekbaar noemt.
    isSensitive: raw.sensitive !== false || raw.searchable === false,
    source: 'xon',
    url: httpsUrl(raw.referenceURL),
  };
}

// De namen uit het antwoord op /v1/check-email. Het antwoord ziet er zo uit:
// { "breaches": [["Adobe", "LinkedIn"]], "email": "...", "status": "success" }.
// Geeft null als het antwoord er niet uitziet zoals verwacht.
function namesFrom(data) {
  if (!data || typeof data !== 'object') return null;
  if (typeof data.Error === 'string' && /not found/i.test(data.Error)) return [];
  if (data.breaches === null) return [];
  if (!Array.isArray(data.breaches)) return null;
  const names = data.breaches.flat(2)
    .filter((item) => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean);
  return [...new Set(names)].slice(0, MAX_NAMES);
}

export function createXon({
  fetchImpl = fetch,          // de tests vervangen deze, zodat ze niets echt versturen
  baseUrl = BASE_URL,
  minIntervalMs = 600,        // de dienst staat 2 aanvragen per seconde toe
  maxWaitMs = 5000,
  timeoutMs = 10000,
  listTimeoutMs = 30000,      // de lijst met alle lekken is groot
  now = () => Date.now(),
  log = console.error,        // voor de beheerder, nooit met een e-mailadres erin
} = {}) {
  const throttle = createThrottle(minIntervalMs, maxWaitMs);

  // Doet een aanvraag en geeft de JSON terug. `what` is alleen voor in het logboek en
  // bevat dus nooit een e-mailadres.
  async function getJson(path, { what, timeout }) {
    await throttle();

    let response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        headers: { accept: 'application/json', 'user-agent': USER_AGENT },
        signal: AbortSignal.timeout(timeout),
      });
    } catch {
      throw new ScanError('unavailable'); // geen internet, of de dienst reageert niet op tijd
    }

    if (response.status === 404) return { notFound: true };
    if (response.status === 429) throw new ScanError('rate_limited');
    if (response.status >= 500) throw new ScanError('unavailable');
    if (response.status !== 200) {
      log(`XposedOrNot gaf HTTP ${response.status} op ${what}.`);
      throw new ScanError('unexpected');
    }

    try {
      return { data: await response.json() };
    } catch {
      log(`XposedOrNot gaf geen leesbare JSON op ${what}.`);
      throw new ScanError('unexpected');
    }
  }

  // De lijst met alle lekken, per naam (kleine letters). Eén keer per dag vernieuwd.
  let list = null;      // { byName: Map, loadedAt }
  let retryAt = 0;      // na een mislukte vernieuwing niet meteen weer proberen
  let loading = null;   // loopt er al een aanvraag, dan wachten we daarop

  async function loadList({ force = false } = {}) {
    const at = now();
    if (list && !force && at - list.loadedAt < LIST_TTL_MS) return list;
    if (list && at < retryAt) return list;
    if (loading) return loading;

    loading = (async () => {
      try {
        const { data, notFound } = await getJson('/v1/breaches', { what: '/v1/breaches', timeout: listTimeoutMs });
        if (notFound || !Array.isArray(data?.exposedBreaches)) {
          const keys = data && typeof data === 'object' ? Object.keys(data).slice(0, 10).join(', ') : typeof data;
          log(`XposedOrNot: de lijst met lekken had een onverwacht formaat (velden: ${keys || 'geen'}).`);
          throw new ScanError('unexpected');
        }
        const byName = new Map();
        let withFlag = 0;
        for (const raw of data.exposedBreaches) {
          const breach = normalizeXonBreach(raw);
          if (!breach) continue;
          byName.set(breach.name.toLowerCase(), breach);
          if (typeof raw.sensitive === 'boolean') withFlag += 1;
        }
        // Een lijst zonder lekken, of zonder de vlag "sensitive", kunnen we niet gebruiken: dan
        // weten we niet welke lekken we mogen tonen, en zou "geen lek gevonden" een leugen zijn.
        if (byName.size === 0 || withFlag < byName.size / 2) {
          log(`XposedOrNot: de lijst met lekken is niet bruikbaar (${byName.size} lekken, waarvan ${withFlag} met de vlag "sensitive").`);
          throw new ScanError('unexpected');
        }
        list = { byName, loadedAt: now() };
        return list;
      } catch (error) {
        // Liever een oudere lijst dan een fout, en dan een tijdje niet opnieuw proberen.
        if (list) {
          retryAt = now() + RETRY_AFTER_FAILURE_MS;
          return list;
        }
        throw error;
      } finally {
        loading = null;
      }
    })();
    return loading;
  }

  return {
    // Hoeveel lekken staan er in de lijst van XposedOrNot? Voor `npm run controleer`: zo weten we
    // ook dat de lijst te lezen is als het adres dat je controleert in geen enkel lek staat (de
    // lijst halen we anders alleen op als er iets gevonden is).
    async listSize() {
      return (await loadList()).byName.size;
    },

    // Geeft de datalekken waarin dit adres voorkomt (een lege lijst als het nergens in
    // staat). Gevoelige lekken zitten hier nooit bij.
    async breachesFor(email) {
      const answer = await getJson(`/v1/check-email/${encodeURIComponent(email)}`, {
        what: '/v1/check-email',
        timeout: timeoutMs,
      });
      if (answer.notFound) return [];

      const names = namesFrom(answer.data);
      if (names === null) {
        const keys = answer.data && typeof answer.data === 'object'
          ? Object.keys(answer.data).slice(0, 10).join(', ')
          : typeof answer.data;
        log(`XposedOrNot: het antwoord op /v1/check-email had een onverwacht formaat (velden: ${keys || 'geen'}).`);
        throw new ScanError('unexpected');
      }
      if (names.length === 0) return [];

      let current = await loadList();
      const unknown = () => names.filter((name) => !current.byName.has(name.toLowerCase()));

      // Een lek dat nog niet in onze lijst staat: misschien is het net toegevoegd.
      if (unknown().length > 0 && now() - current.loadedAt > REFRESH_AFTER_MS) {
        current = await loadList({ force: true });
      }

      // Een lek dat we ook na vernieuwen niet in de lijst vinden, tonen we niet. Voor de
      // beheerder: zonder het adres en zonder de naam van het lek.
      const missing = unknown().length;
      if (missing > 0) log(`XposedOrNot noemde ${missing} lek(ken) die niet in hun lijst staan; die tonen we niet.`);

      // Elk lek maar één keer ("Adobe" en "adobe" zijn hetzelfde lek).
      const seen = new Set();
      return names
        .map((name) => current.byName.get(name.toLowerCase()))
        .filter((breach) => {
          if (!breach || breach.isSensitive || seen.has(breach.name)) return false;
          seen.add(breach.name);
          return true;
        });
    },
  };
}
