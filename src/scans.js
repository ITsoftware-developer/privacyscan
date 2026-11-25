// Het eigenlijke zoeken: vraag het aan een dienst, bewaar wat er terugkomt.
import { recordScan, saveBreaches, saveWebResults } from './findings.js';
import { ScanError } from './scan-error.js';
import { buildQuery, cleanName, cleanResults } from './search.js';

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
export async function scanWeb({ db, user, search, allowed = true, now = Date.now() }) {
  if (!allowed) throw new ScanError('search_disabled');

  const query = buildQuery({ name: user.name, city: user.city });
  if (!query) throw new ScanError('name_too_short');

  let raw;
  try {
    raw = await search.search({ query, name: cleanName(user.name), city: cleanName(user.city, 60) });
  } catch {
    throw new ScanError('search_failed'); // de details van de dienst houden we bij de bezoeker weg
  }

  const results = cleanResults(raw);
  const added = saveWebResults(db, user.id, results, now);
  recordScan(db, user.id, 'web', results.length, added, query, now);
  return { found: results.length, added, query };
}
