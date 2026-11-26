// Het eigenlijke zoeken: vraag het aan een dienst, bewaar wat er terugkomt.
import { DEMO_CONFIDENCE, rateWebResult } from './confidence.js';
import { recordScan, saveBreaches, saveWebResults } from './findings.js';
import { WEB_RESULT_MS } from './retention.js';
import { ScanError } from './scan-error.js';
import { buildQuery, cleanName, cleanResults } from './search.js';

// Het id van de zoekdienst zoals het bij een bevinding komt te staan (de bron).
export function searchSourceId(search) {
  return search.isDemo ? 'demo' : String(search.id ?? search.name ?? 'web');
}

// Een fout van de zoekdienst wordt een fout van het zoeken op het web. De codes beginnen met
// "search_", zodat de melding over de zoekdienst gaat en niet over de bron van datalekken.
const SEARCH_ERRORS = {
  paused: 'search_paused',
  bad_key: 'search_bad_key',
  rate_limited: 'search_rate_limited',
  unavailable: 'search_unavailable',
  unexpected: 'search_unexpected',
};

// Zoekt de datalekken van dit account. We geven alleen het (bevestigde) adres van
// het ingelogde account mee; er is geen manier om een ander adres op te geven.
export async function scanBreaches({ db, user, hibp, now = Date.now() }) {
  const breaches = await hibp.breachesFor(user.email);
  const added = saveBreaches(db, user.id, breaches, now);
  recordScan(db, user.id, 'breach', breaches.length, added, null, now);
  return { found: breaches.length, added };
}

// Zoekt op het web naar de naam (en woonplaats) van dit account. De zoekopdracht
// wordt hier gemaakt van de gegevens van de gebruiker; niemand kan er zelf iets in
// typen.
//
// Of er gezocht mag worden, bepaalt de aanroeper (zie routes-scan.js). Op een
// openbare site mag alleen de beheerder: een bevestigd e-mailadres bewijst niet dat
// de naam van een gewone gebruiker van die gebruiker is, dus iedereen zou de naam van
// een ander kunnen laten opzoeken. Voor iedereen aanzetten kan pas met een echte
// identiteitscheck (bijvoorbeeld iDIN of een ID-scan met selfie).
//
// Zonder zoekdienst (search is null) zoeken we niet, en verzinnen we niets.
export async function scanWeb({ db, user, search, allowed = true, now = Date.now() }) {
  if (!allowed) throw new ScanError('search_disabled');
  if (!search) throw new ScanError('no_search');

  const query = buildQuery({ name: user.name, city: user.city });
  if (!query) throw new ScanError('name_too_short');

  let raw;
  try {
    raw = await search.search({ query, name: cleanName(user.name), city: cleanName(user.city, 60) });
  } catch (error) {
    // De details van de dienst houden we bij de bezoeker weg; alleen de soort fout geven we door.
    const code = error instanceof ScanError ? SEARCH_ERRORS[error.code] : null;
    throw new ScanError(code ?? 'search_failed');
  }

  const results = cleanResults(raw);

  // Bij elk resultaat bewaren we uit welke bron het komt en hoe zeker het is dat het over jou
  // gaat: een mogelijke overeenkomst, nooit meer (zie confidence.js). De demo verzint alles; daar
  // is geen zekerheid te geven.
  const sourceId = searchSourceId(search);
  const rate = (result) => (search.isDemo
    ? DEMO_CONFIDENCE
    : rateWebResult({
      name: user.name, city: user.city, email: user.email, title: result.title, snippet: result.snippet,
    }));

  // Staat de dienst niet toe dat we resultaten bewaren, dan blijven ze maar even staan (zie
  // retention.js). Weet de app dat niet zeker, dan gaan we uit van niet toegestaan.
  const expiresAt = search.retainsResults === true ? null : now + WEB_RESULT_MS;

  const added = saveWebResults(db, user.id, results, now, { sourceId, rate, expiresAt });
  recordScan(db, user.id, 'web', results.length, added, query, now);
  return { found: results.length, added, query, expiresAt };
}
