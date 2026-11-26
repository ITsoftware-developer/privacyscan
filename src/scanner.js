// De Deep Scan: één knop die alle bronnen onderzoekt die voor dit account beschikbaar zijn, en
// daarna eerlijk zegt wat er gelopen is.
//
// Elke stap eindigt in een van deze toestanden (zie STATUSES in engine.js):
//   done         de stap is gelopen
//   unreachable  de bron was er, maar we kwamen er niet bij (storing, limiet, sleutel geweigerd)
//   unavailable  er is geen bron ingesteld
//   skipped      het mag of kan nu niet (bijvoorbeeld zoeken op naam op een openbare site)
//   planned      de stap bestaat nog niet
//   failed       er ging iets mis in de scanner zelf
//
// Eén stap die niet lukt, stopt de rest niet. De scanner verzint niets: een stap die niet gelopen
// is, krijgt nooit de status "voltooid".
import {
  STEP_DEFS, STEP_TITLES, exposureFrom, exposureNote, verifyFindings, verifyNote,
} from './engine.js';
import { BROKERS, brokerById } from './brokers/registry.js';
import { lastScan, listFindings, recordScan, saveRun } from './findings.js';
import { brokersIn, recordBrokerFindings, scanBrokers } from './research/broker-scan.js';
import {
  DOCUMENT_TYPES, SOCIAL_SITES, documentsQuery, emailQuery, phoneQuery, socialQuery,
} from './research/queries.js';
import { searchAndSave } from './research/web-research.js';
import { ScanError } from './scan-error.js';
import { scanBreaches, scanWeb, searchSourceId } from './scans.js';
import { WEB_RESULT_MINUTES } from './retention.js';
import { sourceById } from './sources.js';

// Wat we bij een fout in het rapport zetten. Geen technische details, en nooit een adres.
const REASONS = {
  no_key: 'Voor dit e-mailadres is geen bron beschikbaar. Zet een HIBP-sleutel of de gratis controle aan.',
  bad_key: 'De bron accepteerde de sleutel niet.',
  rate_limited: 'De bron staat nu geen aanvragen meer toe (limiet bereikt). Probeer het later nog eens.',
  busy: 'Er liepen al veel controles tegelijk. Probeer het later nog eens.',
  unavailable: 'De bron was niet bereikbaar.',
  unexpected: 'De bron gaf een onverwacht antwoord.',
  search_failed: 'De zoekdienst gaf een fout.',
  search_bad_key: 'De zoekdienst accepteerde de sleutel niet.',
  search_rate_limited: 'De zoekdienst staat nu geen aanvragen meer toe (limiet of tegoed op). Probeer het later nog eens.',
  search_unavailable: 'De zoekdienst was niet bereikbaar.',
  search_unexpected: 'De zoekdienst gaf een onverwacht antwoord.',
  no_search: 'Er is geen zoekdienst ingesteld, dus er is niet op het web gezocht. Zet BRAVE_API_KEY in je .env (zie de README). Staat hij er al in? Start de site dan opnieuw: hij leest .env alleen bij het starten.',
  paused: 'De beheerder heeft deze bron tijdelijk uitgezet. Probeer het later nog eens.',
  search_paused: 'De beheerder heeft de zoekdienst tijdelijk uitgezet. Probeer het later nog eens.',
  search_budget: 'De grens voor zoekopdrachten van de site (per dag of per maand) is bereikt. Er is niets gezocht; het werkt weer als de dag of maand om is.',
  search_budget_scan: 'De grens van het aantal zoekopdrachten voor één onderzoek is bereikt; de rest is niet gezocht.',
  name_too_short: 'Je naam bevat te weinig letters om op te zoeken.',
  no_phone: 'Je hebt geen bevestigd telefoonnummer. Voeg je nummer toe bij Zoekgegevens en bevestig het met de code die je krijgt: pas dan onderzoeken we het.',
  no_email_consent: 'Je hebt niet gekozen om ook op je e-mailadres te zoeken. Dat kan bij Zoekgegevens; dan gaat je e-mailadres als zoekopdracht naar de zoekdienst.',
  search_disabled: 'Zoeken op naam staat uit op een openbare site: een bevestigd e-mailadres bewijst niet dat de naam van jou is.',
};

