// De Data Broker Engine: gericht zoeken bij de databrokers uit het register (brokers/registry.js), op je
// eigen naam, en per databroker bijhouden wat er gevonden is, wanneer, of het lukte en of het volledig was.
//
// We zoeken via de zoekdienst met site:-zoekopdrachten. De sites zelf openen we niet, en hun eigen
// zoekfunctie gebruiken we niet. Wat we dus wel en niet weten:
//   - een overeenkomst: de zoekdienst kent een pagina op die site waarvan de titel of het fragment je
//     volledige naam, je bevestigde e-mailadres of je bevestigde telefoonnummer noemt. Bij een naam kan
//     dat een naamgenoot zijn;
//   - alleen een mogelijk relevante pagina: wel een pagina op die site, maar zonder je gegevens erin;
//   - niets in de zoekmachine: de zoekdienst kent er niets. Dat betekent NIET dat het bedrijf niets over
//     je heeft: wat niet in een zoekmachine staat, zien wij niet;
//   - database niet toegankelijk: een afgeschermde databroker zonder openbare pagina's.
import { BROKERS, brokerForUrl } from '../brokers/registry.js';
import { isMatch, matchesIn } from '../confidence.js';
import { VIA_LABELS } from '../findings.js';
import { ScanError } from '../scan-error.js';
import { brokerQueries, singleBrokerQuery } from './queries.js';
import { identityOf, searchAndSave } from './web-research.js';

// Bij deze fouten hebben we de databroker bewust niet geprobeerd (pauze of kostengrens).
const SKIPPED = new Set(['search_paused', 'search_budget', 'search_budget_scan']);

// Hoe een databroker op de pagina's staat. `status` in de database is het ruwe resultaat (gevonden,
// niet-gevonden, ...); de uitkomst hieronder komt daaruit en uit het aantal overeenkomsten.
export const BROKER_OUTCOMES = {
  overeenkomst: { label: 'Overeenkomst gevonden', tone: 'warn' },
  mogelijk: { label: 'Mogelijk relevante pagina', tone: 'idle' },
  niets: { label: 'Niets in de zoekmachine', tone: 'idle' },
  'niet-toegankelijk': { label: 'Zoeken mislukt', tone: 'bad' },
  overgeslagen: { label: 'Overgeslagen', tone: 'idle' },
  afgeschermd: { label: 'Database niet toegankelijk', tone: 'idle' },
  'nog-niet': { label: 'Nog niet gecontroleerd', tone: 'idle' },
};

function outcomeOf(status, matched) {
  if (status === 'gevonden') return matched > 0 ? 'overeenkomst' : 'mogelijk';
  if (status === 'niet-gevonden') return 'niets';
  return Object.hasOwn(BROKER_OUTCOMES, status) ? status : 'nog-niet';
}

export function recordBrokerCheck(db, userId, brokerId, {
  status, found = 0, matched = 0, via = [], complete = true,
}, now = Date.now()) {
  db.prepare(`
    INSERT INTO broker_checks (user_id, broker_id, status, found, matched, via, complete, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (user_id, broker_id) DO UPDATE SET
      status = excluded.status, found = excluded.found, matched = excluded.matched, via = excluded.via,
      complete = excluded.complete, checked_at = excluded.checked_at`)
    .run(userId, brokerId, status, found, matched, [...new Set(via)].join(','), complete ? 1 : 0, now);
}

// Bij welke databrokers staan deze resultaten? (Voor de tekst bij een stap; dit bewaart niets.)
export function brokersIn(results) {
  return [...new Set(results.map((result) => brokerForUrl(result.url)?.id).filter(Boolean))];
}

