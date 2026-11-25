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
  STEP_TITLES, exposureFrom, exposureNote, verifyFindings, verifyNote,
} from './engine.js';
import { lastScan, listFindings, saveRun } from './findings.js';
import { ScanError } from './scan-error.js';
import { scanBreaches, scanWeb } from './scans.js';
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
  name_too_short: 'Je naam bevat te weinig letters om op te zoeken.',
  search_disabled: 'Zoeken op naam staat uit op een openbare site: een bevestigd e-mailadres bewijst niet dat de naam van jou is.',
};

// Bij deze fouten bestond de bron wel, maar kwamen we er niet bij.
const UNREACHABLE = new Set(['bad_key', 'rate_limited', 'busy', 'unavailable', 'unexpected', 'search_failed']);
// Bij deze fouten hebben we de bron niet eens geprobeerd.
const NOT_TRIED = new Set(['no_key', 'name_too_short', 'search_disabled']);

function fromError(error, sources) {
  if (error instanceof ScanError) {
    let status = 'skipped';
    if (error.code === 'no_key') status = 'unavailable';
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
  const sourceId = search.isDemo ? 'demo' : String(search.name ?? 'web');
  try {
    const { found, added } = await scanWeb({ db, user, search, allowed: allowWeb, now });
    const demo = Boolean(search.isDemo);
    let text = found === 0
      ? 'De zoekdienst vond niets bij je naam.'
      : `${found === 1 ? '1 resultaat' : `${found} resultaten`} gevonden${added > 0 ? `, waarvan ${added} nieuw` : ''}. Beoordeel ze zelf: veel zijn van naamgenoten.`;
    if (demo) text = `Demo: ${found === 1 ? '1 verzonnen resultaat' : `${found} verzonnen resultaten`}. Er is nog geen echte zoekdienst gekoppeld.`;
    return { status: 'done', sources: [sourceId], demo, found, added, note: text };
  } catch (error) {
    return fromError(error, [sourceId]);
  }
}

// Voert de Deep Scan uit en bewaart het rapport. Geeft { ranAt, steps, exposure } terug. Deze
// functie gooit geen fouten van de bronnen: die komen als stap in het rapport.
//   allowWeb  mag er op naam gezocht worden? (Dat bepaalt de aanroeper, zie routes-scan.js.)
export async function runDeepScan({ db, user, hibp, search, allowWeb, now = Date.now() }) {
  const steps = [];
  const add = (id, outcome) => steps.push({ id, title: STEP_TITLES[id], ...outcome });

  add('datalekken', await breachStep({ db, user, hibp, now }));
  add('databrokers', {
    status: 'planned',
    sources: [],
    note: 'Nog niet gebouwd (fase 3). Databrokers onderzoeken we straks alleen via toegestane bronnen.',
  });
  add('web', await webStep({ db, user, search, allowWeb, now }));

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
    add('verificatie', { status: 'done', sources: [], note: verifyNote(verifyFindings(everything)) });
  }

  const run = { ranAt: now, steps, exposure };
  saveRun(db, user.id, run);
  return run;
}
