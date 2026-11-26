// Meet het verkeer naar de externe diensten, voor de beheerpagina: hoeveel aanvragen de site
// stuurde, hoeveel er mislukten, hoe snel de dienst antwoordde en wat de dienst zelf over de
// limieten zegt. Ook: welke onderzoeken er op dit moment lopen.
//
// Er komt nooit een webadres, zoekopdracht, e-mailadres of sleutel in: alleen de naam van de
// dienst, de HTTP-status, de duur en tellers. De tellers per dag staan in de database (api_usage),
// zodat ze een herstart overleven. De rest (laatste aanvraag, limieten, wat er nu loopt) staat
// alleen in het geheugen en begint bij elke start opnieuw.
import { logEvent } from './events.js';
import { SERVICE_IDS } from './services.js';

// Een antwoord dat geen fout is. Bij Have I Been Pwned en XposedOrNot betekent 404 "dit adres
// staat in geen enkel bekend lek": een gewone uitkomst, geen storing.
export function isSuccess(service, status) {
  if (status >= 200 && status < 300) return true;
  return status === 404 && (service === 'hibp' || service === 'xon');
}

export function utcDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

const numbers = (text) => (typeof text === 'string' && text.trim() !== ''
  ? text.split(',').map((part) => Number(part.trim()))
  : []);

// Leest de limieten die Brave bij elk antwoord meegeeft. Volgens de handleiding van Brave staan er
// per "venster" waarden in, met komma's ertussen, bijvoorbeeld:
//   X-RateLimit-Limit: 1, 15000          (1 per seconde, 15000 per maand)
//   X-RateLimit-Policy: 1;w=1, 15000;w=2592000   (vensters in seconden)
//   X-RateLimit-Remaining: 1, 1000       (wat er nog over is)
//   X-RateLimit-Reset: 1, 1419704        (seconden tot het venster opnieuw begint)
// Geeft een lijst { window, limit, remaining, reset } (window in seconden, of null als onbekend),
// of null als de headers er niet (goed) in staan.
export function parseRateLimits(headers) {
  const get = (name) => headers?.get?.(name) ?? null;
  const limit = numbers(get('x-ratelimit-limit'));
  const remaining = numbers(get('x-ratelimit-remaining'));
  const reset = numbers(get('x-ratelimit-reset'));
  const windows = (get('x-ratelimit-policy') ?? '')
    .split(',')
    .map((part) => Number(part.match(/;\s*w=(\d+)/)?.[1] ?? NaN));
  if (remaining.length === 0 || remaining.some((value) => !Number.isFinite(value) || value < 0)) return null;

  return remaining.map((left, index) => {
    let window = Number.isFinite(windows[index]) ? windows[index] : null;
    // Zonder Policy-header: Brave geeft eerst het venster per seconde en dan dat per maand.
    if (window === null && remaining.length === 2) window = index === 0 ? 1 : 2592000;
    if (window === null && remaining.length === 1) window = 1;
    const valid = (list) => (Number.isFinite(list[index]) && list[index] >= 0 ? list[index] : null);
    return { window, limit: valid(limit), remaining: left, reset: valid(reset) };
  });
}

// Een omschrijving van een venster, voor op de pagina.
export function windowLabel(seconds) {
  if (seconds === 1) return 'per seconde';
  if (seconds === 60) return 'per minuut';
  if (seconds === 3600) return 'per uur';
  if (seconds === 86400) return 'per dag';
  if (seconds >= 2419200 && seconds <= 2678400) return 'per maand';
  if (Number.isFinite(seconds)) return `per ${seconds.toLocaleString('nl-NL')} seconden`;
  return 'per periode';
}

