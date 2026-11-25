// Waar de gegevens vandaan komen. Dit bestand heeft twee delen.
//
// 1. SOURCES: de bronnen van datalekken. Elke bron moet bij de resultaten genoemd worden, en
//    dat gebeurt aan de hand van deze lijst.
//
//      hibp  Have I Been Pwned: de bekendste, maar voor echte adressen is een betaalde sleutel nodig.
//      xon   XposedOrNot: gratis en zonder sleutel, met een lage limiet (zie xon.js).
//
// 2. Het bronnenregister ("PrivacyScan Intelligence"): álle bronnen die de scanner gebruikt of
//    gaat gebruiken, ook de nog niet gebouwde, met eerlijk de stand van zaken. Het register
//    verzint niets: een bron die niet bestaat, staat er als "gepland" in en nooit als "actief".
import { WEB_RESULT_MINUTES } from './retention.js';

export const SOURCES = {
  hibp: {
    id: 'hibp',
    name: 'Have I Been Pwned',
    url: 'https://haveibeenpwned.com',
    credit: 'gegevens onder licentie CC BY 4.0',
  },
  xon: {
    id: 'xon',
    name: 'XposedOrNot',
    url: 'https://xposedornot.com',
    credit: null,
  },
};

// Zoekt een datalekbron op. Wat we niet kennen (of niet meegekregen hebben, zoals bij
// resultaten uit de tijd dat er alleen HIBP was), is Have I Been Pwned.
export function sourceById(id) {
  return typeof id === 'string' && Object.hasOwn(SOURCES, id) ? SOURCES[id] : SOURCES.hibp;
}

// De website van een bron zonder "https://", om in een zin te zetten.
export function sourceHost(source) {
  return new URL(source.url).host;
}

// --- Bronnen van bevindingen ----------------------------------------------------------------

// Zoekdiensten voor het web. Bij een webresultaat bewaren we welke dienst het gaf, zodat er
// bij elke bevinding een bron staat.
const WEB_PROVIDERS = {
  demo: { id: 'demo', name: 'Demo-zoekdienst (nepdata)', url: null, credit: null },
  brave: { id: 'brave', name: 'Brave Search', url: 'https://search.brave.com', credit: null },
};

// De bron die bij een bevinding hoort: een datalekbron, een zoekdienst, of (voor een id die
// we niet kennen) het id zelf. Het id komt uit onze eigen instellingen, nooit van een bezoeker.
export function evidenceSource(id) {
  if (typeof id === 'string' && Object.hasOwn(SOURCES, id)) return SOURCES[id];
  if (typeof id === 'string' && Object.hasOwn(WEB_PROVIDERS, id)) return WEB_PROVIDERS[id];
  return { id: 'onbekend', name: typeof id === 'string' && id ? id.slice(0, 40) : 'Onbekende bron', url: null, credit: null };
}

// --- Het bronnenregister --------------------------------------------------------------------

export const CATEGORIES = {
  datalekken: 'Datalekken',
  wachtwoorden: 'Gelekte wachtwoorden',
  web: 'Openbare internetbronnen',
  databrokers: 'Databrokers',
  social: 'Sociale media',
  documenten: 'Openbare documenten',
  darkweb: 'Darkweb via geautoriseerde bronnen',
};

export const STATE_LABELS = {
  actief: 'Actief',
  testmodus: 'Alleen testadressen',
  demo: 'Demo (nepdata)',
  uit: 'Uit',
  'niet-ingesteld': 'Niet ingesteld',
  gepland: 'Gepland',
};

