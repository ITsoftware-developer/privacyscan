// Het systeemlog op de beheerpagina: wat er technisch gebeurt, zonder persoonsgegevens.
//
// Elke melding heeft een vaste code met een vaste Nederlandse tekst. De details zijn alleen getallen
// en woorden uit vaste lijsten: logEvent gooit al het andere weg. Zo kan er nooit een naam,
// e-mailadres, zoekopdracht, webadres of sleutel in het log komen, ook niet per ongeluk of via de
// foutmelding van een andere dienst. Het enige nummer dat naar een persoon kan wijzen, is het
// nummer van een account, en dat alleen bij wat de beheerder met dat account doet.
//
// Het log blijft hooguit 30 dagen en 2000 meldingen bewaard (pruneEvents, via removeExpired).
import { SERVICE_IDS, serviceName } from './services.js';

export const EVENT_DAYS = 30;
export const EVENT_MAX = 2000;

// Wat er werd onderzocht.
const SCANS = {
  breach: 'Datalekcontrole',
  web: 'Webzoekopdracht',
  deep: 'Deep Scan',
  check: 'Openbare e-mailcontrole',
};

// Waar een limiet van de site zelf bereikt werd.
const LIMITS = {
  login: 'inloggen',
  register: 'aanmelden',
  check: 'de openbare e-mailcontrole',
  scan: 'zoeken',
  test: 'de testknoppen van de beheerpagina',
};

// De foutcodes van het zoeken (ScanError), in gewone woorden.
export const CODE_TEXT = {
  no_key: 'geen bron voor dit adres',
  bad_key: 'sleutel geweigerd',
  rate_limited: 'limiet van de bron bereikt',
  busy: 'te veel controles tegelijk',
  unavailable: 'bron niet bereikbaar',
  unexpected: 'onverwacht antwoord van de bron',
  paused: 'bron gepauzeerd door de beheerder',
  name_too_short: 'naam te kort om op te zoeken',
  no_search: 'geen zoekdienst ingesteld',
  search_failed: 'fout bij de zoekdienst',
  search_bad_key: 'sleutel van de zoekdienst geweigerd',
  search_rate_limited: 'limiet of tegoed van de zoekdienst op',
  search_unavailable: 'zoekdienst niet bereikbaar',
  search_unexpected: 'onverwacht antwoord van de zoekdienst',
  search_disabled: 'zoeken op naam staat uit',
  search_paused: 'zoekdienst gepauzeerd door de beheerder',
  search_budget: 'grens voor zoekopdrachten (per dag of maand) bereikt',
  search_budget_scan: 'grens van zoekopdrachten per onderzoek bereikt',
};

// Waarom een onderzoek op de achtergrond mislukte (zie jobs/worker.js).
export const JOB_ERRORS = {
  unexpected: 'onverwachte fout (de details staan in de terminal)',
  interrupted: 'te vaak onderbroken door een herstart van de server',
  account_unavailable: 'het account bestaat niet meer, is geblokkeerd of niet bevestigd',
  unknown_kind: 'onbekende soort onderzoek',
};

const account = (d) => (d.account === undefined ? 'een account' : `account #${d.account}`);

