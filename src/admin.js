// Alles wat de beheerpagina laat zien (routes-admin.js, views/beheerder.ejs), en de twee dingen die
// je er met een account kunt doen: blokkeren en deblokkeren.
//
// Dit is een technisch controlecentrum. Er staan tellers, statussen en datums op. Wat er over iemand
// gevonden is, zijn naam, woonplaats en zoekopdrachten komen er niet op: die heeft de beheerder
// niet nodig om de site te laten werken.
import { SESSION_DAYS } from './auth.js';
import { BROKERS, CHECKED as BROKERS_CHECKED, brokerForUrl, searchGroups } from './brokers/registry.js';
import { DEFAULT_LIMITS, budgetState } from './budget.js';
import { CONFIRM_MINUTES } from './confirm.js';
import { canPause, pausedSince } from './controls.js';
import { inTransaction } from './db.js';
import { describeStep } from './engine.js';
import { EVENT_DAYS, EVENT_MAX } from './events.js';
import { PEOPLE_SEARCH } from './extract.js';
import { windowLabel } from './monitor.js';
import { WEB_RESULT_MINUTES } from './retention.js';
import { SERVICES } from './services.js';

const DAY = 24 * 60 * 60 * 1000;

// Wat Brave rekent voor de Search API, volgens hun eigen site (brave.com/search/api) in november 2026:
// $5 per 1.000 aanvragen, met elke maand $5 gratis tegoed. Alleen geslaagde aanvragen tellen mee.
// Dit is een schatting: je echte rekening staat in je Brave-dashboard.
export const BRAVE_PRICE = { perThousandUsd: 5, monthlyCreditUsd: 5, checked: 'november 2026' };

export function braveCost(successfulCalls) {
  const usd = (successfulCalls * BRAVE_PRICE.perThousandUsd) / 1000;
  return { usd, afterCreditUsd: Math.max(0, usd - BRAVE_PRICE.monthlyCreditUsd) };
}

// --- Opmaak, voor de pagina ------------------------------------------------------------------------