// De fasen van het plan, voor op de pagina /bronnen en in de README. `done` is alleen waar als
// het onderdeel ook echt werkt.
export const PHASES = [
  { number: 1, name: 'Veilig fundament', short: 'Fundament', done: true, text: 'Registreren, inloggen, e-mailadres bevestigen, database en dashboard.' },
  { number: 2, name: 'Breach Intelligence Engine', short: 'Datalekken', done: true, text: 'Bekende datalekken en blootgestelde persoonsgegevens opsporen, met twee bronnen. Darkwebbronnen volgen zodra er een geautoriseerde aanbieder is.' },
  { number: 3, name: 'Data Broker Engine', short: 'Databrokers', done: false, text: 'Gegevens bij databrokers onderzoeken via toegestane bronnen. Dit begint met gerichte zoekopdrachten op een korte lijst van bekende personenzoeksites.' },
  { number: 4, name: 'Deep Research Engine', short: 'Deep Research', done: false, text: 'Uitgebreid onderzoek van openbare internetbronnen en documenten. Een echte zoekdienst (Brave Search) is gekoppeld en werkt zodra je een sleutel instelt; het onderzoek op de achtergrond, met voortgang, volgt.' },
  { number: 5, name: 'Eigen AI-agent', short: 'AI-agent', done: false, text: 'Zelfstandig onderzoek plannen, uitvoeren, controleren en rapporteren.' },
  { number: 6, name: 'Continuous Monitoring', short: 'Monitoring', done: false, text: 'Automatisch opnieuw scannen en waarschuwen bij nieuwe bevindingen.' },
];

// In de volgorde van de pagina /bronnen. `needs` is wat er nodig is voordat een geplande bron
// kan bestaan.
const REGISTER = [
  {
    id: 'hibp',
    category: 'datalekken',
    phase: 2,
    name: SOURCES.hibp.name,
    url: SOURCES.hibp.url,
    gives: 'In welke bekende datalekken een e-mailadres zat, met de datum, het aantal accounts en de soorten gegevens die gelekt zijn.',
  },
  {
    id: 'xon',
    category: 'datalekken',
    phase: 2,
    name: SOURCES.xon.name,
    url: SOURCES.xon.url,
    gives: 'Hetzelfde, uit een eigen database. De gratis bron, zonder sleutel. Gevoelige lekken tonen we nooit.',
  },
  {
    id: 'pwned-passwords',
    category: 'wachtwoorden',
    phase: 1,
    name: 'Pwned Passwords',
    url: 'https://haveibeenpwned.com/Passwords',
    gives: 'Of een wachtwoord in een bekend datalek voorkomt. Alleen de eerste 5 tekens van een hash gaan naar de dienst, nooit het wachtwoord zelf.',
  },
  {
    id: 'search',
    category: 'web',
    phase: 4,
    name: 'Zoekdienst voor het web (Brave Search)',
    url: 'https://brave.com/search/api/',
    gives: 'Openbare webpagina\'s waarop jouw naam voorkomt, met wat daarin op een telefoonnummer, e-mailadres of postcode lijkt (gemaskeerd). Het zijn mogelijke overeenkomsten: jij beoordeelt zelf wat van jou is.',
    needs: 'Een sleutel voor de Brave Search API (BRAVE_API_KEY in je .env, zie de README). Brave staat niet toe dat we resultaten bewaren, dus we tonen ze hooguit een half uur.',
  },
  {
    id: 'databrokers',
    category: 'databrokers',
    phase: 3,
    name: 'Databrokers',
    url: null,
    gives: 'Of jouw gegevens staan bij bedrijven die persoonsgegevens verzamelen en doorverkopen.',
    needs: 'Een lijst met databrokersites die we met de zoekdienst controleren. Dat is nog niet gebouwd. Alleen via toegestane bronnen: we lezen geen sites uit waar dat niet mag.',
  },
  {
    id: 'social',
    category: 'social',
    phase: 4,
    name: 'Sociale media',
    url: null,
    gives: 'Profielen en vermeldingen van jouw naam op sociale netwerken.',
    needs: 'Een zoekdienst, en een aparte zoekopdracht per netwerk (nog niet gebouwd). We kijken alleen naar wat openbaar is en loggen nergens in.',
  },
  {
    id: 'documenten',
    category: 'documenten',
    phase: 4,
    name: 'Openbare documenten',
    url: null,
    gives: 'Openbare bestanden, zoals pdf\'s, waarin jouw naam staat.',
    needs: 'Een zoekdienst, en een aparte zoekopdracht naar bestandstypen (nog niet gebouwd).',
  },
  {
    id: 'darkweb',
    category: 'darkweb',
    phase: 2,
    name: 'Darkwebmonitoring',
    url: null,
    gives: 'Of jouw gegevens opduiken op plekken die niet via gewone zoekmachines te vinden zijn.',
    needs: 'Een overeenkomst met een aanbieder die dit legaal en geautoriseerd levert. We bouwen geen eigen crawler voor het darkweb en kopen of bewaren geen gestolen gegevens.',
  },
];

