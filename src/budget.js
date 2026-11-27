// Automatische kostenlimieten voor de zoekdienst. Brave rekent per aanvraag, dus de site houdt zichzelf
// aan een grens per dag, per maand en per onderzoek. Is een grens bereikt, dan stuurt de site geen
// aanvragen meer tot de dag of maand om is (in UTC, net als de tellers op de beheerpagina), en zegt hij
// dat eerlijk. Er hoeft niemand iets aan te zetten: de volgende dag of maand werkt het weer.
//
// De grenzen staan in .env (BRAVE_MAX_PER_DAY, BRAVE_MAX_PER_MONTH, MAX_QUERIES_PER_SCAN). De
// standaardwaarden houden een maand binnen het gratis tegoed van Brave (zie admin.js, BRAVE_PRICE).
import { inTransaction } from './db.js';
import { logEvent } from './events.js';
import { utcDay } from './monitor.js';
import { ScanError } from './scan-error.js';
import { SERVICES } from './services.js';

export const DEFAULT_LIMITS = { perDay: 100, perMonth: 900, perScan: 25 };

// Leest een grens uit .env: leeg = de standaardwaarde, anders een heel getal van 1 of meer. Een
// typfout stopt de server liever dan dat de site stilletjes zonder grens gaat zoeken.
export function parseLimit(value, name, fallback) {
  const text = String(value ?? '').trim();
  if (text === '') return fallback;
  if (!/^\d{1,7}$/.test(text) || Number(text) < 1) {
    throw new Error(`${name} moet een heel getal van 1 of meer zijn (of leeg voor ${fallback}). Controleer je .env.`);
  }
  return Number(text);
}

// Hoeveel aanvragen deze dienst vandaag en deze maand al kreeg (gelukt of niet: zo blijft de grens
// aan de veilige kant).
export function usedNow(db, service, now = Date.now()) {
  const day = utcDay(now);
  const row = db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN day = ? THEN calls END), 0) AS today,
           COALESCE(SUM(calls), 0) AS month
    FROM api_usage WHERE service = ? AND day >= ?`).get(day, service, `${day.slice(0, 7)}-01`);
  return { day: row.today, month: row.month };
}

// Hoeveel aanvragen naar deze dienst nu onderweg zijn: toegelaten, maar nog niet in api_usage. Plekken
// van een proces dat onderweg stopte, tellen na HOLD_MS niet meer mee.
export const HOLD_MS = 2 * 60 * 1000;

export function pendingHolds(db, service, now = Date.now()) {
  return db.prepare('SELECT COUNT(*) AS n FROM budget_holds WHERE service = ? AND expires_at > ?').get(service, now).n;
}

// Hoe staat het met de grens? { day: {used, max}, month: {used, max}, pending, reached: 'day' | 'month' | null }
// `pending` zijn aanvragen die al een plek kregen maar nog niet in api_usage staan: die tellen mee, anders
// glippen gelijktijdige aanvragen allemaal door dezelfde controle. Zonder `pending` leest dit ze uit de database.
export function budgetState(db, service, limits = DEFAULT_LIMITS, now = Date.now(), pending = pendingHolds(db, service, now)) {
  const used = usedNow(db, service, now);
  let reached = null;
  if (used.month + pending >= limits.perMonth) reached = 'month';
  else if (used.day + pending >= limits.perDay) reached = 'day';
  return {
    day: { used: used.day, max: limits.perDay },
    month: { used: used.month, max: limits.perMonth },
    pending,
    reached,
  };
}

// Eén melding in het log per dienst per periode, niet bij elke geweigerde aanvraag.
function logOnce(db, service, period, now) {
  const key = `budget-logged:${service}:${period === 'day' ? utcDay(now) : utcDay(now).slice(0, 7)}`;
  const inserted = db.prepare('INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?, ?, ?)')
    .run(key, '1', now).changes;
  if (inserted > 0) logEvent(db, 'budget_reached', { service, period }, now);
}

// Tellen en een plek nemen in één transactie die meteen de schrijfrechten neemt (BEGIN IMMEDIATE): twee
// aanvragen, ook uit twee processen met dezelfde database, kunnen zo nooit allebei de laatste plek krijgen.
// Geeft { id } (de plek) of { reached: 'day' | 'month' }.
export function reserve(db, service, limits = DEFAULT_LIMITS, now = Date.now()) {
  return inTransaction(db, () => {
    const { reached } = budgetState(db, service, limits, now);
    if (reached) return { reached };
    const { lastInsertRowid } = db.prepare('INSERT INTO budget_holds (service, created_at, expires_at) VALUES (?, ?, ?)')
      .run(service, now, now + HOLD_MS);
    return { id: Number(lastInsertRowid) };
  }, { immediate: true });
}

export function release(db, id) {
  db.prepare('DELETE FROM budget_holds WHERE id = ?').run(id);
}

// De zoekdienst met de grenzen per dag en per maand ervoor. Alleen voor een echte, betaalde dienst
// (Brave); de demo en onbekende diensten laat dit ongemoeid. Net als de pauzeknop een Proxy: al het
// andere komt van het origineel.
//
// Een aanvraag telt in api_usage pas mee als het antwoord binnen is. Daarom neemt elke aanvraag eerst een
// plek (reserve); na het antwoord, of na een fout, geeft hij die terug. Mislukt een aanvraag, dan telt hij
// alleen mee als hij Brave echt bereikte (dat schrijft de monitor in api_usage).
export function budgetedSearch(search, db, limits = DEFAULT_LIMITS, { clock = Date.now } = {}) {
  if (!search || search.isDemo) return search;
  const service = String(search.id ?? search.name ?? '');
  if (!Object.hasOwn(SERVICES, service)) return search;
  const guarded = async (request) => {
    const now = clock();
    const hold = reserve(db, service, limits, now);
    if (hold.reached) {
      logOnce(db, service, hold.reached, now);
      throw new ScanError('budget');
    }
    try {
      return await search.search(request);
    } finally {
      release(db, hold.id);
    }
  };
  return new Proxy(search, {
    get: (target, property, receiver) => {
      if (property === 'search') return guarded;
      if (property === 'pendingCalls') return pendingHolds(db, service, clock());
      return Reflect.get(target, property, receiver);
    },
  });
}

// Een grens per onderzoek: hooguit `max` zoekopdrachten voor één Deep Scan. Elke Deep Scan krijgt zijn
// eigen teller.
export function perScanLimit(search, max = DEFAULT_LIMITS.perScan) {
  if (!search) return search;
  let used = 0;
  const guarded = async (request) => {
    if (used >= max) throw new ScanError('budget_scan');
    used += 1;
    return search.search(request);
  };
  return new Proxy(search, {
    get: (target, property, receiver) => {
      if (property === 'search') return guarded;
      if (property === 'queriesUsed') return used;
      return Reflect.get(target, property, receiver);
    },
  });
}