export const format = {
  number: (value) => Number(value ?? 0).toLocaleString('nl-NL'),
  // "1 open sessie", "3 open sessies"
  count: (value, one, many) => `${Number(value ?? 0).toLocaleString('nl-NL')} ${Number(value) === 1 ? one : many}`,
  usd: (value) => `$${Number(value).toLocaleString('nl-NL', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
  ms: (value) => (value === null || value === undefined ? 'onbekend'
    : value < 1000 ? `${value} ms` : `${(value / 1000).toLocaleString('nl-NL', { maximumFractionDigits: 1 })} s`),
  bytes: (value) => {
    if (value < 1024) return `${value} bytes`;
    if (value < 1024 * 1024) return `${(value / 1024).toLocaleString('nl-NL', { maximumFractionDigits: 0 })} kB`;
    return `${(value / 1024 / 1024).toLocaleString('nl-NL', { maximumFractionDigits: 1 })} MB`;
  },
  // Hoe lang iets al duurt: "3 dagen en 2 uur", "5 minuten".
  duration: (ms) => {
    const minutes = Math.floor(ms / 60000);
    if (minutes < 1) return 'minder dan een minuut';
    if (minutes < 60) return minutes === 1 ? '1 minuut' : `${minutes} minuten`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return hours === 1 ? '1 uur' : `${hours} uur`;
    const days = Math.floor(hours / 24);
    const rest = hours % 24;
    return `${days === 1 ? '1 dag' : `${days} dagen`}${rest ? ` en ${rest} uur` : ''}`;
  },
  windowLabel,
};

// --- Accounts --------------------------------------------------------------------------------------

// De aantallen en de lijst van accounts, nieuwste eerst. Per account alleen wat nodig is om de site
// te beheren: het e-mailadres, de datums en of het bevestigd of geblokkeerd is.
export function accountOverview(db, { now = Date.now(), limit = 100 } = {}) {
  const row = db.prepare(`
    SELECT COUNT(*) AS total,
           COUNT(email_confirmed_at) AS confirmed,
           COUNT(blocked_at) AS blocked,
           COALESCE(SUM(created_at > ?), 0) AS recent
    FROM users`).get(now - 7 * DAY);
  const accounts = db.prepare(`
    SELECT users.id, users.email, users.created_at, users.email_confirmed_at, users.blocked_at,
           (SELECT MAX(scans.ran_at) FROM scans WHERE scans.user_id = users.id) AS last_scan_at
    FROM users
    ORDER BY users.created_at DESC, users.id DESC
    LIMIT ?`).all(limit);
  return {
    counts: {
      total: row.total, confirmed: row.confirmed, unconfirmed: row.total - row.confirmed, blocked: row.blocked, recent: row.recent,
    },
    accounts: accounts.map((account) => ({ ...account })),
    shown: accounts.length,
  };
}

export function accountExists(db, id) {
  return db.prepare('SELECT 1 FROM users WHERE id = ?').get(id) !== undefined;
}

// Blokkeert een account: inloggen kan niet meer, en open sessies stoppen meteen. Geeft true als het
// account nog niet geblokkeerd was.
export function blockAccount(db, id, now = Date.now()) {
  return inTransaction(db, () => {
    const changed = db.prepare('UPDATE users SET blocked_at = ? WHERE id = ? AND blocked_at IS NULL').run(now, id).changes > 0;
    if (changed) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    return changed;
  });
}

export function unblockAccount(db, id) {
  return db.prepare('UPDATE users SET blocked_at = NULL WHERE id = ? AND blocked_at IS NOT NULL').run(id).changes > 0;
}

// --- Onderzoeken -----------------------------------------------------------------------------------

// De nieuwste Deep Scans: wanneer, van welk account (alleen het nummer) en hoe elke stap afliep.
// Zonder de tekst bij de stappen: daar staat in wat er over iemand gevonden is.
export function recentRuns(db, { limit = 15 } = {}) {
  return db.prepare('SELECT user_id, ran_at, steps FROM scan_runs ORDER BY ran_at DESC LIMIT ?').all(limit).map((row) => {
    let steps = [];
    try {
      steps = JSON.parse(row.steps);
    } catch {
      steps = [];
    }
    const list = (Array.isArray(steps) ? steps : []).map((step) => {
      const { title, tone, label } = describeStep(step);
      return { id: String(step?.id ?? ''), status: String(step?.status ?? ''), title, tone, label };
    });
    return {
      account: row.user_id, ranAt: row.ran_at, steps: list, done: list.filter((step) => step.status === 'done').length,
    };
  });
}

// De nieuwste losse scans: soort, aantallen en datum. Bewust zonder de kolom met de zoekopdracht
// (daar staan iemands naam en woonplaats in).
export function recentScans(db, { limit = 15 } = {}) {
  return db.prepare('SELECT user_id, kind, ran_at, found_count, new_count FROM scans ORDER BY ran_at DESC LIMIT ?')
    .all(limit)
    .map((row) => ({ ...row }));
}

// Hoeveel bevindingen er nu in de database staan (webresultaten alleen zolang ze mogen blijven).
export function findingTotals(db, now = Date.now()) {
  const row = db.prepare(`
    SELECT COALESCE(SUM(kind = 'breach'), 0) AS breaches,
           COALESCE(SUM(kind = 'web' AND (expires_at IS NULL OR expires_at > ?)), 0) AS web
    FROM findings`).get(now);
  const choices = db.prepare('SELECT COUNT(*) AS n FROM web_choices').get().n;
  return { breaches: row.breaches, web: row.web, choices };
}

// --- Systeem ---------------------------------------------------------------------------------------

export function databaseStatus(db) {
  const { version } = db.prepare('SELECT sqlite_version() AS version').get();
  const pages = db.prepare('PRAGMA page_count').get().page_count;
  const pageSize = db.prepare('PRAGMA page_size').get().page_size;
  const count = (table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  return {
    version, bytes: pages * pageSize, sessions: count('sessions'), events: count('system_events'),
  };
}

// Welke dienst zit er achter de zoekdienst? 'brave', of null voor de demo en onbekende diensten.
export function searchServiceId(search) {
  if (!search || search.isDemo) return null;
  const id = String(search.id ?? search.name ?? '');
  return Object.hasOwn(SERVICES, id) ? id : null;
}

const STATES = {
  actief: { label: 'Actief', tone: 'ok' },
  gepauzeerd: { label: 'Gepauzeerd', tone: 'warn' },
  'niet-ingesteld': { label: 'Niet ingesteld', tone: 'idle' },
  testmodus: { label: 'Alleen testadressen', tone: 'warn' },
  uit: { label: 'Uit', tone: 'idle' },
  demo: { label: 'Demo (nepdata)', tone: 'warn' },
  grens: { label: 'Kostengrens bereikt', tone: 'warn' },
};

// De externe bronnen, met hun toestand, hun laatste aanvraag, hun laatste test en de knoppen die
// erbij horen. `search` en `check` zijn de koppelingen zelf (zonder pauzeknop ervoor).
export function sourceRows({
  db, search, check, live, budget = DEFAULT_LIMITS, now = Date.now(),
}) {
  const searchId = searchServiceId(search);
  const xon = check?.adapters?.xon ?? null;
  const hibp = check?.adapters?.hibp ?? null;
  const rows = [];
  const add = (row) => {
    const paused = canPause(row.id) && row.configured ? pausedSince(db, row.id) : null;
    let state = paused !== null ? 'gepauzeerd' : row.state;
    if (state === 'actief' && row.id === searchId && budgetState(db, row.id, budget, now).reached) state = 'grens';
    rows.push({
      ...row,
      state,
      stateLabel: STATES[state].label,
      tone: STATES[state].tone,
      pausedSince: paused,
      canPause: canPause(row.id) && row.configured,
      live: Object.hasOwn(live, row.id) ? live[row.id] : null,
    });
  };

  if (searchId) {
    add({
      id: searchId,
      name: SERVICES[searchId].name,
      use: 'Zoeken op het web (je naam en woonplaats)',
      state: 'actief',
      configured: true,
      canTest: true,
      note: search.retainsResults ? 'Resultaten worden bewaard (BRAVE_STORAGE_RIGHTS=on).' : `Resultaten blijven ${WEB_RESULT_MINUTES} minuten staan.`,
    });
  } else {
    add({
      id: 'brave',
      name: 'Brave Search',
      use: 'Zoeken op het web (je naam en woonplaats)',
      state: search?.isDemo ? 'demo' : 'niet-ingesteld',
      configured: false,
      canTest: false,
      note: search?.isDemo
        ? 'SEARCH_PROVIDER=demo staat aan: de site verzint resultaten en stuurt niets naar buiten.'
        : 'De site is gestart zonder BRAVE_API_KEY. Staat de sleutel al in je .env? Start de site dan opnieuw: hij leest .env alleen bij het starten.',
    });
  }

  add({
    id: 'xon',
    name: SERVICES.xon.name,
    use: 'Datalekken (gratis, zonder sleutel)',
    state: xon ? 'actief' : 'uit',
    configured: Boolean(xon),
    canTest: Boolean(xon?.listSize),
    note: xon
      ? 'Gratis, voor de hele site samen hooguit 25 controles per uur en 100 per dag.'
      : (hibp?.hasKey ? 'Niet nodig: de site gebruikt je eigen HIBP-sleutel.' : 'Staat uit. Met FREE_BREACH_CHECK=on controleert de site echte adressen gratis.'),
  });

  add({
    id: 'hibp',
    name: SERVICES.hibp.name,
    use: 'Datalekken',
    state: hibp?.hasKey ? 'actief' : 'testmodus',
    configured: Boolean(hibp),
    canTest: Boolean(hibp),
    note: hibp?.hasKey
      ? 'Met je eigen sleutel (HIBP_API_KEY): elk adres gaat naar Have I Been Pwned.'
      : 'Zonder eigen sleutel werken alleen de testadressen van Have I Been Pwned.',
  });

  add({
    id: 'pwned-passwords',
    name: SERVICES['pwned-passwords'].name,
    use: 'Wachtwoordcontrole bij het aanmaken van een account',
    state: 'actief',
    configured: true,
    canTest: false,
    note: 'Er gaan alleen de eerste 5 tekens van de hash van het wachtwoord heen. Antwoordt de dienst niet, dan gaat het aanmelden gewoon door.',
  });

  return rows;
}

// Het verbruik per dienst, met voor Brave de limieten die Brave zelf meegaf en een schatting van de kosten.
export function usageOverview({
  usage, live, db, budget = DEFAULT_LIMITS, now = Date.now(),
}) {
  const services = Object.entries(usage.services).map(([id, counts]) => ({ id, name: SERVICES[id].name, ...counts }));
  const brave = usage.services.brave;
  const successful = brave.month.calls - brave.month.errors;
  return {
    today: usage.today,
    month: usage.month,
    previous: usage.previous,
    services,
    brave: {
      successful,
      cost: braveCost(successful),
      price: BRAVE_PRICE,
      limits: live.brave?.limits ?? null,
      limitsAt: live.brave?.limitsAt ?? null,
      budget: budgetState(db, 'brave', budget, now),
      perScan: budget.perScan,
    },
  };
}

const seconds = (ms) => `${(ms / 1000).toLocaleString('nl-NL', { maximumFractionDigits: 1 })} s`;

// De instellingen die nu gelden, met hun waarde. Ze staan in de code en in .env; deze pagina laat ze
// alleen zien.
export function scannerSettings({
  limits, search, check, budget = DEFAULT_LIMITS,
}) {
  const rows = [
    ['Zoeken per account', `${limits.scanLimit} keer per uur in datalekken en ${limits.scanLimit} keer per uur op het web. De Deep Scan telt voor allebei.`],
    ['Openbare e-mailcontrole', `${limits.checkLimit} controles per uur per IP-adres.`],
    ['Inloggen', `Na ${limits.loginLimit} mislukte pogingen per IP-adres, of ${limits.accountLimit} per account, een kwartier wachten.`],
    ['Aanmelden', `${limits.registerLimit} nieuwe accounts per uur per IP-adres.`],
    ['Nieuwe bevestigingsmail', `${limits.resendLimit} per uur per account. Een link is ${CONFIRM_MINUTES} minuten geldig.`],
    ['Ingelogd blijven', `${SESSION_DAYS} dagen.`],
    ['Testknoppen op deze pagina', `${limits.testLimit} tests per uur.`],
    ['Kostenlimieten zoekdienst', `Hooguit ${budget.perDay} zoekopdrachten per dag, ${budget.perMonth} per maand en ${budget.perScan} per Deep Scan (BRAVE_MAX_PER_DAY, BRAVE_MAX_PER_MONTH en MAX_QUERIES_PER_SCAN in .env). Bereikt: geen aanvragen meer tot de dag of maand om is.`],
  ];
  const braveSettings = searchServiceId(search) === 'brave' ? search.settings : null;
  if (braveSettings) {
    rows.push(['Brave Search', `${braveSettings.count} resultaten per zoekopdracht, land ${braveSettings.country}, veilig zoeken: ${braveSettings.safesearch}, minstens ${seconds(braveSettings.minIntervalMs)} tussen twee aanvragen, time-out ${seconds(braveSettings.timeoutMs)}.`]);
  }
  let keep = `${WEB_RESULT_MINUTES} minuten, omdat de zoekdienst bewaren niet toestaat. De keuzes van gebruikers blijven, als vingerafdruk van het adres.`;
  if (!search) keep = 'Er is geen zoekdienst, dus er komen geen webresultaten bij.';
  else if (search.isDemo) keep = 'Verzonnen demo-resultaten blijven staan tot de site met een echte zoekdienst (of zonder zoekdienst) start; dan worden ze gewist.';
  else if (search.retainsResults) keep = 'Zolang het account bestaat (opslagrechten aan).';
  rows.push(['Webresultaten bewaren', keep]);
  const xon = check?.adapters?.xon?.settings;
  if (xon) {
    rows.push(['XposedOrNot', `Hooguit ${xon.perHour} controles per uur en ${xon.perDay} per dag (de grens van de dienst), minstens ${seconds(xon.minIntervalMs)} tussen twee aanvragen, time-out ${seconds(xon.timeoutMs)}.`]);
  }
  const hibp = check?.adapters?.hibp?.settings;
  if (hibp) {
    rows.push(['Have I Been Pwned', `Minstens ${seconds(hibp.minIntervalMs)} tussen twee aanvragen, time-out ${seconds(hibp.timeoutMs)}.`]);
  }
  rows.push(['Systeemlog', `Hooguit ${EVENT_DAYS} dagen en ${EVENT_MAX} meldingen.`]);
  return rows.map(([label, value]) => ({ label, value }));
}

// --- Data Broker Engine -------------------------------------------------------------------------------

// Het register met per databroker alleen technische totalen: bij hoeveel accounts de laatste controle in
// de afgelopen 30 dagen viel, hoe vaak de zoekdienst niet bereikbaar was of een grens bereikt was, en
// wanneer er voor het laatst gekeken is. Niet wie er gevonden is, en ook niet hoe vaak: dat is van de
// gebruikers zelf.
export function brokerEngineOverview(db, now = Date.now()) {
  const since = now - 30 * DAY;
  const stats = new Map(db.prepare(`
    SELECT broker_id,
           COUNT(*) AS checked,
           COALESCE(SUM(status = 'niet-toegankelijk'), 0) AS failed,
           COALESCE(SUM(status = 'overgeslagen'), 0) AS skipped,
           MAX(checked_at) AS last
    FROM broker_checks WHERE checked_at >= ? GROUP BY broker_id`).all(since).map((row) => [row.broker_id, row]));
  const rows = BROKERS.map((broker) => {
    const row = stats.get(broker.id);
    return {
      broker,
      checked: row?.checked ?? 0,
      failed: row?.failed ?? 0,
      skipped: row?.skipped ?? 0,
      last: row?.last ?? null,
    };
  });
  return {
    checkedOn: BROKERS_CHECKED,
    rows,
    searchable: BROKERS.filter((broker) => broker.access === 'search').length,
    closed: BROKERS.filter((broker) => broker.access === 'closed'),
    queriesPerScan: searchGroups().length,
    // Personenzoeksites die de site herkent in gewone zoekresultaten, maar waar we niet gericht zoeken.
    recognized: PEOPLE_SEARCH.filter((domain) => !brokerForUrl(`https://${domain}/`)),
  };
}

