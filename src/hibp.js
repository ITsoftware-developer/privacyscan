// Praat met Have I Been Pwned (HIBP): in welke datalekken zat dit e-mailadres?
// Handleiding: https://haveibeenpwned.com/API/v3
//
// Dit wordt op twee plekken gebruikt: voor het bevestigde adres van je eigen account
// (routes-scan.js) en voor de openbare controle op de startpagina, waar iedereen een
// adres mag intypen (routes-public.js). Dat laat HIBP zelf ook toe: je ziet alleen in
// welk lek een adres zat, nooit de gelekte gegevens.
import { ScanError } from './scan-error.js';
import { plainText } from './text.js';

const BASE_URL = 'https://haveibeenpwned.com/api/v3';

// De gratis testsleutel van HIBP. Hij werkt alleen voor testadressen op dit domein,
// zoals account-exists@hibp-integration-tests.com en multiple-breaches@...
export const TEST_KEY = '00000000000000000000000000000000';
export const TEST_DOMAIN = '@hibp-integration-tests.com';

const KEY_PATTERN = /^[0-9a-f]{32}$/i;

// HIBP eist een user-agent die eerlijk zegt wat voor programma er aanklopt.
const USER_AGENT = 'Privacyscan (controle of een e-mailadres in bekende datalekken staat)';

// Maakt van het antwoord van HIBP een schoon, klein object. Alles wat we niet
// gebruiken laten we weg, en alle tekst gaat door plainText (de beschrijving van
// HIBP bevat HTML met links).
export function normalizeBreach(raw) {
  if (typeof raw?.Name !== 'string' || raw.Name === '') return null;
  return {
    name: raw.Name.slice(0, 100),
    title: plainText(raw.Title || raw.Name, 120),
    domain: plainText(raw.Domain, 100),
    breachDate: /^\d{4}-\d{2}-\d{2}$/.test(raw.BreachDate) ? raw.BreachDate : null,
    pwnCount: Number.isFinite(raw.PwnCount) ? raw.PwnCount : null,
    dataClasses: Array.isArray(raw.DataClasses)
      ? raw.DataClasses.filter((item) => typeof item === 'string').slice(0, 40).map((item) => plainText(item, 60))
      : [],
    description: plainText(raw.Description, 400),
    // HIBP houdt gevoelige lekken (zoals die van datingsites) zelf al uit dit antwoord.
    // We bewaren de vlag toch, zodat de openbare pagina ze nooit kan tonen.
    isSensitive: raw.IsSensitive === true,
  };
}

// HIBP staat bij een gewone sleutel maar een beperkt aantal aanvragen per minuut
// toe. Deze wachtrij houdt minstens `minIntervalMs` tussen twee aanvragen, en
// zegt "druk" als iemand langer dan `maxWaitMs` zou moeten wachten.
export function createThrottle(minIntervalMs, maxWaitMs) {
  let nextFree = 0;
  return async function throttle() {
    const now = Date.now();
    const start = Math.max(now, nextFree);
    if (start - now > maxWaitMs) throw new ScanError('busy');
    nextFree = start + minIntervalMs;
    if (start > now) await new Promise((resolve) => setTimeout(resolve, start - now));
  };
}

export function createHibp({
  apiKey,                    // je eigen sleutel (HIBP_API_KEY); zonder sleutel alleen testadressen
  fetchImpl = fetch,         // de tests vervangen deze, zodat ze niets echt versturen
  baseUrl = BASE_URL,
  minIntervalMs = 6500,      // een gewone sleutel mag 10 aanvragen per minuut
  maxWaitMs = 15000,
  timeoutMs = 10000,
} = {}) {
  const throttle = createThrottle(minIntervalMs, maxWaitMs);

  function keyFor(email) {
    if (apiKey) return apiKey;
    return email.toLowerCase().endsWith(TEST_DOMAIN) ? TEST_KEY : null;
  }

  return {
    // Heeft de site een eigen sleutel? Zo niet, dan werken alleen de testadressen.
    hasKey: Boolean(apiKey),

    // Voor de beheerpagina: hoe de koppeling is ingesteld (nooit de sleutel zelf).
    settings: { minIntervalMs, timeoutMs },

    // Kunnen we voor dit adres zoeken? Zonder eigen sleutel alleen voor testadressen.
    hasKeyFor: (email) => keyFor(email) !== null,

    // Geeft de datalekken waarin dit adres voorkomt (een lege lijst als het nergens in staat).
    async breachesFor(email) {
      const key = keyFor(email);
      if (!key) throw new ScanError('no_key');
      if (!KEY_PATTERN.test(key)) throw new ScanError('bad_key');

      await throttle();

      let response;
      try {
        response = await fetchImpl(
          `${baseUrl}/breachedaccount/${encodeURIComponent(email)}?truncateResponse=false`,
          {
            headers: { 'hibp-api-key': key, 'user-agent': USER_AGENT },
            signal: AbortSignal.timeout(timeoutMs),
          },
        );
      } catch {
        throw new ScanError('unavailable'); // geen internet, of HIBP reageert niet op tijd
      }

      // 404 is bij HIBP het gewone "niets gevonden". Dat bewijst niet dat het adres
      // nergens in staat, alleen dat HIBP niets openbaars weet.
      if (response.status === 404) return [];
      if (response.status === 401) throw new ScanError('bad_key');
      if (response.status === 429) throw new ScanError('rate_limited');
      if (response.status === 503) throw new ScanError('unavailable');
      if (response.status !== 200) throw new ScanError('unexpected');

      let data;
      try {
        data = await response.json();
      } catch {
        throw new ScanError('unexpected');
      }
      if (!Array.isArray(data)) throw new ScanError('unexpected');
      return data.map(normalizeBreach).filter(Boolean);
    },
  };
}
