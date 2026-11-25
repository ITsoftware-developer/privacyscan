// Controleert of de koppelingen met de echte bronnen werken, met jouw sleutel en op jouw computer.
//
//   npm run controleer                      Brave Search en XposedOrNot, met een neutraal voorbeeld
//   npm run controleer -- jij@voorbeeld.nl  XposedOrNot ook met je eigen e-mailadres
//
// Waarom dit bestaat: de tests van Privacyscan gebruiken nagemaakte antwoorden, want de
// testomgeving waarin de site gebouwd is, kan de echte diensten niet bereiken. Dit script is de
// echte proef: het gebruikt dezelfde code als de site, dus wat hier lukt, lukt de site ook.
//
// Wat het verstuurt: één neutrale zoekopdracht naar Brave (niet je naam) en twee aanvragen naar
// XposedOrNot. Daarmee gebruik je een heel klein deel van je tegoed en van de gratis limiet.
// Het script print nooit je sleutel, en nooit een zoekopdracht met je naam of je e-mailadres.
import { pathToFileURL } from 'node:url';
import { ScanError } from '../src/scan-error.js';
import { cleanResults, createBraveSearch } from '../src/search.js';
import { createXon } from '../src/xon.js';

// Een zoekopdracht waar elke zoekmachine resultaten bij geeft.
const NEUTRAL_QUERY = '"Domtoren" "Utrecht"';
// Een adres dat nergens bij hoort: voor als je geen eigen adres meegeeft.
const EXAMPLE_ADDRESS = 'controle@example.com';

const BRAVE_PROBLEMS = {
  bad_key: 'Brave weigert de sleutel (HTTP 401 of 403). Controleer BRAVE_API_KEY in je .env: de sleutel van je Search-abonnement, zonder aanhalingstekens of spaties.',
  rate_limited: 'Brave staat geen aanvragen meer toe (HTTP 402 of 429): het tegoed of de limiet is op, of er is geen betaalmethode ingesteld op je Brave-account.',
  unavailable: 'Brave is niet bereikbaar: geen internet, een firewall of een storing bij Brave.',
  unexpected: 'Brave gaf een antwoord dat de koppeling niet kan lezen. Dan past de koppeling misschien niet meer bij de dienst: meld dit, samen met de regel hierboven.',
};

const XON_PROBLEMS = {
  rate_limited: 'XposedOrNot staat geen aanvragen meer toe: de gratis limiet (25 per uur, 100 per dag) is bereikt. Probeer het later nog eens.',
  unavailable: 'XposedOrNot is niet bereikbaar: geen internet, een firewall of een storing.',
  unexpected: 'XposedOrNot gaf een antwoord dat de koppeling niet kan lezen. Dan past de koppeling misschien niet meer bij de dienst: meld dit, samen met de regel hierboven.',
};

function explain(error, problems) {
  if (error instanceof ScanError) return problems[error.code] ?? problems.unexpected;
  return `Onverwachte fout: ${String(error?.message ?? error).split('\n')[0].slice(0, 200)}`;
}

// De tellers die Brave bij een antwoord meegeeft ("aanvragen over"), als het getallen zijn.
function limitsFrom(headers) {
  const remaining = headers?.get?.('x-ratelimit-remaining');
  return remaining && /^[\d,\s]+$/.test(remaining) ? remaining.replace(/\s+/g, ' ').trim() : null;
}

