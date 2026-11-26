// Automatische kostenlimieten voor de zoekdienst. Brave rekent per aanvraag, dus de site houdt zichzelf
// aan een grens per dag, per maand en per onderzoek. Is een grens bereikt, dan stuurt de site geen
// aanvragen meer tot de dag of maand om is (in UTC, net als de tellers op de beheerpagina), en zegt hij
// dat eerlijk. Er hoeft niemand iets aan te zetten: de volgende dag of maand werkt het weer.
//
// De grenzen staan in .env (BRAVE_MAX_PER_DAY, BRAVE_MAX_PER_MONTH, MAX_QUERIES_PER_SCAN). De
// standaardwaarden houden een maand binnen het gratis tegoed van Brave (zie admin.js, BRAVE_PRICE).
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

// Hoe staat het met de grens? { day: {used, max}, month: {used, max}, reached: 'day' | 'month' | null }
export function budgetState(db, service, limits = DEFAULT_LIMITS, now = Date.now()) {
  const used = usedNow(db, service, now);
  let reached = null;
  if (used.month >= limits.perMonth) reached = 'month';
  else if (used.day >= limits.perDay) reached = 'day';
  return {
    day: { used: used.day, max: limits.perDay },
    month: { used: used.month, max: limits.perMonth },
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

// De zoekdienst met de grenzen per dag en per maand ervoor. Alleen voor een echte, betaalde dienst
// (Brave); de demo en onbekende diensten laat dit ongemoeid. Net als de pauzeknop een Proxy: al het
// andere komt van het origineel.
export function budgetedSearch(search, db, limits = DEFAULT_LIMITS, { clock = Date.now } = {}) {
  if (!search || search.isDemo) return search;
  const service = String(search.id ?? search.name ?? '');
  if (!Object.hasOwn(SERVICES, service)) return search;
  const guarded = async (request) => {
    const now = clock();
    const { reached } = budgetState(db, service, limits, now);
    if (reached) {
      logOnce(db, service, reached, now);
      throw new ScanError('budget');
    }
    return search.search(request);
  };
  return new Proxy(search, {
    get: (target, property, receiver) => (property === 'search' ? guarded : Reflect.get(target, property, receiver)),
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
