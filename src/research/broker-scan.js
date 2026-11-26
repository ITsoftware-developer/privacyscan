// De Data Broker Engine: gericht zoeken bij de databrokers uit het register (brokers/registry.js), op je
// eigen naam, en per databroker bijhouden wat er gevonden is, wanneer en of het lukte.
//
// We zoeken via de zoekdienst met site:-zoekopdrachten. De sites zelf openen we niet, en hun eigen
// zoekfunctie gebruiken we niet. "Gevonden" betekent: de zoekdienst kent een pagina op die site met je
// volledige naam. Dat kan een naamgenoot zijn; daarom heet het een mogelijke vermelding.
import { BROKERS, brokerForUrl } from '../brokers/registry.js';
import { VIA_LABELS } from '../findings.js';
import { ScanError } from '../scan-error.js';
import { brokerQueries } from './queries.js';
import { searchAndSave } from './web-research.js';

// Bij deze fouten hebben we de databroker bewust niet geprobeerd (pauze of kostengrens).
const SKIPPED = new Set(['search_paused', 'search_budget', 'search_budget_scan']);

export const BROKER_STATUSES = {
  gevonden: { label: 'Mogelijke vermelding', tone: 'warn' },
  'niet-gevonden': { label: 'Niets gevonden', tone: 'ok' },
  'niet-toegankelijk': { label: 'Niet toegankelijk', tone: 'bad' },
  overgeslagen: { label: 'Overgeslagen', tone: 'idle' },
  afgeschermd: { label: 'Afgeschermd', tone: 'idle' },
  'nog-niet': { label: 'Nog niet gecontroleerd', tone: 'idle' },
};

export function recordBrokerCheck(db, userId, brokerId, {
  status, found = 0, via = [],
}, now = Date.now()) {
  db.prepare(`
    INSERT INTO broker_checks (user_id, broker_id, status, found, via, checked_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (user_id, broker_id) DO UPDATE SET
      status = excluded.status, found = excluded.found, via = excluded.via, checked_at = excluded.checked_at`)
    .run(userId, brokerId, status, found, [...new Set(via)].join(','), now);
}

// Bij welke databrokers staan deze resultaten? (Voor de tekst bij een stap; dit bewaart niets.)
export function brokersIn(results) {
  return [...new Set(results.map((result) => brokerForUrl(result.url)?.id).filter(Boolean))];
}

function viaList(details) {
  try {
    const list = JSON.parse(details).via;
    return Array.isArray(list) ? list.filter((item) => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

// Aan het eind van het webonderzoek van een Deep Scan: per databroker de unieke pagina's die deze scan
// vond, met elk gegeven waarmee ze gevonden zijn. Een pagina die met je naam én je telefoonnummer is
// gevonden, telt zo één keer, en een vermelding die de gewone zoekopdracht op je naam (of je telefoonnummer
// of e-mailadres) vond, telt ook mee. Databrokers zonder treffer houden wat scanBrokers vastlegde (niets
// gevonden, niet toegankelijk of overgeslagen). Geeft de ids van de databrokers met een treffer.
export function recordBrokerFindings(db, userId, now) {
  const rows = db.prepare("SELECT url, details FROM findings WHERE user_id = ? AND kind = 'web' AND checked_at = ?")
    .all(userId, now);
  const hits = new Map();
  for (const row of rows) {
    const broker = brokerForUrl(row.url);
    if (!broker) continue;
    const entry = hits.get(broker.id) ?? { urls: new Set(), via: new Set() };
    entry.urls.add(row.url);
    for (const item of viaList(row.details)) entry.via.add(item);
    hits.set(broker.id, entry);
  }
  const order = Object.keys(VIA_LABELS); // naam, telefoon, e-mail: altijd in dezelfde volgorde
  for (const [brokerId, { urls, via }] of hits) {
    const sorted = [...via].sort((a, b) => order.indexOf(a) - order.indexOf(b));
    recordBrokerCheck(db, userId, brokerId, { status: 'gevonden', found: urls.size, via: sorted }, now);
  }
  return [...hits.keys()];
}

// Per databroker uit het register: de toestand voor dit account. Afgeschermde databrokers krijgen
// "afgeschermd", databrokers waar nog nooit naar gekeken is "nog niet gecontroleerd".
export function brokerOverview(db, userId) {
  const checks = new Map(db.prepare('SELECT * FROM broker_checks WHERE user_id = ?').all(userId)
    .map((row) => [row.broker_id, row]));
  return BROKERS.map((broker) => {
    const check = checks.get(broker.id);
    const status = broker.access === 'closed' ? 'afgeschermd' : (check?.status ?? 'nog-niet');
    return {
      broker,
      status,
      ...BROKER_STATUSES[status],
      found: check?.found ?? 0,
      via: check?.via ? check.via.split(',').filter(Boolean) : [],
      checkedAt: check?.checked_at ?? null,
    };
  });
}

// Zoekt bij alle doorzoekbare databrokers op je naam. Lukt een groepje niet, dan lopen de andere wel
// door; lukt er niets, dan gooit dit de fout van het laatste groepje. Geeft
// { found, added, withHits: [brokerId], checked, skipped, failed, error }.
export async function scanBrokers({
  db, user, search, now = Date.now(),
}) {
  const queries = brokerQueries(user.name);
  if (queries.length === 0) throw new ScanError('name_too_short');
  const outcome = {
    found: 0, added: 0, withHits: [], checked: 0, skipped: 0, failed: 0, error: null, results: [],
  };
  for (const { brokers, query } of queries) {
    const ids = new Set(brokers.map((broker) => broker.id));
    try {
      const { results, added } = await searchAndSave({
        db, user, search, query, via: 'naam', now, keep: (result) => ids.has(brokerForUrl(result.url)?.id),
      });
      outcome.found += results.length;
      outcome.added += added;
      outcome.checked += brokers.length;
      outcome.results.push(...results);
      for (const broker of brokers) {
        const hits = results.filter((result) => brokerForUrl(result.url)?.id === broker.id).length;
        recordBrokerCheck(db, user.id, broker.id, {
          status: hits > 0 ? 'gevonden' : 'niet-gevonden', found: hits, via: hits > 0 ? ['naam'] : [],
        }, now);
        if (hits > 0) outcome.withHits.push(broker.id);
      }
    } catch (error) {
      if (!(error instanceof ScanError)) throw error;
      outcome.error = error;
      const status = SKIPPED.has(error.code) ? 'overgeslagen' : 'niet-toegankelijk';
      if (status === 'overgeslagen') outcome.skipped += brokers.length;
      else outcome.failed += brokers.length;
      for (const broker of brokers) recordBrokerCheck(db, user.id, broker.id, { status }, now);
    }
  }
  if (outcome.checked === 0 && outcome.error) throw outcome.error;
  return outcome;
}
