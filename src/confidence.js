// Hoe zeker is het dat een bevinding over jou gaat? Dat bepalen duidelijke regels, geen gok, en
// bij elke beoordeling staat waarom. Zekerheid is niet hetzelfde als bewijs.
//
// Een datalek is een letterlijke overeenkomst met je bevestigde e-mailadres. Een webresultaat is
// altijd een MOGELIJKE overeenkomst: een naam en een woonplaats zeggen niet dat het om jou gaat,
// want naamgenoten komen veel voor. Pas als jij zelf "Dit ben ik" kiest, behandelen we een
// webresultaat als van jou.
//
// Elke bevinding heeft drie dingen die je kunt nalopen: een bron, een datum (wanneer is het
// onderzocht) en een zekerheid. De app verzint geen bevindingen en geen bronnen.

// Voor datalekken.
export const CONFIDENCE_LABELS = {
  hoog: 'Hoog',
  gemiddeld: 'Gemiddeld',
  laag: 'Laag',
  geen: 'Geen overeenkomst',
  demo: 'Demo (verzonnen)',
};

// Voor webresultaten: een overeenkomst met jouw naam, geen bewijs.
export const MATCH_LABELS = {
  hoog: 'Sterke overeenkomst',
  gemiddeld: 'Mogelijke overeenkomst',
  laag: 'Zwakke overeenkomst',
  geen: 'Geen overeenkomst in titel of fragment',
  demo: 'Demo (verzonnen)',
};

// Jouw eigen oordeel over een webresultaat.
export const DECISION_LABELS = {
  new: 'Nog niet beoordeeld',
  mine: 'Door jou bevestigd: dit ben jij',
  not_mine: 'Door jou afgewezen: niet van jou',
  unknown: 'Je weet het (nog) niet',
};

// De naam van een zekerheid voor in de pagina's. `kind` is 'web' voor een webresultaat. Een
// bevinding uit de tijd voor deze functie heeft er geen: die tonen we als "Niet beoordeeld" en
// nooit als iets wat we niet weten.
export function confidenceLabel(level, kind = 'breach') {
  const labels = kind === 'web' ? MATCH_LABELS : CONFIDENCE_LABELS;
  return typeof level === 'string' && Object.hasOwn(labels, level) ? labels[level] : 'Niet beoordeeld';
}

export function decisionLabel(status) {
  return typeof status === 'string' && Object.hasOwn(DECISION_LABELS, status)
    ? DECISION_LABELS[status]
    : DECISION_LABELS.new;
}

// Een datalek: de bron zegt zelf dat dit e-mailadres erin staat. Dat zegt iets over het adres,
// niet over elk gegeven dat bij het lek hoort: welke soorten gegevens het lek bevat, is wat de bron
// meldt voor het lek als geheel.
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

// Staat dit e-mailadres letterlijk in de tekst? Als heel adres: "anna@example.com" zit niet in
// "hanna@example.com" of in "anna@example.com.nl".
function containsAddress(text, email) {
  const address = String(email ?? '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+$/.test(address)) return false;
  const escaped = address.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![a-z0-9._%+-])${escaped}(?![a-z0-9-]|\\.[a-z0-9])`).test(String(text).toLowerCase());
}

// Beoordeelt een webresultaat aan de hand van alleen de titel en het fragment dat de
// zoekdienst teruggaf (de pagina zelf lezen we niet). Het blijft een MOGELIJKE overeenkomst:
//   hoog       je bevestigde e-mailadres staat letterlijk in de titel of het fragment
//   gemiddeld  je volledige naam én je woonplaats staan erin (een naamgenoot in dezelfde plaats
//              kan dat ook zijn)
//   laag       je volledige naam staat erin zonder woonplaats, of alleen de losse delen ervan
//   geen       je naam staat er niet in
// Een naam, ook met woonplaats, is nooit genoeg voor "hoog": daarvoor is een gegeven nodig dat we
// van jou hebben bevestigd, en dat is alleen je e-mailadres.
export function rateWebResult({ name, city = null, email = null, title = '', snippet = '' }) {
  const text = ` ${fold(`${title} ${snippet}`)} `;
  // Hele woorden: "Utrecht" komt niet voor in "Utrechtseweg".
  const hasPhrase = (phrase) => phrase !== '' && text.includes(` ${phrase} `);

  if (containsAddress(`${title} ${snippet}`, email)) {
    return {
      level: 'hoog',
      note: 'Je bevestigde e-mailadres staat letterlijk in de titel of het fragment. Dat is een sterke aanwijzing, geen bewijs: kijk zelf op de pagina.',
    };
  }

  const who = fold(name);
  const where = fold(city);
  if (hasPhrase(who)) {
    if (hasPhrase(where)) {
      return {
        level: 'gemiddeld',
        note: 'Je volledige naam én je woonplaats staan in de titel of het fragment. Een naamgenoot in dezelfde plaats is mogelijk: pas als jij het bevestigt, is het van jou.',
      };
    }
    return {
      level: 'laag',
      note: where
        ? 'Je volledige naam staat erin, je woonplaats niet. Het kan een naamgenoot zijn.'
        : 'Je volledige naam staat erin. Zonder woonplaats kunnen we naamgenoten niet uitsluiten.',
    };
  }

  const parts = who.split(' ').filter((part) => part.length > 1);
  if (parts.length > 1 && parts.every(hasPhrase)) {
    return { level: 'laag', note: 'Alle delen van je naam staan erin, maar niet als je volledige naam achter elkaar.' };
  }
  return {
    level: 'geen',
    note: 'Je naam staat niet in de titel of het fragment dat de zoekdienst gaf. De pagina zelf lezen we niet; misschien staat je naam daar wel.',
  };
}
