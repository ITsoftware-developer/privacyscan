// Waar de gegevens over datalekken vandaan komen. Elke bron moet bij de resultaten
// genoemd worden, en dat gebeurt aan de hand van deze lijst.
//
//   hibp  Have I Been Pwned: de bekendste, maar voor echte adressen is een betaalde sleutel nodig.
//   xon   XposedOrNot: gratis en zonder sleutel, met een lage limiet (zie xon.js).
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

// Zoekt een bron op. Wat we niet kennen (of niet meegekregen hebben, zoals bij
// resultaten uit de tijd dat er alleen HIBP was), is Have I Been Pwned.
export function sourceById(id) {
  return typeof id === 'string' && Object.hasOwn(SOURCES, id) ? SOURCES[id] : SOURCES.hibp;
}

// De website van een bron zonder "https://", om in een zin te zetten.
export function sourceHost(source) {
  return new URL(source.url).host;
}