async function checkBrave({ env, fetchImpl, line, options }) {
  line('Brave Search (zoeken op het web)');
  const key = String(env.BRAVE_API_KEY ?? '').trim();
  if (!key) {
    line('  Overgeslagen: er staat geen BRAVE_API_KEY in je .env. Zonder zoekdienst zoekt de site niet op het web.');
    return 0;
  }

  // De echte koppeling, met een fetch eromheen die alleen de tellers van Brave onthoudt.
  let headers = null;
  const recordingFetch = async (url, init) => {
    const response = await fetchImpl(url, init);
    headers = response.headers;
    return response;
  };

  let search;
  try {
    search = createBraveSearch({ apiKey: key, fetchImpl: recordingFetch, ...options });
  } catch (error) {
    line(`  Probleem: ${error.message}`);
    return 1;
  }

  try {
    const raw = await search.search({ query: NEUTRAL_QUERY, name: 'Domtoren', city: 'Utrecht' });
    const results = cleanResults(raw);
    if (results.length === 0) {
      line('  Probleem: Brave antwoordde, maar zonder één bruikbaar resultaat bij een neutrale zoekopdracht. Controleer je abonnement op brave.com/search/api.');
      return 1;
    }
    const left = limitsFrom(headers);
    line(`  OK: de sleutel werkt en ${results.length === 1 ? '1 resultaat is' : `${results.length} resultaten zijn`} gelezen.`);
    if (left) line(`  Aanvragen die Brave nog toestaat (per seconde, per maand): ${left}.`);
    return 0;
  } catch (error) {
    line(`  Probleem: ${explain(error, BRAVE_PROBLEMS)}`);
    return 1;
  }
}

async function checkXon({ argv, fetchImpl, line, options }) {
  line('XposedOrNot (datalekken, gratis)');
  const own = argv.find((argument) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(argument));
  const xon = createXon({ fetchImpl, ...options });
  let problems = 0;

  try {
    const size = await xon.listSize();
    line(`  OK: de lijst met bekende lekken is gelezen (${size} lekken).`);
  } catch (error) {
    line(`  Probleem met de lijst met lekken: ${explain(error, XON_PROBLEMS)}`);
    problems += 1;
  }

  try {
    const breaches = await xon.breachesFor(own ?? EXAMPLE_ADDRESS);
    if (own) {
      line(breaches.length === 0
        ? '  OK: je eigen adres is gecontroleerd: XposedOrNot kent het niet uit een lek.'
        : `  OK: je eigen adres is gecontroleerd: het staat in ${breaches.length === 1 ? '1 bekend lek' : `${breaches.length} bekende lekken`}.`);
    } else {
      line('  OK: het antwoord op een controle van een adres is gelezen (met een voorbeeldadres).');
      line('  Tip: geef je eigen adres mee om ook dat te proberen: npm run controleer -- jij@voorbeeld.nl');
    }
  } catch (error) {
    line(`  Probleem bij het controleren van een adres: ${explain(error, XON_PROBLEMS)}`);
    problems += 1;
  }
  return problems;
}

// Doet alle controles en geeft het aantal problemen terug. Alles wat van buiten komt (de instellingen,
// de fetch, de uitvoer) is een argument, zodat de tests het zonder internet kunnen doen.
export async function runChecks({
  env = process.env, argv = [], fetchImpl = fetch, out = console.log, braveOptions = {}, xonOptions = {},
} = {}) {
  const line = (text = '') => out(text);
  line('Privacyscan: de echte bronnen controleren');
  line('Dit stuurt een paar aanvragen naar de echte diensten en gebruikt dezelfde code als de site.');
  line();

  let problems = 0;
  problems += await checkBrave({ env, fetchImpl, line, options: braveOptions });
  line();
  problems += await checkXon({ argv, fetchImpl, line, options: xonOptions });
  line();
  line(problems === 0
    ? 'Alles wat is ingesteld werkt. Je kunt de site starten met: npm start'
    : `Er ${problems === 1 ? 'is 1 probleem' : `zijn ${problems} problemen`} gevonden. Los dat op en draai dit script opnieuw.`);
  return problems;
}

// Alleen uitvoeren als dit bestand zelf gestart wordt (npm run controleer), niet als een test het laadt.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runChecks({ argv: process.argv.slice(2) }).then((problems) => {
    process.exitCode = problems > 0 ? 1 : 0;
  });
}
