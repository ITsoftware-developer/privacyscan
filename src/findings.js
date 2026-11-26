// Bewaart en leest wat een scan vindt (de tabellen findings, scans en scan_runs).
import { BREACH_CONFIDENCE } from './confidence.js';
import { inTransaction } from './db.js';
import { WEB_RESULT_MS, webKey } from './retention.js';
import { sourceById } from './sources.js';

// Een bevinding telt alleen mee zolang hij mag blijven (zie retention.js). removeExpired in db.js
// wist ze ook echt, maar tot dat gebeurd is, tonen en tellen we ze al niet meer.
const LIVE = '(expires_at IS NULL OR expires_at > ?)';

// De keuzes die je per webresultaat hebt. 'new' is "nog niet beoordeeld".
export const WEB_CHOICES = {
  mine: 'Dit ben ik',
  not_mine: 'Dit ben ik niet',
  unknown: 'Weet ik niet',
};

function parseDetails(json) {
  try {
    const value = JSON.parse(json);
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

// De pagina van HIBP over dit datalek. De naam komt van HIBP, dus we coderen hem.
export function breachUrl(name) {
  return `https://haveibeenpwned.com/PwnedWebsites#${encodeURIComponent(name)}`;
}

// De link bij een datalek. Bij HIBP is dat hun pagina over dit lek. Bij XposedOrNot is het
// de verwijzing die zij zelf meegeven, als die er is; anders is er geen link.
export function breachLink(breach) {
  return breach.source === 'xon' ? (breach.url ?? null) : breachUrl(breach.name);
}

// Bewaart datalekken. Het adres is bevestigd, dus dit zijn per definitie jouw
// datalekken: ze krijgen meteen de status 'mine'. Geeft terug hoeveel er nieuw waren.
//
// Bij elke bevinding bewaren we de bron, de zekerheid en wanneer het onderzocht is
// (checked_at). Elke keer dat een scan het lek weer ziet, wordt die datum bijgewerkt.
export function saveBreaches(db, userId, breaches, now = Date.now()) {
  return inTransaction(db, () => {
    const known = new Set(db
      .prepare("SELECT source_key FROM findings WHERE user_id = ? AND kind = 'breach'")
      .all(userId)
      .map((row) => row.source_key));
    const upsert = db.prepare(`
      INSERT INTO findings (user_id, kind, source_key, title, url, details, status, found_at, updated_at,
                            source_id, confidence, confidence_note, checked_at)
      VALUES (?, 'breach', ?, ?, ?, ?, 'mine', ?, ?, ?, ?, ?, ?)
      ON CONFLICT (user_id, kind, source_key) DO UPDATE SET
        title = excluded.title, url = excluded.url,
        details = excluded.details, updated_at = excluded.updated_at,
        source_id = excluded.source_id, confidence = excluded.confidence,
        confidence_note = excluded.confidence_note, checked_at = excluded.checked_at`);

    let added = 0;
    for (const breach of breaches) {
      const { name, title, url, ...details } = breach;
      upsert.run(
        userId, name, title, breachLink(breach), JSON.stringify(details), now, now,
        sourceById(breach.source).id, BREACH_CONFIDENCE.level, BREACH_CONFIDENCE.note, now,
      );
      if (!known.has(name)) added += 1;
      known.add(name);
    }
    return added;
  });
}

// Bewaart webresultaten ({ title, url, snippet }). Nieuwe krijgen de keuze die je eerder bij dit
// adres maakte (zie web_choices), of anders de status 'new'; een resultaat dat je al beoordeeld
// had, houdt zijn keuze. Geeft terug hoeveel er nieuw waren: nog niet eerder gezien en nog niet
// door jou beoordeeld.
//
// `evidence` zegt waar de resultaten vandaan komen en hoe lang ze mogen blijven:
//   sourceId    welke zoekdienst het gaf
//   rate        rate(result) geeft { level, note }: hoe zeker het is dat het resultaat over jou gaat
//               (zie confidence.js). Bij een nieuwe zoekronde wordt dat opnieuw beoordeeld, want je
//               woonplaats kan veranderd zijn.
//   expiresAt   tot wanneer we de resultaten mogen bewaren (ms), of null: zolang je account bestaat
// `evidence` zegt waar de resultaten vandaan komen:
//   sourceId   de zoekdienst (brave, demo)
//   rate       hoe zeker is het dat een resultaat over jou gaat (zie confidence.js)
//   expiresAt  tot wanneer het mag blijven staan (zie retention.js)
//   category   wat voor soort site (broker, social, document, web), als functie van het resultaat
//   via        met welk gegeven het gevonden is: naam, telefoon of e-mail. Vindt een volgende zoekopdracht
//              hetzelfde adres met een ander gegeven, dan komt dat erbij (zie research/).
export function saveWebResults(db, userId, results, now = Date.now(), evidence = {}) {
  const {
    sourceId = null, rate = null, expiresAt = null, category = null, via = null,
  } = evidence;
  const earlier = db.prepare(`SELECT details FROM findings WHERE user_id = ? AND kind = 'web' AND source_key = ? AND ${LIVE}`);
  const viaOf = (url) => {
    const row = earlier.get(userId, url, now);
    if (!row) return [];
    try {
      const list = JSON.parse(row.details).via;
      return Array.isArray(list) ? list.filter((item) => typeof item === 'string') : [];
    } catch {
      return [];
    }
  };
  return inTransaction(db, () => {
    const live = new Set(db
      .prepare(`SELECT source_key FROM findings WHERE user_id = ? AND kind = 'web' AND ${LIVE}`)
      .all(userId, now)
      .map((row) => row.source_key));
    const choices = new Map(db
      .prepare('SELECT url_key, status FROM web_choices WHERE user_id = ?')
      .all(userId)
      .map((row) => [row.url_key, row.status]));
    const upsert = db.prepare(`
      INSERT INTO findings (user_id, kind, source_key, title, url, details, status, found_at, updated_at,
                            source_id, confidence, confidence_note, checked_at, expires_at)
      VALUES (?, 'web', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (user_id, kind, source_key) DO UPDATE SET
        title = excluded.title, details = excluded.details, updated_at = excluded.updated_at,
        found_at = CASE WHEN findings.expires_at IS NOT NULL AND findings.expires_at <= excluded.found_at
                        THEN excluded.found_at ELSE findings.found_at END,
        source_id = COALESCE(excluded.source_id, findings.source_id),
        confidence = COALESCE(excluded.confidence, findings.confidence),
        confidence_note = COALESCE(excluded.confidence_note, findings.confidence_note),
        checked_at = excluded.checked_at, expires_at = excluded.expires_at`);

    let added = 0;
    for (const result of results) {
      const { title, url, snippet } = result;
      const rating = rate ? rate(result) : null;
      const choice = choices.get(webKey(url));
      const details = { snippet };
      if (category) details.category = category(result);
      if (via) details.via = [...new Set([...viaOf(url), via])];
      upsert.run(
        userId, url, title, url, JSON.stringify(details), choice ?? 'new', now, now,
        sourceId, rating?.level ?? null, rating?.note ?? null, now, expiresAt,
      );
      if (!live.has(url) && choice === undefined) added += 1;
      live.add(url);
    }
    return added;
  });
}

// Zorgt dat resultaten van deze zoekdienst niet langer blijven staan dan mag: wat nog zonder
// einddatum bewaard staat (bijvoorbeeld uit de tijd dat je een abonnement met opslagrechten had),
// verloopt over een half uur. server.js doet dit bij het starten, voor een dienst die bewaren niet toestaat.
export function limitRetention(db, sourceId, now = Date.now()) {
  const result = db
    .prepare("UPDATE findings SET expires_at = ? WHERE kind = 'web' AND source_id = ? AND expires_at IS NULL")
    .run(now + WEB_RESULT_MS, sourceId);
  return Number(result.changes);
}

// Met welk gegeven een webresultaat gevonden is (details.via), voor in de pagina's.
export const VIA_LABELS = { naam: 'je naam', telefoon: 'je telefoonnummer', 'e-mail': 'je e-mailadres' };

// "je naam en je telefoonnummer", of null als er niets (bekends) in de lijst staat. Een onbekende waarde
// (bijvoorbeeld uit een kapotte database) laten we weg; we verzinnen er geen tekst bij.
export function viaText(list) {
  const known = (Array.isArray(list) ? list : []).filter((item) => typeof item === 'string' && Object.hasOwn(VIA_LABELS, item));
  const labels = [...new Set(known)].map((item) => VIA_LABELS[item]);
  if (labels.length === 0) return null;
  return labels.length === 1 ? labels[0] : `${labels.slice(0, -1).join(', ')} en ${labels.at(-1)}`;
}

// Alle resultaten van één gebruiker: datalekken (nieuwste lek eerst) en webresultaten.
// Webresultaten staan op de volgorde van de zoekdienst (de beste eerst), met wat bij
// een nieuwe zoekronde nieuw was bovenaan. De volgorde hangt niet af van je keuzes:
// anders springt een resultaat weg zodra je erop klikt.
export function listFindings(db, userId, now = Date.now()) {
  const rows = db
    .prepare(`SELECT id, kind, title, url, details, status, found_at,
                     source_id, confidence, confidence_note, checked_at, expires_at
              FROM findings WHERE user_id = ? AND ${LIVE} ORDER BY found_at DESC, id ASC`)
    .all(userId, now)
    .map((row) => ({ ...row, details: parseDetails(row.details) }));

  const byDate = (a, b) => String(b.details.breachDate ?? '').localeCompare(String(a.details.breachDate ?? ''));
  return {
    breaches: rows.filter((row) => row.kind === 'breach').sort(byDate),
    web: rows.filter((row) => row.kind === 'web'),
  };
}

// Zet je keuze bij een webresultaat, en onthoudt hem bij het adres (web_choices), zodat hij blijft
// bestaan als het resultaat zelf verloopt. Alleen van jezelf: een id van iemand anders (of van een
// datalek, of van een resultaat dat al verlopen is) verandert niets en geeft false.
export function setWebStatus(db, userId, id, status, now = Date.now()) {
  return inTransaction(db, () => {
    const row = db
      .prepare(`SELECT url FROM findings WHERE id = ? AND user_id = ? AND kind = 'web' AND ${LIVE}`)
      .get(id, userId, now);
    if (!row) return false;
    db.prepare('UPDATE findings SET status = ?, updated_at = ? WHERE id = ? AND user_id = ?')
      .run(status, now, id, userId);
    db.prepare(`
      INSERT INTO web_choices (user_id, url_key, status, decided_at) VALUES (?, ?, ?, ?)
      ON CONFLICT (user_id, url_key) DO UPDATE SET status = excluded.status, decided_at = excluded.decided_at`)
      .run(userId, webKey(row.url), status, now);
    return true;
  });
}

// Aantallen voor het dashboard.
export function countFindings(db, userId, now = Date.now()) {
  const counts = { breaches: 0, web: 0, webNew: 0, webMine: 0 };
  const rows = db
    .prepare(`SELECT kind, status, COUNT(*) AS n FROM findings WHERE user_id = ? AND ${LIVE} GROUP BY kind, status`)
    .all(userId, now);
  for (const { kind, status, n } of rows) {
    if (kind === 'breach') counts.breaches += n;
    else {
      counts.web += n;
      if (status === 'new') counts.webNew += n;
      if (status === 'mine') counts.webMine += n;
    }
  }
  return counts;
}

export function recordScan(db, userId, kind, foundCount, newCount, detail = null, now = Date.now()) {
  db.prepare(`
    INSERT INTO scans (user_id, kind, ran_at, found_count, new_count, detail)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (user_id, kind) DO UPDATE SET
      ran_at = excluded.ran_at, found_count = excluded.found_count,
      new_count = excluded.new_count, detail = excluded.detail`)
    .run(userId, kind, now, foundCount, newCount, detail);
}

// De laatste scan van deze soort, of null als je nog nooit gezocht hebt.
export function lastScan(db, userId, kind) {
  return db
    .prepare('SELECT ran_at, found_count, new_count, detail FROM scans WHERE user_id = ? AND kind = ?')
    .get(userId, kind) ?? null;
}

// --- De Deep Scan --------------------------------------------------------------------------

// Bewaart de laatste Deep Scan van deze gebruiker: de stappen en de blootgestelde soorten
// gegevens, allebei als JSON. Een oudere run wordt overschreven.
export function saveRun(db, userId, { ranAt, steps, exposure }) {
  db.prepare(`
    INSERT INTO scan_runs (user_id, ran_at, steps, exposure)
    VALUES (?, ?, ?, ?)
    ON CONFLICT (user_id) DO UPDATE SET
      ran_at = excluded.ran_at, steps = excluded.steps, exposure = excluded.exposure`)
    .run(userId, ranAt, JSON.stringify(steps), JSON.stringify(exposure));
}

function parseList(json) {
  try {
    const value = JSON.parse(json);
    return Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

// De laatste Deep Scan, of null als je er nog geen deed (of als wat er bewaard is, kapot is:
// dan tonen we liever niets dan iets verkeerds).
export function lastRun(db, userId) {
  const row = db
    .prepare('SELECT ran_at, steps, exposure FROM scan_runs WHERE user_id = ?')
    .get(userId);
  if (!row) return null;
  const steps = parseList(row.steps);
  const exposure = parseList(row.exposure);
  if (!steps || !exposure) return null;
  return { ranAt: row.ran_at, steps, exposure };
}