// Het register met de stand van zaken van deze site: wat is er echt aan, volgens de instellingen?
//   emailSources  welke bron(nen) e-mailadressen controleren (zie breach-check.js)
//   hasKey        kan de site echte adressen controleren (HIBP-sleutel of de gratis dienst)?
//   search        de zoekdienst voor het web, of null
export function describeRegister({ emailSources = ['hibp'], hasKey = false, search = null } = {}) {
  const hibpKey = hasKey && emailSources.includes('hibp');
  const xonOn = emailSources.includes('xon');

  // De zoekdienst: ingesteld, de demo, of geen. Zonder zoekdienst zoeken we niet en verzinnen we niets.
  const searchEntry = REGISTER.find((item) => item.id === 'search');
  let searchState;
  if (!search) {
    searchState = { state: 'niet-ingesteld', note: `Er is geen zoekdienst ingesteld, dus er wordt niet op het web gezocht en er wordt niets verzonnen. ${searchEntry.needs}` };
  } else if (search.isDemo) {
    searchState = { state: 'demo', note: 'Dit is de demo: de resultaten zijn verzonnen en er gaat niets naar buiten. Zet SEARCH_PROVIDER=brave (of laat het leeg) en een BRAVE_API_KEY voor echte resultaten.' };
  } else {
    const kept = search.retainsResults
      ? 'De resultaten bewaren we in je account.'
      : `De voorwaarden van de dienst staan bewaren niet toe, dus we tonen resultaten hooguit ${WEB_RESULT_MINUTES} minuten; alleen jouw keuzes blijven.`;
    searchState = { state: 'actief', note: `Je naam en woonplaats gaan als zoekopdracht naar ${search.label ?? search.name}. ${kept}` };
  }
  // Sociale netwerken en openbare documenten komen, voor zover ze in de gewone zoekopdracht
  // voorkomen, als zodanig gemarkeerd in de resultaten. Apart zoeken doen we nog niet.
  const labelled = search && !search.isDemo
    ? { state: 'gepland', note: 'Wat hiervan in de gewone zoekopdracht voorkomt, markeren we in de resultaten. Aparte zoekopdrachten zijn nog niet gebouwd.' }
    : null;

  const states = {
    hibp: hibpKey
      ? { state: 'actief', note: 'Elk e-mailadres gaat naar Have I Been Pwned.' }
      : { state: 'testmodus', note: 'Zonder sleutel (HIBP_API_KEY) werken alleen de testadressen van Have I Been Pwned.' },
    xon: xonOn
      ? { state: 'actief', note: 'Gratis, met een lage limiet: 25 controles per uur en 100 per dag, voor de hele site.' }
      : { state: 'uit', note: 'Staat uit. Met FREE_BREACH_CHECK=on controleert de app echte adressen gratis.' },
    'pwned-passwords': { state: 'actief', note: 'Wordt nu gebruikt bij het maken van een account.' },
    search: searchState,
    ...(labelled ? { social: labelled, documenten: labelled } : {}),
  };

  return REGISTER.map((entry) => ({
    ...entry,
    categoryName: CATEGORIES[entry.category],
    ...(states[entry.id] ?? { state: 'gepland', note: entry.needs ?? null }),
    stateLabel: STATE_LABELS[(states[entry.id] ?? { state: 'gepland' }).state],
  }));
}