// Wat er nog niet is. Liever eerlijk op de pagina dan een knop die niets doet.
export function notBuilt() {
  return [
    { name: 'AI-engine', text: 'Er is nog geen AI-model gekoppeld. Er is dus ook geen AI-activiteit en geen AI-verbruik om te tonen.' },
    { name: 'Darkweb', text: 'Er is geen geautoriseerde aanbieder gekoppeld. De Deep Scan zegt dat eerlijk; een eigen darkweb-crawler bouwen we niet.' },
    { name: 'Sms-dienst', text: 'Er is nog geen sms-dienst gekoppeld. Op je eigen computer komen de codes in het testpostvak (/dev/sms); op een openbare site kan niemand een telefoonnummer bevestigen, en onderzoeken we dus geen telefoonnummers.' },
    { name: 'Pagina’s zelf onderzoeken', text: 'De scanner leest nu alleen de titel, het fragment en het adres dat de zoekdienst teruggeeft. Hij opent de pagina zelf niet.' },
    { name: 'Automatisch opnieuw scannen', text: 'Komt in de fase Monitoring.' },
    { name: 'Tweestapsverificatie', text: 'Inloggen als beheerder kan nu met alleen je e-mailadres en wachtwoord. Zet de site niet openbaar voordat tweestapsverificatie er is.' },
    { name: 'Bronnen toevoegen of instellen', text: 'Een nieuwe bron is nieuwe code, en sleutels staan in .env. Op deze pagina kun je bronnen alleen testen en pauzeren.' },
  ];
}