function seconds(ms) {
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toLocaleString('nl-NL', { maximumFractionDigits: 1 })} s`;
}

// De meldingen. level: info, warn (let op) of error (fout).
export const EVENTS = {
  server_started: {
    level: 'info',
    text: (d) => `Server gestart${d.mode === 'production' ? ' als openbare site' : ' op je eigen computer'}.`,
  },
  storage_prepared: {
    level: 'info',
    text: (d) => `Bij het starten: ${d.purged ?? 0} verzonnen demo-resultaten gewist, ${d.limited ?? 0} webresultaten kregen een einddatum.`,
  },
  external_failed: {
    level: 'warn',
    text: (d) => (d.failure === 'network'
      ? `${serviceName(d.service)}: geen antwoord (netwerk of time-out).`
      : `${serviceName(d.service)} antwoordde met HTTP ${d.status ?? '?'}.`),
  },
  scan_done: {
    level: 'info',
    text: (d) => `${SCANS[d.scan] ?? 'Onderzoek'}: ${d.found ?? 0} gevonden${d.scan === 'check' ? '' : `, ${d.added ?? 0} nieuw`} (${seconds(d.ms ?? 0)}).`,
  },
  scan_failed: {
    level: 'warn',
    text: (d) => `${SCANS[d.scan] ?? 'Onderzoek'} lukte niet: ${CODE_TEXT[d.code] ?? 'onbekende oorzaak'}.`,
  },
  deep_scan_done: {
    level: 'info',
    text: (d) => `Deep Scan: ${d.done ?? 0} van ${d.total ?? 0} stappen voltooid (${seconds(d.ms ?? 0)}).`,
  },
  source_paused: { level: 'warn', text: (d) => `De beheerder heeft ${serviceName(d.service)} gepauzeerd.` },
  source_resumed: { level: 'info', text: (d) => `De beheerder heeft ${serviceName(d.service)} weer aangezet.` },
  source_test_ok: { level: 'info', text: (d) => `Test van ${serviceName(d.service)} gelukt.` },
  source_test_failed: { level: 'warn', text: (d) => `Test van ${serviceName(d.service)} mislukt.` },
  account_blocked: { level: 'warn', text: (d) => `De beheerder heeft ${account(d)} geblokkeerd.` },
  account_unblocked: { level: 'info', text: (d) => `De beheerder heeft ${account(d)} gedeblokkeerd.` },
  blocked_login: { level: 'warn', text: (d) => `Een geblokkeerd account (${account(d)}) probeerde in te loggen.` },
  admin_login: { level: 'info', text: () => 'De beheerder is ingelogd.' },
  budget_reached: {
    level: 'warn',
    text: (d) => `Kostengrens bereikt: ${serviceName(d.service)} krijgt ${d.period === 'month' ? 'deze maand' : 'vandaag'} geen aanvragen meer van de site.`,
  },
  job_failed: { level: 'warn', text: (d) => `Een onderzoek op de achtergrond mislukte: ${JOB_ERRORS[d.job] ?? JOB_ERRORS.unexpected}.` },
  jobs_requeued: {
    level: 'warn',
    text: (d) => `Na een herstart: ${d.count ?? 0} onderzoek(en) opnieuw in de wachtrij gezet${d.failed ? `, ${d.failed} te vaak onderbroken en gestopt` : ''}.`,
  },
  limit_reached: { level: 'warn', text: (d) => `Limiet van de site bereikt bij ${LIMITS[d.what] ?? 'een verzoek'}.` },
  unexpected_error: {
    level: 'error',
    text: (d) => `Onverwachte fout${d.error ? ` (${d.error})` : ''} bij een verzoek. De details staan in de terminal.`,
  },
};

export const LEVEL_LABELS = { info: 'Info', warn: 'Let op', error: 'Fout' };

// Welke details mogen er in het log, en welke waarden. Al het andere valt weg.
const count = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : undefined);
const oneOf = (list) => (value) => (list.includes(value) ? value : undefined);
const DETAILS = {
  mode: oneOf(['development', 'production']),
  service: oneOf(SERVICE_IDS),
  failure: oneOf(['network', 'http']),
  status: (value) => (Number.isInteger(value) && value >= 100 && value <= 599 ? value : undefined),
  scan: oneOf(Object.keys(SCANS)),
  what: oneOf(Object.keys(LIMITS)),
  code: (value) => (Object.hasOwn(CODE_TEXT, value) ? value : 'unexpected'),
  // De naam van een soort fout (TypeError, SqliteError), nooit de foutmelding zelf.
  error: (value) => (typeof value === 'string' && /^[A-Z][A-Za-z]{0,39}$/.test(value) ? value : undefined),
  found: count,
  added: count,
  done: count,
  total: count,
  ms: count,
  purged: count,
  limited: count,
  account: count,
  count,
  failed: count,
  period: oneOf(['day', 'month']),
  job: (value) => (Object.hasOwn(JOB_ERRORS, value) ? value : 'unexpected'),
};

export function cleanDetail(detail = {}) {
  const clean = {};
  for (const [key, check] of Object.entries(DETAILS)) {
    if (!Object.hasOwn(detail ?? {}, key)) continue;
    const value = check(detail[key]);
    if (value !== undefined) clean[key] = value;
  }
  return clean;
}

// Schrijft een melding in het log. Loggen mag nooit een verzoek laten mislukken: lukt het niet, dan
// komt er één regel in de terminal (zonder details) en gaat de site gewoon door.
export function logEvent(db, code, detail = {}, now = Date.now()) {
  if (!Object.hasOwn(EVENTS, code)) {
    console.error(`Systeemlog: onbekende melding "${String(code).slice(0, 40)}" overgeslagen.`);
    return false;
  }
  try {
    db.prepare('INSERT INTO system_events (at, level, code, detail) VALUES (?, ?, ?, ?)')
      .run(now, EVENTS[code].level, code, JSON.stringify(cleanDetail(detail)));
    return true;
  } catch (error) {
    console.error(`Systeemlog: melding niet opgeslagen (${error?.name ?? 'Error'}).`);
    return false;
  }
}

function parseDetail(text) {
  try {
    return cleanDetail(JSON.parse(text));
  } catch {
    return {};
  }
}

// De nieuwste meldingen, met hun tekst. Met onlyProblems alleen "let op" en "fout".
export function listEvents(db, { limit = 50, onlyProblems = false } = {}) {
  const rows = db.prepare(`
    SELECT id, at, level, code, detail FROM system_events
    ${onlyProblems ? "WHERE level IN ('warn', 'error')" : ''}
    ORDER BY at DESC, id DESC LIMIT ?`).all(limit);
  return rows.map((row) => {
    const event = EVENTS[row.code];
    return {
      id: row.id,
      at: row.at,
      level: row.level,
      levelLabel: LEVEL_LABELS[row.level] ?? row.level,
      code: row.code,
      text: event ? event.text(parseDetail(row.detail)) : 'Onbekende melding.',
    };
  });
}

// Hoeveel meldingen van elk niveau er de afgelopen 24 uur waren.
export function countRecentEvents(db, now = Date.now()) {
  const rows = db.prepare('SELECT level, COUNT(*) AS n FROM system_events WHERE at > ? GROUP BY level')
    .all(now - 24 * 60 * 60 * 1000);
  const counts = { info: 0, warn: 0, error: 0 };
  for (const row of rows) counts[row.level] = row.n;
  return counts;
}

// Wist meldingen ouder dan 30 dagen, en de oudste als er meer dan 2000 zijn.
export function pruneEvents(db, now = Date.now()) {
  db.prepare('DELETE FROM system_events WHERE at <= ?').run(now - EVENT_DAYS * 24 * 60 * 60 * 1000);
  db.prepare(`DELETE FROM system_events WHERE id NOT IN (
    SELECT id FROM system_events ORDER BY at DESC, id DESC LIMIT ?)`).run(EVENT_MAX);
}
