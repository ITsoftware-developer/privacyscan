// Bewaart en leest wat een scan vindt (de tabellen findings en scans).
import { inTransaction } from './db.js';

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
export function saveBreaches(db, userId, breaches, now = Date.now()) {
  return inTransaction(db, () => {
    const known = new Set(db
      .prepare("SELECT source_key FROM findings WHERE user_id = ? AND kind = 'breach'")
      .all(userId)
      .map((row) => row.source_key));
    const upsert = db.prepare(`
      INSERT INTO findings (user_id, kind, source_key, title, url, details, status, found_at, updated_at)
      VALUES (?, 'breach', ?, ?, ?, ?, 'mine', ?, ?)
      ON CONFLICT (user_id, kind, source_key) DO UPDATE SET
        title = excluded.title, url = excluded.url,
        details = excluded.details, updated_at = excluded.updated_at`);

    let added = 0;
    for (const breach of breaches) {
      const { name, title, url, ...details } = breach;
      upsert.run(userId, name, title, breachLink(breach), JSON.stringify(details), now, now);
      if (!known.has(name)) added += 1;
      known.add(name);
    }
    return added;
  });
}

// Bewaart webresultaten ({ title, url, snippet }). Nieuwe krijgen de status 'new';
// een resultaat dat je al beoordeeld had, houdt zijn keuze. Geeft terug hoeveel er nieuw waren.
export function saveWebResults(db, userId, results, now = Date.now()) {
  return inTransaction(db, () => {
    const known = new Set(db
      .prepare("SELECT source_key FROM findings WHERE user_id = ? AND kind = 'web'")
      .all(userId)
      .map((row) => row.source_key));
    const upsert = db.prepare(`
      INSERT INTO findings (user_id, kind, source_key, title, url, details, status, found_at, updated_at)
      VALUES (?, 'web', ?, ?, ?, ?, 'new', ?, ?)
      ON CONFLICT (user_id, kind, source_key) DO UPDATE SET
        title = excluded.title, details = excluded.details, updated_at = excluded.updated_at`);

    let added = 0;
    for (const { title, url, snippet } of results) {
      upsert.run(userId, url, title, url, JSON.stringify({ snippet }), now, now);
      if (!known.has(url)) added += 1;
      known.add(url);
    }
    return added;
  });
}

// Alle resultaten van één gebruiker: datalekken (nieuwste lek eerst) en webresultaten.
// Webresultaten staan op de volgorde van de zoekdienst (de beste eerst), met wat bij
// een nieuwe zoekronde nieuw was bovenaan. De volgorde hangt niet af van je keuzes:
// anders springt een resultaat weg zodra je erop klikt.
export function listFindings(db, userId) {
  const rows = db
    .prepare('SELECT id, kind, title, url, details, status, found_at FROM findings WHERE user_id = ? ORDER BY found_at DESC, id ASC')
    .all(userId)
    .map((row) => ({ ...row, details: parseDetails(row.details) }));

  const byDate = (a, b) => String(b.details.breachDate ?? '').localeCompare(String(a.details.breachDate ?? ''));
  return {
    breaches: rows.filter((row) => row.kind === 'breach').sort(byDate),
    web: rows.filter((row) => row.kind === 'web'),
  };
}

// Zet je keuze bij een webresultaat. Alleen van jezelf: een id van iemand anders
// (of van een datalek) verandert niets en geeft false.
export function setWebStatus(db, userId, id, status) {
  const result = db
    .prepare("UPDATE findings SET status = ?, updated_at = ? WHERE id = ? AND user_id = ? AND kind = 'web'")
    .run(status, Date.now(), id, userId);
  return Number(result.changes) > 0;
}

// Aantallen voor het dashboard.
export function countFindings(db, userId) {
  const counts = { breaches: 0, web: 0, webNew: 0, webMine: 0 };
  const rows = db
    .prepare('SELECT kind, status, COUNT(*) AS n FROM findings WHERE user_id = ? GROUP BY kind, status')
    .all(userId);
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