// Een omschrijving van de manier waarop de site nu draait, uit wat er bij het starten gelezen is.
export function systemStatus({ db, monitor, production, search, check, mailer, now = Date.now() }) {
  const searchId = searchServiceId(search);
  let searchText = 'Niet ingesteld: de site is gestart zonder BRAVE_API_KEY.';
  if (search?.isDemo) searchText = 'Demo met verzonnen resultaten (SEARCH_PROVIDER=demo).';
  else if (searchId) searchText = `${SERVICES[searchId].name}${search.retainsResults ? ', resultaten worden bewaard' : `, resultaten blijven ${WEB_RESULT_MINUTES} minuten`}.`;
  else if (search) searchText = `${search.label ?? search.name ?? 'Onbekende zoekdienst'}.`;

  const hibp = check?.adapters?.hibp ?? null;
  const xon = check?.adapters?.xon ?? null;
  let breachText = 'Alleen de testadressen van Have I Been Pwned.';
  if (hibp?.hasKey || (!check?.adapters && check?.hasKey)) breachText = 'Have I Been Pwned, met je eigen sleutel.';
  else if (xon) breachText = 'XposedOrNot (gratis), en de testadressen via Have I Been Pwned.';

  return {
    startedAt: monitor.startedAt,
    uptime: now - monitor.startedAt,
    node: process.version,
    mode: production ? 'Openbare site (production)' : 'Op je eigen computer (development)',
    production,
    search: searchText,
    searchMissing: !search,
    breaches: breachText,
    mail: mailer?.usesSmtp ? 'Via je mailserver (SMTP_URL).' : 'Testpostvak op /dev/mails (geen echte mail).',
    database: databaseStatus(db),
  };
}
