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
import { BROKERS } from './brokers/registry.js';
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
  ai: 'AI-analyse',
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
  { number: 3, name: 'Data Broker Engine', short: 'Databrokers', done: false, text: 'Begonnen: gerichte zoekopdrachten via de zoekdienst bij een register van bekende personenzoeksites en telefoongidsen, met per databroker wat ze verwerken en of er een overeenkomst met je gegevens is. Nog niet: hun pagina\'s zelf lezen, geautoriseerde koppelingen met databrokers, en gegevens die niet in een zoekmachine staan.' },
  { number: 4, name: 'Deep Research Engine', short: 'Deep Research', done: false, text: 'Uitgebreid onderzoek van openbare internetbronnen en documenten. Werkt al: de zoekdienst (Brave Search), sociale media, documenten, je bevestigde telefoonnummer en, als je dat wilt, je e-mailadres, op de achtergrond met voortgang en een kostengrens. Sinds 0.9.0 ook: gevonden gewone webpagina\'s zelf lezen. Nog niet: pdf- en andere documenten openen.' },
  { number: 5, name: 'Eigen AI-agent', short: 'AI-agent', done: false, text: 'Begonnen: een lokaal AI-model (Ollama) kiest welke gevonden pagina\'s we nog lezen en beoordeelt de resultaten, met alleen gegevens die letterlijk in de tekst staan. Nog niet: zelf zoekopdrachten plannen en een eigen rapport schrijven.' },
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
    needs: 'Een zoekdienst (BRAVE_API_KEY). Dan zoeken we op je naam bij de databrokers uit ons register, met site:-zoekopdrachten. Alleen via toegestane bronnen: we openen hun sites niet en lezen ze niet uit.',
  },
  {
    id: 'social',
    category: 'social',
    phase: 4,
    name: 'Sociale media',
    url: null,
    gives: 'Profielen en vermeldingen van jouw naam op sociale netwerken.',
    needs: 'Een zoekdienst (BRAVE_API_KEY). We kijken alleen naar wat openbaar in de zoekdienst staat en loggen nergens in.',
  },
  {
    id: 'documenten',
    category: 'documenten',
    phase: 4,
    name: 'Openbare documenten',
    url: null,
    gives: 'Openbare bestanden, zoals pdf\'s, waarin jouw naam staat.',
    needs: 'Een zoekdienst (BRAVE_API_KEY), met een zoekopdracht naar bestandstypen.',
  },
  {
    id: 'telefoon',
    category: 'web',
    phase: 4,
    name: 'Je telefoonnummer',
    url: null,
    gives: 'Pagina\'s, telefoongidsen en databrokers waarop je eigen telefoonnummer staat, in alle gangbare schrijfwijzen.',
    needs: 'Een zoekdienst (BRAVE_API_KEY) en een nummer dat je met een sms-code hebt bevestigd. Op een openbare site is daarvoor een sms-dienst nodig; die is er nog niet.',
  },
  {
    id: 'email-web',
    category: 'web',
    phase: 4,
    name: 'Je e-mailadres op het web',
    url: null,
    gives: 'Pagina\'s waarop je e-mailadres letterlijk staat, zoals ledenlijsten of oude forumberichten.',
    needs: 'Een zoekdienst (BRAVE_API_KEY) en jouw toestemming: je zet het zelf aan bij Zoekgegevens, want dan gaat je e-mailadres naar de zoekdienst.',
  },
  {
    id: 'paginas',
    category: 'web',
    phase: 4,
    name: 'Gevonden pagina\'s zelf lezen',
    url: null,
    gives: 'Of je gegevens echt op een gevonden webpagina staan, en niet alleen in het fragment van de zoekmachine.',
    needs: 'Staat standaard aan (PAGE_CHECK=off zet het uit). Geen databrokers en sociale media, en robots.txt geldt.',
  },
  {
    id: 'ai',
    category: 'ai',
    phase: 5,
    name: 'AI-model (Ollama)',
    url: 'https://ollama.com',
    gives: 'Een inschatting of een resultaat over jou gaat, en welke gegevens erin staan, alleen als die letterlijk in de tekst staan. De AI kiest ook welke gevonden pagina\'s we nog lezen.',
    needs: 'Ollama op je eigen computer en AI_PROVIDER=ollama in je .env (zie de README).',
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
//   sms           kan de site een code per sms sturen (zie sms.js)? Zonder sms geen bevestigd telefoonnummer.
//   pageCheck     leest de site gevonden pagina's zelf (zie research/page-reader.js)?
//   ai            de AI-agent (zie ai/agent.js), of null
export function describeRegister({
  emailSources = ['hibp'], hasKey = false, search = null, sms = false, pageCheck = false, ai = null,
} = {}) {
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
  // Databrokers, sociale media en documenten: aparte zoekopdrachten in de Deep Scan, met dezelfde
  // zoekdienst. Zonder (echte) zoekdienst gebeurt er niets, en dat staat er dan.
  const viaSearch = (note) => {
    if (!search) return { state: 'niet-ingesteld', note: 'Er is geen zoekdienst ingesteld, dus hier wordt niet gezocht.' };
    if (search.isDemo) return { state: 'demo', note: 'De demo verzint resultaten; hier wordt niet echt gezocht.' };
    return { state: 'actief', note };
  };
  const brokerCount = BROKERS.filter((broker) => broker.access === 'search').length;

  const states = {
    hibp: hibpKey
      ? { state: 'actief', note: 'Elk e-mailadres gaat naar Have I Been Pwned.' }
      : { state: 'testmodus', note: 'Zonder sleutel (HIBP_API_KEY) werken alleen de testadressen van Have I Been Pwned.' },
    xon: xonOn
      ? { state: 'actief', note: 'Gratis, met een lage limiet: 25 controles per uur en 100 per dag, voor de hele site.' }
      : { state: 'uit', note: 'Staat uit. Met FREE_BREACH_CHECK=on controleert de app echte adressen gratis.' },
    'pwned-passwords': { state: 'actief', note: 'Wordt nu gebruikt bij het maken van een account.' },
    search: searchState,
    databrokers: viaSearch(`In de Deep Scan zoeken we op je naam bij ${brokerCount} bekende databrokers en telefoongidsen, met site:-zoekopdrachten. We openen hun sites niet. Per databroker zie je wat ze verwerken en of er iets gevonden is.`),
    social: viaSearch('In de Deep Scan één zoekopdracht op je naam, beperkt tot LinkedIn, Facebook, Instagram, X, TikTok en YouTube. Alleen wat openbaar in de zoekdienst staat.'),
    documenten: viaSearch('In de Deep Scan één zoekopdracht op je naam naar pdf-, Word- en Excel-bestanden.'),
    telefoon: sms
      ? viaSearch('In de Deep Scan één zoekopdracht met de schrijfwijzen van je nummer, maar alleen als je het met een sms-code hebt bevestigd (bij Zoekgegevens). Een bevestigd e-mailadres bewijst niet dat een nummer van jou is.')
      : { state: 'niet-ingesteld', note: 'Er is nog geen sms-dienst gekoppeld, dus niemand kan hier een telefoonnummer bevestigen. Zonder bevestiging onderzoeken we geen nummer.' },
    'email-web': viaSearch('In de Deep Scan één zoekopdracht op je e-mailadres, maar alleen als je dat zelf aanzet bij Zoekgegevens.'),
    paginas: pageCheck
      ? viaSearch('In de Deep Scan lezen we hooguit een paar gevonden gewone webpagina\'s zelf, en kijken we of je gegevens erop staan.')
      : { state: 'uit', note: 'Staat uit (PAGE_CHECK=off). Dan zien we alleen het fragment van de zoekmachine.' },
    ai: ai
      ? { state: 'actief', note: `Het model ${ai.model} via ${ai.providerName}${ai.local ? ', op deze computer: er gaat niets naar een externe AI-dienst' : `, op ${new URL(ai.url).host}`}.` }
      : { state: 'niet-ingesteld', note: 'Er is geen AI ingesteld. Met Ollama op je eigen computer en AI_PROVIDER=ollama in je .env kijkt een lokaal model mee.' },
  };

  return REGISTER.map((entry) => ({
    ...entry,
    categoryName: CATEGORIES[entry.category],
    ...(states[entry.id] ?? { state: 'gepland', note: entry.needs ?? null }),
    stateLabel: STATE_LABELS[(states[entry.id] ?? { state: 'gepland' }).state],
  }));
}