// Bij deze fouten bestond de bron wel, maar kwamen we er niet bij.
const UNREACHABLE = new Set([
  'bad_key', 'rate_limited', 'busy', 'unavailable', 'unexpected',
  'search_failed', 'search_bad_key', 'search_rate_limited', 'search_unavailable', 'search_unexpected',
]);
// Bij deze fouten hebben we de bron niet eens geprobeerd.
const NOT_TRIED = new Set([
  'no_key', 'no_search', 'name_too_short', 'search_disabled', 'paused', 'search_paused', 'search_budget', 'search_budget_scan',
  'no_phone', 'no_email_consent',
]);

function fromError(error, sources) {
  if (error instanceof ScanError) {
    let status = 'skipped';
    if (error.code === 'no_key' || error.code === 'no_search') status = 'unavailable';
    else if (UNREACHABLE.has(error.code)) status = 'unreachable';
    return {
      status,
      sources: NOT_TRIED.has(error.code) ? [] : sources,
      note: REASONS[error.code] ?? REASONS.unexpected,
    };
  }
  // Een fout in onze eigen code. Alleen de soort en de eerste regel gaan naar de terminal.
  console.error(`Deep Scan: onverwachte fout (${error?.name ?? 'Error'}): ${String(error?.message ?? error).split('\n')[0].slice(0, 200)}`);
  return { status: 'failed', sources, note: 'Er ging iets mis in de scanner. Kijk in de terminal van de server.' };
}

function dayText(ms) {
  return new Date(ms).toLocaleDateString('nl-NL', { day: 'numeric', month: 'long', year: 'numeric' });
}

async function breachStep({ db, user, hibp, now }) {
  const source = sourceById(hibp.sourceFor?.(user.email));
  if (!hibp.hasKeyFor(user.email)) return fromError(new ScanError('no_key'), [source.id]);
  try {
    const { found, added } = await scanBreaches({ db, user, hibp, now });
    const text = found === 0
      ? `Geen datalek gevonden bij ${source.name}.`
      : `${found === 1 ? '1 datalek' : `${found} datalekken`} gevonden bij ${source.name}${added > 0 ? `, waarvan ${added} nieuw` : ''}.`;
    return { status: 'done', sources: [source.id], found, added, note: text };
  } catch (error) {
    return fromError(error, [source.id]);
  }
}

async function webStep({ db, user, search, allowWeb, now }) {
  // Zonder zoekdienst is er niets om te proberen: dat is "niet beschikbaar", geen mislukking.
  if (!search) return fromError(new ScanError('no_search'), []);
  const sourceId = searchSourceId(search);
  try {
    const { found, added, expiresAt } = await scanWeb({ db, user, search, allowed: allowWeb, now });
    const demo = Boolean(search.isDemo);
    let text = found === 0
      ? 'De zoekdienst vond niets bij je naam.'
      : `${found === 1 ? '1 mogelijke vermelding' : `${found} mogelijke vermeldingen`} gevonden${added > 0 ? `, waarvan ${added} nieuw` : ''}. Beoordeel ze zelf: veel zijn van naamgenoten.`;
    if (found > 0 && expiresAt !== null) {
      text += ` De zoekdienst staat niet toe dat we resultaten bewaren: ze blijven ${WEB_RESULT_MINUTES} minuten zichtbaar, jouw keuzes blijven.`;
    }
    if (demo) text = `Demo: ${found === 1 ? '1 verzonnen resultaat' : `${found} verzonnen resultaten`}. Dit is nepdata; er is geen echte zoekdienst gebruikt.`;
    return { status: 'done', sources: [sourceId], demo, found, added, note: text };
  } catch (error) {
    return fromError(error, [sourceId]);
  }
}

const plural = (count, one, many) => (count === 1 ? `1 ${one}` : `${count} ${many}`);

// Een webstap van het uitgebreide onderzoek: één zoekopdracht met een van je gegevens. `ready` zegt of
// de stap mag (anders de foutcode waarom niet). `describe` maakt de tekst bij een gelukte stap.
async function searchStep({
  db, user, search, now, ready, query, via, describe, web,
}) {
  if (!search) return fromError(new ScanError('no_search'), []);
  if (ready !== true) return fromError(new ScanError(ready), []);
  if (!query) return fromError(new ScanError('name_too_short'), []);
  const sourceId = searchSourceId(search);
  try {
    const { results, added } = await searchAndSave({
      db, user, search, query, via, now,
    });
    for (const result of results) web.urls.add(result.url);
    web.added += added;
    const brokers = brokersIn(results);
    const demo = Boolean(search.isDemo);
    let note = describe(results.length, added);
    if (brokers.length > 0) note += ` Daarvan op een databrokersite: ${brokers.map((id) => brokerById(id)?.name ?? id).join(', ')}.`;
    if (demo) note = `Demo: ${plural(results.length, 'verzonnen resultaat', 'verzonnen resultaten')}. Dit is nepdata.`;
    return {
      status: 'done', sources: [sourceId], demo, found: results.length, added, note,
    };
  } catch (error) {
    return fromError(error, [sourceId]);
  }
}