function parseDetails(details) {
  try {
    const parsed = JSON.parse(details);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

const viaList = (details) => (Array.isArray(details.via) ? details.via.filter((item) => typeof item === 'string') : []);
const textOf = (result) => `${result.title ?? ''} ${result.snippet ?? ''}`;

// Aan het eind van het webonderzoek van een Deep Scan: per databroker de unieke pagina's die deze scan
// vond, hoeveel daarvan je gegevens noemen, en met welke gegevens ze gevonden zijn. Een pagina die met
// je naam én je telefoonnummer is gevonden, telt zo één keer, en een vermelding die de gewone zoekopdracht
// op je naam (of je telefoonnummer of e-mailadres) vond, telt ook mee. Databrokers zonder treffer houden
// wat scanBrokers vastlegde. Geeft de ids van de databrokers met een treffer.
export function recordBrokerFindings(db, user, now) {
  const who = identityOf(user);
  const rows = db.prepare("SELECT url, title, details FROM findings WHERE user_id = ? AND kind = 'web' AND checked_at = ?")
    .all(user.id, now);
  const hits = new Map();
  for (const row of rows) {
    const broker = brokerForUrl(row.url);
    if (!broker) continue;
    const details = parseDetails(row.details);
    const entry = hits.get(broker.id) ?? { urls: new Set(), matched: new Set(), via: new Set() };
    entry.urls.add(row.url);
    if (isMatch(matchesIn(textOf({ title: row.title, snippet: details.snippet }), who))) entry.matched.add(row.url);
    for (const item of viaList(details)) entry.via.add(item);
    hits.set(broker.id, entry);
  }
  const order = Object.keys(VIA_LABELS); // naam, telefoon, e-mail: altijd in dezelfde volgorde
  const read = db.prepare('SELECT complete FROM broker_checks WHERE user_id = ? AND broker_id = ?');
  for (const [brokerId, { urls, matched, via }] of hits) {
    const sorted = [...via].sort((a, b) => order.indexOf(a) - order.indexOf(b));
    const complete = (read.get(user.id, brokerId)?.complete ?? 1) === 1;
    recordBrokerCheck(db, user.id, brokerId, {
      status: 'gevonden', found: urls.size, matched: matched.size, via: sorted, complete,
    }, now);
  }
  return [...hits.keys()];
}

// Per databroker uit het register: de toestand voor dit account. Afgeschermde databrokers krijgen
// "database niet toegankelijk", databrokers waar nog nooit naar gekeken is "nog niet gecontroleerd".
export function brokerOverview(db, userId) {
  const checks = new Map(db.prepare('SELECT * FROM broker_checks WHERE user_id = ?').all(userId)
    .map((row) => [row.broker_id, row]));
  return BROKERS.map((broker) => {
    const check = checks.get(broker.id);
    const status = broker.access === 'closed' ? 'afgeschermd' : (check?.status ?? 'nog-niet');
    const outcome = outcomeOf(status, check?.matched ?? 0);
    return {
      broker,
      status,
      outcome,
      ...BROKER_OUTCOMES[outcome],
      found: check?.found ?? 0,
      matched: check?.matched ?? 0,
      complete: (check?.complete ?? 1) === 1,
      via: check?.via ? check.via.split(',').filter(Boolean) : [],
      checkedAt: check?.checked_at ?? null,
    };
  });
}

// Zoekt bij alle doorzoekbare databrokers op je naam, één zoekopdracht per groepje (zie
// brokers/registry.js). Geeft de zoekdienst voor een groepje het maximum aantal resultaten, dan kunnen er
// resultaten weggevallen zijn: dan zoeken we per databroker uit dat groepje apart (als de kostengrens dat
// toelaat). Lukt een groepje niet, dan lopen de andere wel door; lukt er niets, dan gooit dit de fout van
// het laatste groepje. Geeft { found, added, withHits, matched, possible, incomplete, extra, checked,
// skipped, failed, error, results }.
export async function scanBrokers({
  db, user, search, now = Date.now(),
}) {
  const queries = brokerQueries(user.name);
  if (queries.length === 0) throw new ScanError('name_too_short');
  const who = identityOf(user);
  // Hoeveel resultaten de zoekdienst hooguit per zoekopdracht geeft (Brave: 20). Onbekend = nooit "vol".
  const pageSize = Number(search.settings?.count) || null;
  const full = (total) => pageSize !== null && total >= pageSize;
  const outcome = {
    found: 0, added: 0, withHits: [], matched: [], possible: [], incomplete: [], extra: 0, checked: 0, skipped: 0, failed: 0, error: null, results: [],
  };

  const run = async (query, brokers) => {
    const ids = new Set(brokers.map((broker) => broker.id));
    const result = await searchAndSave({
      db, user, search, query, via: 'naam', now, keep: (item) => ids.has(brokerForUrl(item.url)?.id),
    });
    outcome.added += result.added;
    return result;
  };

  for (const { brokers, query } of queries) {
    const perBroker = new Map(brokers.map((broker) => [broker.id, { results: [], complete: true }]));
    let group;
    try {
      group = await run(query, brokers);
    } catch (error) {
      if (!(error instanceof ScanError)) throw error;
      outcome.error = error;
      const status = SKIPPED.has(error.code) ? 'overgeslagen' : 'niet-toegankelijk';
      if (status === 'overgeslagen') outcome.skipped += brokers.length;
      else outcome.failed += brokers.length;
      for (const broker of brokers) recordBrokerCheck(db, user.id, broker.id, { status }, now);
      continue;
    }
    for (const item of group.results) perBroker.get(brokerForUrl(item.url).id).results.push(item);

    if (full(group.total) && brokers.length > 1) {
      // Vol: per databroker apart, zodat de ene de resultaten van de andere niet wegdrukt.
      for (const broker of brokers) {
        const entry = perBroker.get(broker.id);
        try {
          const single = await run(singleBrokerQuery(user.name, broker), [broker]);
          outcome.extra += 1;
          const seen = new Set(entry.results.map((item) => item.url));
          for (const item of single.results) if (!seen.has(item.url)) entry.results.push(item);
          entry.complete = !full(single.total);
        } catch (error) {
          if (!(error instanceof ScanError)) throw error;
          outcome.error = error;
          entry.complete = false; // wat het groepje gaf, blijft; meer konden we niet zien
        }
      }
    } else if (full(group.total)) {
      perBroker.get(brokers[0].id).complete = false;
    }

    for (const broker of brokers) {
      const { results, complete } = perBroker.get(broker.id);
      const matched = results.filter((item) => isMatch(matchesIn(textOf(item), who))).length;
      recordBrokerCheck(db, user.id, broker.id, {
        status: results.length > 0 ? 'gevonden' : 'niet-gevonden',
        found: results.length,
        matched,
        via: results.length > 0 ? ['naam'] : [],
        complete,
      }, now);
      outcome.checked += 1;
      outcome.found += results.length;
      outcome.results.push(...results);
      if (results.length > 0) outcome.withHits.push(broker.id);
      if (matched > 0) outcome.matched.push(broker.id);
      else if (results.length > 0) outcome.possible.push(broker.id);
      if (!complete) outcome.incomplete.push(broker.id);
    }
  }
  if (outcome.checked === 0 && outcome.error) throw outcome.error;
  return outcome;
}