export function createMonitor(db, { clock = Date.now } = {}) {
  const startedAt = clock();
  const live = Object.fromEntries(SERVICE_IDS.map((id) => [id, {
    lastAt: null, lastOk: null, lastStatus: null, lastMs: null, lastFailureAt: null,
    limits: null, limitsAt: null, test: null,
  }]));
  const running = new Map();
  let nextRun = 1;

  const bump = db.prepare(`
    INSERT INTO api_usage (service, day, calls, errors) VALUES (?, ?, 1, ?)
    ON CONFLICT (service, day) DO UPDATE SET calls = calls + 1, errors = errors + excluded.errors`);

  // Eén aanvraag tellen. Ook als tellen mislukt (database op slot), gaat de aanvraag zelf door.
  function record(service, { ok, status = null, ms = null, failure = null }) {
    const now = clock();
    try {
      bump.run(service, utcDay(now), ok ? 0 : 1);
    } catch (error) {
      console.error(`Verbruik niet geteld (${error?.name ?? 'Error'}).`);
    }
    Object.assign(live[service], { lastAt: now, lastOk: ok, lastStatus: status, lastMs: ms });
    if (!ok) {
      live[service].lastFailureAt = now;
      logEvent(db, 'external_failed', failure === 'network'
        ? { service, failure: 'network' }
        : { service, failure: 'http', status }, now);
    }
  }

  // Een fetch die elke aanvraag naar deze dienst telt. Hij geeft het antwoord (of de fout)
  // ongewijzigd door: de koppelingen merken er niets van.
  function fetchFor(service, fetchImpl = fetch) {
    if (!Object.hasOwn(live, service)) throw new Error(`Onbekende dienst: ${service}`);
    return async (url, init) => {
      const started = performance.now();
      let response;
      try {
        response = await fetchImpl(url, init);
      } catch (error) {
        record(service, { ok: false, ms: Math.round(performance.now() - started), failure: 'network' });
        throw error;
      }
      record(service, {
        ok: isSuccess(service, response.status),
        status: response.status,
        ms: Math.round(performance.now() - started),
      });
      if (service === 'brave') {
        const limits = parseRateLimits(response.headers);
        if (limits) Object.assign(live.brave, { limits, limitsAt: clock() });
      }
      return response;
    };
  }

  // Houdt bij dat er een onderzoek loopt, zolang `work` bezig is. (Er is nog geen wachtrij op de
  // achtergrond: een onderzoek loopt zolang het verzoek van de bezoeker duurt.)
  async function track(scan, work) {
    const id = nextRun++;
    running.set(id, { scan, startedAt: clock() });
    try {
      return await work();
    } finally {
      running.delete(id);
    }
  }

  // De uitkomst van de laatste test vanaf de beheerpagina.
  function setTest(service, { ok, text }) {
    live[service].test = { at: clock(), ok: Boolean(ok), text: String(text) };
  }

  // De tellers van vandaag, deze maand en vorige maand (in UTC), per dienst.
  function usage(now = clock()) {
    const today = utcDay(now);
    const month = today.slice(0, 7);
    const first = new Date(`${month}-01T00:00:00Z`);
    const previous = utcDay(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() - 1, 1)).slice(0, 7);
    const rows = db.prepare('SELECT service, day, calls, errors FROM api_usage WHERE day >= ?').all(`${previous}-01`);
    const empty = () => ({ calls: 0, errors: 0 });
    const result = Object.fromEntries(SERVICE_IDS.map((id) => [id, { today: empty(), month: empty(), previousMonth: empty() }]));
    for (const row of rows) {
      const entry = result[row.service];
      if (!entry) continue;
      const add = (bucket) => {
        bucket.calls += row.calls;
        bucket.errors += row.errors;
      };
      if (row.day === today) add(entry.today);
      if (row.day.startsWith(month)) add(entry.month);
      else if (row.day.startsWith(previous)) add(entry.previousMonth);
    }
    return { today, month, previous, services: result };
  }

  return {
    startedAt,
    fetchFor,
    record,
    track,
    setTest,
    usage,
    // Kopieën, zodat de beheerpagina niets per ongeluk kan veranderen.
    live: () => structuredClone(live),
    running: () => [...running.values()].map((run) => ({ ...run })),
  };
}