function foundText(count, added, what) {
  if (count === 0) return `Niets gevonden ${what}.`;
  return `${plural(count, 'mogelijke vermelding', 'mogelijke vermeldingen')} ${what}${added > 0 ? `, waarvan ${added} nieuw` : ''}.`;
}

// De databrokers uit het register (zie brokers/registry.js en research/broker-scan.js).
async function brokerStep({
  db, user, search, allowWeb, now, web,
}) {
  if (!search) return fromError(new ScanError('no_search'), []);
  if (!allowWeb) return fromError(new ScanError('search_disabled'), []);
  const sourceId = searchSourceId(search);
  const closed = BROKERS.filter((broker) => broker.access === 'closed').map((broker) => broker.name);
  try {
    const outcome = await scanBrokers({
      db, user, search, now,
    });
    for (const result of outcome.results) web.urls.add(result.url);
    web.added += outcome.added;
    const names = outcome.withHits.map((id) => brokerById(id)?.name ?? id);
    let note = outcome.found === 0
      ? `Bij ${plural(outcome.checked, 'databroker', 'databrokers')} niets gevonden op je naam.`
      : `${plural(outcome.found, 'mogelijke vermelding', 'mogelijke vermeldingen')} op je naam bij ${names.join(', ')}. Een vermelding kan van een naamgenoot zijn: kijk zelf.`;
    if (outcome.error) note += ` Niet alle databrokers konden worden doorzocht: ${(REASONS[outcome.error.code] ?? REASONS.unexpected).toLowerCase()}`;
    if (closed.length > 0) note += ` Afgeschermd (niet te doorzoeken): ${closed.join(', ')}.`;
    if (search.isDemo) note = 'Demo: de nepzoekdienst kent geen databrokers, dus er is niets gevonden. Dit is geen echte controle.';
    return {
      status: 'done', sources: [sourceId], demo: Boolean(search.isDemo), found: outcome.found, added: outcome.added, note,
    };
  } catch (error) {
    return fromError(error, [sourceId]);
  }
}

const DARKWEB_NOTE = 'Niet beschikbaar: er is geen geautoriseerde aanbieder gekoppeld. We bouwen geen eigen darkweb-crawler en kopen of bewaren geen gestolen gegevens.';

// Combineren: welke resultaten met meer dan één van je gegevens gevonden zijn, en welke een sterke
// overeenkomst zijn (je bevestigde e-mailadres of telefoonnummer staat erin).
function combinedNote(web) {
  const multi = web.filter((item) => Array.isArray(item.details.via) && item.details.via.length > 1).length;
  const strong = web.filter((item) => item.confidence === 'hoog').length;
  if (web.length === 0) return '';
  return ` Combineren: ${plural(multi, 'webresultaat is', 'webresultaten zijn')} met meer dan één van je gegevens gevonden, en ${plural(strong, 'is een sterke overeenkomst', 'zijn een sterke overeenkomst')} (je bevestigde e-mailadres of telefoonnummer staat erin).`;
}

// De stappen zoals ze op de pagina staan voordat er iets loopt: allemaal "wacht".
export function plannedSteps() {
  return STEP_DEFS.map((def) => ({ id: def.id, title: def.title, status: 'pending', sources: [], note: '' }));
}

