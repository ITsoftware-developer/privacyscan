// Proefaanvragen naar de echte bronnen: voor `npm run controleer` en voor de testknoppen op de
// beheerpagina. Ze sturen nooit iets van een gebruiker mee: een neutrale zoekopdracht en een
// voorbeeldadres. De uitkomst is een korte zin in gewone woorden, zonder sleutel of adres.
import { ScanError } from './scan-error.js';
import { cleanResults } from './search.js';

// Een zoekopdracht waar elke zoekmachine resultaten bij geeft.
export const NEUTRAL_QUERY = '"Domtoren" "Utrecht"';
// Een adres dat nergens bij hoort: voor als je geen eigen adres meegeeft.
export const EXAMPLE_ADDRESS = 'controle@example.com';
// Een testadres van Have I Been Pwned zelf: dat werkt ook zonder eigen sleutel.
export const HIBP_TEST_ADDRESS = 'account-exists@hibp-integration-tests.com';

export const BRAVE_PROBLEMS = {
  bad_key: 'Brave weigert de sleutel (HTTP 401 of 403). Controleer BRAVE_API_KEY in je .env: de sleutel van je Search-abonnement, zonder aanhalingstekens of spaties.',
  rate_limited: 'Brave staat geen aanvragen meer toe (HTTP 402 of 429): het tegoed of de limiet is op, of er is geen betaalmethode ingesteld op je Brave-account.',
  unavailable: 'Brave is niet bereikbaar: geen internet, een firewall of een storing bij Brave.',
  unexpected: 'Brave gaf een antwoord dat de koppeling niet kan lezen. Dan past de koppeling misschien niet meer bij de dienst: meld dit, samen met de regel hierboven.',
  budget: 'Niet getest: de kostengrens van de site (per dag of per maand) is bereikt, en ook een test kost een betaalde aanvraag. Hij werkt weer als de dag of maand om is, of verhoog de grens in je .env.',
};

export const XON_PROBLEMS = {
  rate_limited: 'XposedOrNot staat geen aanvragen meer toe: de gratis limiet (25 per uur, 100 per dag) is bereikt. Probeer het later nog eens.',
  unavailable: 'XposedOrNot is niet bereikbaar: geen internet, een firewall of een storing.',
  unexpected: 'XposedOrNot gaf een antwoord dat de koppeling niet kan lezen. Dan past de koppeling misschien niet meer bij de dienst: meld dit, samen met de regel hierboven.',
};

export const HIBP_PROBLEMS = {
  no_key: 'Voor dit adres is geen sleutel van Have I Been Pwned ingesteld.',
  bad_key: 'Have I Been Pwned weigert de sleutel. Controleer HIBP_API_KEY in je .env.',
  rate_limited: 'Have I Been Pwned vraagt om even te wachten (limiet van je abonnement). Probeer het over een minuut opnieuw.',
  busy: 'Er liepen al veel controles tegelijk. Probeer het over een minuut opnieuw.',
  unavailable: 'Have I Been Pwned is niet bereikbaar: geen internet, een firewall of een storing.',
  unexpected: 'Have I Been Pwned gaf een antwoord dat de koppeling niet kan lezen.',
};

export function explain(error, problems) {
  if (error instanceof ScanError) return problems[error.code] ?? problems.unexpected;
  return `Onverwachte fout: ${String(error?.message ?? error).split('\n')[0].slice(0, 200)}`;
}

const plural = (count, one, many) => (count === 1 ? `1 ${one}` : `${count} ${many}`);

// Zoekt één keer met de neutrale zoekopdracht. Geeft { ok, text }.
export async function probeSearch(search) {
  try {
    const results = cleanResults(await search.search({ query: NEUTRAL_QUERY, name: 'Domtoren', city: 'Utrecht' }));
    if (results.length === 0) {
      return { ok: false, text: 'De zoekdienst antwoordde, maar zonder één bruikbaar resultaat bij een neutrale zoekopdracht. Controleer je abonnement.' };
    }
    return { ok: true, text: `De sleutel werkt: ${plural(results.length, 'resultaat', 'resultaten')} gelezen bij een neutrale zoekopdracht.` };
  } catch (error) {
    return { ok: false, text: explain(error, BRAVE_PROBLEMS) };
  }
}

// Leest de lijst met lekken van XposedOrNot en controleert het voorbeeldadres. Geeft { ok, text }.
export async function probeXon(xon) {
  try {
    const size = await xon.listSize();
    await xon.breachesFor(EXAMPLE_ADDRESS);
    return { ok: true, text: `De lijst met bekende lekken is gelezen (${plural(size, 'lek', 'lekken')}) en een controle met een voorbeeldadres is gelukt.` };
  } catch (error) {
    return { ok: false, text: explain(error, XON_PROBLEMS) };
  }
}

// Controleert het testadres van Have I Been Pwned. Geeft { ok, text }.
export async function probeHibp(hibp) {
  try {
    const breaches = await hibp.breachesFor(HIBP_TEST_ADDRESS);
    return { ok: true, text: `Het testadres van Have I Been Pwned is gecontroleerd (${plural(breaches.length, 'lek', 'lekken')}).` };
  } catch (error) {
    return { ok: false, text: explain(error, HIBP_PROBLEMS) };
  }
}

// Vraagt Ollama welke modellen er zijn, en of het ingestelde model erbij zit. Dit kost niets en stuurt geen
// persoonsgegevens. Geeft { ok, text }.
export async function probeOllama(provider) {
  try {
    const models = await provider.models();
    const wanted = String(provider.model);
    const present = models.some((name) => name === wanted || name === `${wanted}:latest` || (!wanted.includes(':') && name.startsWith(`${wanted}:`)));
    if (!present) {
      return { ok: false, text: `Ollama antwoordt, maar het model ${wanted} is niet geïnstalleerd. Installeer het met: ollama pull ${wanted}` };
    }
    return { ok: true, text: `Ollama antwoordt en het model ${wanted} is geïnstalleerd (${plural(models.length, 'model', 'modellen')} in totaal).` };
  } catch (error) {
    if (error?.code === 'unavailable' || error?.code === 'timeout') {
      return { ok: false, text: `Ollama is niet bereikbaar op ${provider.url}. Staat Ollama aan? Op Windows start het meestal vanzelf; anders: ollama serve.` };
    }
    return { ok: false, text: 'Ollama gaf een onverwacht antwoord.' };
  }
}
