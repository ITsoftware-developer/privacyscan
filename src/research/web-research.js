// Eén zoekopdracht van het uitgebreide onderzoek: naar de zoekdienst, resultaten opschonen, beoordelen
// en bewaren met waar ze vandaan komen. De stappen van de Deep Scan (scanner.js) gebruiken dit voor
// databrokers, sociale media, documenten, je telefoonnummer en je e-mailadres.
import { DEMO_CONFIDENCE, rateWebResult } from '../confidence.js';
import { classifyUrl } from '../extract.js';
import { saveWebResults } from '../findings.js';
import { WEB_RESULT_MS } from '../retention.js';
import { ScanError } from '../scan-error.js';
import { SEARCH_ERRORS, searchSourceId } from '../scans.js';
import { cleanName, cleanResults } from '../search.js';

// Waarmee we een resultaat beoordelen: je naam, woonplaats en e-mailadres, en je telefoonnummer alleen
// als je het met een sms-code bevestigd hebt.
export function identityOf(user) {
  return {
    name: user.name,
    city: user.city ?? null,
    email: user.email,
    phone: user.phone_verified_at ? (user.phone ?? null) : null,
  };
}

// Een fout van de zoekdienst wordt een fout van het zoeken op het web, zonder details van de dienst.
export function asSearchError(error) {
  const code = error instanceof ScanError ? SEARCH_ERRORS[error.code] : null;
  return new ScanError(code ?? 'search_failed');
}

// Zoekt één zoekopdracht en bewaart de resultaten.
//   via   met welk gegeven: 'naam', 'telefoon' of 'e-mail'
//   keep  welke resultaten we houden (bijvoorbeeld alleen die op een databrokersite)
// Geeft { results, added }.
export async function searchAndSave({
  db, user, search, query, via, now, keep = () => true,
}) {
  let raw;
  try {
    raw = await search.search({ query, name: cleanName(user.name), city: cleanName(user.city, 60) });
  } catch (error) {
    throw asSearchError(error);
  }
  const results = cleanResults(raw).filter(keep);
  const who = identityOf(user);
  const rate = (result) => (search.isDemo
    ? DEMO_CONFIDENCE
    : rateWebResult({ ...who, title: result.title, snippet: result.snippet }));
  const added = saveWebResults(db, user.id, results, now, {
    sourceId: searchSourceId(search),
    rate,
    expiresAt: search.retainsResults === true ? null : now + WEB_RESULT_MS,
    via,
    category: (result) => classifyUrl(result.url).type,
  });
  return { results, added };
}