// Voert de Deep Scan uit en bewaart het rapport. Geeft { ranAt, steps, exposure } terug. Deze
// functie gooit geen fouten van de bronnen: die komen als stap in het rapport.
//   allowWeb    mag er op naam gezocht worden? (Dat bepaalt de aanroeper, zie owner.js.)
//   onProgress  krijgt na elke stap alle stappen: de gedane, de stap die nu loopt en wat nog wacht
//               (voor de voortgang van de onderzoekswachtrij, zie jobs/).
export async function runDeepScan({
  db, user, hibp, search, allowWeb, now = Date.now(), onProgress = () => {},
}) {
  const steps = [];
  const report = () => onProgress([
    ...steps,
    ...STEP_DEFS.slice(steps.length).map((def, index) => ({
      id: def.id, title: def.title, status: index === 0 ? 'running' : 'pending', sources: [], note: '',
    })),
  ]);
  const add = (id, outcome) => {
    steps.push({ id, title: STEP_TITLES[id], ...outcome });
    report();
  };
  report();

  add('datalekken', await breachStep({ db, user, hibp, now }));

  // Het webonderzoek: je naam (met woonplaats), databrokers, sociale media, documenten, je bevestigde
  // telefoonnummer en, als je dat wilt, je e-mailadres. `web` telt de unieke adressen voor de samenvatting.
  const web = { urls: new Set(), added: 0 };
  const nameStep = await webStep({ db, user, search, allowWeb, now });
  if (nameStep.status === 'done') {
    const latest = lastScan(db, user.id, 'web');
    if (latest?.ran_at === now) {
      for (const item of listFindings(db, user.id, now).web) {
        if (item.checked_at === now) web.urls.add(item.url);
      }
      web.added += latest.new_count;
    }
  }
  add('web', nameStep);
  add('databrokers', await brokerStep({
    db, user, search, allowWeb, now, web,
  }));
  const shared = {
    db, user, search, now, web,
  };
  add('sociale-media', await searchStep({
    ...shared,
    ready: allowWeb ? true : 'search_disabled',
    query: socialQuery(user.name),
    via: 'naam',
    describe: (count, added) => foundText(count, added, `op sociale media (${SOCIAL_SITES.join(', ')})`),
  }));
  add('documenten', await searchStep({
    ...shared,
    ready: allowWeb ? true : 'search_disabled',
    query: documentsQuery(user.name),
    via: 'naam',
    describe: (count, added) => foundText(count, added, `in openbare documenten (${DOCUMENT_TYPES.join(', ')})`),
  }));
  add('telefoon', await searchStep({
    ...shared,
    ready: user.phone && user.phone_verified_at ? true : 'no_phone',
    query: phoneQuery(user.phone_verified_at ? user.phone : null),
    via: 'telefoon',
    // Het nummer zelf staat niet in de tekst: het rapport blijft bewaard, ook als je het nummer later verwijdert.
    describe: (count, added) => foundText(count, added, 'met je bevestigde telefoonnummer'),
  }));
  add('e-mail', await searchStep({
    ...shared,
    ready: user.email_web_at ? true : 'no_email_consent',
    query: emailQuery(user.email),
    via: 'e-mail',
    describe: (count, added) => foundText(count, added, 'met je e-mailadres'),
  }));
  add('darkweb', { status: 'unavailable', sources: [], note: DARKWEB_NOTE });

  // Per databroker de unieke pagina's van deze scan, met elk gegeven waarmee ze gevonden zijn.
  recordBrokerFindings(db, user.id, now);

  // Wat het webonderzoek samen vond, als de laatste webzoekopdracht van dit account.
  const searched = steps.some((step) => ['web', 'databrokers', 'sociale-media', 'documenten', 'telefoon', 'e-mail'].includes(step.id)
    && step.status === 'done');
  if (searched) {
    const latest = lastScan(db, user.id, 'web');
    recordScan(db, user.id, 'web', web.urls.size, web.added, latest?.ran_at === now ? latest.detail : null, now);
  }

  // De laatste twee stappen rekenen op wat er nu is opgeslagen, ook van een eerdere scan.
  const findings = listFindings(db, user.id);
  const breachScan = lastScan(db, user.id, 'breach');
  const exposure = exposureFrom(findings.breaches.map((row) => ({
    title: row.title,
    dataClasses: row.details.dataClasses,
  })));

  if (!breachScan) {
    add('blootstelling', {
      status: 'skipped',
      sources: [],
      note: 'Er is nog geen datalekcontrole gelukt, dus er is niets om te beoordelen.',
    });
  } else {
    const fresh = steps[0].status === 'done';
    add('blootstelling', {
      status: 'done',
      sources: [],
      note: exposureNote(exposure, findings.breaches.length)
        + (fresh ? '' : ` Gebaseerd op de controle van ${dayText(breachScan.ran_at)}.`),
    });
  }

  const everything = [...findings.breaches, ...findings.web];
  if (everything.length === 0) {
    add('verificatie', { status: 'skipped', sources: [], note: verifyNote(verifyFindings([])) });
  } else {
    add('verificatie', { status: 'done', sources: [], note: verifyNote(verifyFindings(everything)) + combinedNote(findings.web) });
  }

  const run = { ranAt: now, steps, exposure };
  saveRun(db, user.id, run);
  return run;
}
