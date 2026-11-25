// Hoe zeker is het dat een bevinding over jou gaat? Dat bepalen duidelijke regels, geen gok, en
// bij elke beoordeling staat waarom. Zekerheid is niet hetzelfde als bewijs: ook bij "hoog"
// kan het een naamgenoot zijn.
//
// Elke bevinding heeft drie dingen die je kunt nalopen: een bron, een datum (wanneer is het
// onderzocht) en een zekerheid. De app verzint geen bevindingen en geen bronnen.

export const CONFIDENCE_LABELS = {
  hoog: 'Hoog',
  gemiddeld: 'Gemiddeld',
  laag: 'Laag',
  demo: 'Demo (verzonnen)',
};

// De naam van een zekerheid voor in de pagina's. Een bevinding uit de tijd voor deze functie
// heeft er geen: die tonen we als "Niet beoordeeld" en nooit als iets wat we niet weten.
export function confidenceLabel(level) {
  return typeof level === 'string' && Object.hasOwn(CONFIDENCE_LABELS, level)
    ? CONFIDENCE_LABELS[level]
    : 'Niet beoordeeld';
}

// Een datalek: de bron zegt zelf dat dit e-mailadres erin staat.
export const BREACH_CONFIDENCE = {
  level: 'hoog',
  note: 'De bron zegt dat dit e-mailadres in dit lek staat (letterlijke overeenkomst).',
};

// De demo-zoekdienst verzint alles, dus daar is geen zekerheid te geven.
export const DEMO_CONFIDENCE = {
  level: 'demo',
  note: 'Demo: dit resultaat is verzonnen en komt uit geen enkele echte bron.',
};

// Hoofdletters, accenten en leestekens maken niet uit: "José  VAN-Dijk" wordt "jose van dijk".
function fold(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

// Beoordeelt een webresultaat aan de hand van alleen de titel en het fragment dat de
// zoekdienst teruggaf (de pagina zelf lezen we niet):
//   hoog       je volledige naam én je woonplaats staan erin
//   gemiddeld  je volledige naam staat erin
//   laag       de naam staat er niet, of alleen in losse stukken
export function rateWebResult({ name, city = null, title = '', snippet = '' }) {
  const who = fold(name);
  const where = fold(city);
  const text = ` ${fold(`${title} ${snippet}`)} `;
  // Hele woorden: "Utrecht" komt niet voor in "Utrechtseweg".
  const hasPhrase = (phrase) => phrase !== '' && text.includes(` ${phrase} `);

  if (hasPhrase(who)) {
    if (hasPhrase(where)) {
      return {
        level: 'hoog',
        note: 'Je volledige naam én je woonplaats staan in de titel of het fragment. Een naamgenoot in dezelfde plaats is nog steeds mogelijk.',
      };
    }
    return {
      level: 'gemiddeld',
      note: where
        ? 'Je volledige naam staat erin, je woonplaats niet. Het kan een naamgenoot zijn.'
        : 'Je volledige naam staat erin. Zonder woonplaats kunnen we naamgenoten niet uitsluiten.',
    };
  }

  const parts = who.split(' ').filter((part) => part.length > 1);
  if (parts.length > 1 && parts.every(hasPhrase)) {
    return { level: 'laag', note: 'Alle delen van je naam staan erin, maar niet als je volledige naam achter elkaar.' };
  }
  return { level: 'laag', note: 'Je naam staat niet in de titel of het fragment dat de zoekdienst gaf.' };
}
