// De zoekopdrachten van het uitgebreide onderzoek. Elke zoekopdracht wordt gemaakt van de gegevens van
// het account zelf; niemand kan er iets in typen. Ze gebruiken de zoekoperatoren die de Brave Search API
// ondersteunt (site:, filetype:, OR; zie de README).
//
// Elke zoekopdracht kost een betaalde aanvraag, en elke Deep Scan heeft een grens (budget.js). Daarom
// bundelen we waar het kan: één zoekopdracht voor alle schrijfwijzen van je telefoonnummer, één per
// groepje databrokers, één voor alle sociale netwerken.
import { searchGroups } from '../brokers/registry.js';
import { phoneVariants } from '../phone.js';
import { cleanName } from '../search.js';

// De sociale netwerken waar we op je naam zoeken: alleen wat openbaar in de zoekdienst staat.
export const SOCIAL_SITES = ['linkedin.com', 'facebook.com', 'instagram.com', 'x.com', 'tiktok.com', 'youtube.com'];

// De soorten documenten waar persoonsgegevens vaak in staan (notulen, ledenlijsten, uitslagen, cv's).
export const DOCUMENT_TYPES = ['pdf', 'doc', 'docx', 'xls', 'xlsx'];

const quoted = (text) => `"${String(text).replace(/"/g, '')}"`;
const anyOf = (operator, values) => values.map((value) => `${operator}${value}`).join(' OR ');

// Je naam, letterlijk. null als er te weinig van over is om op te zoeken.
function exactName(name) {
  const clean = cleanName(name);
  return clean && clean.replace(/[^\p{L}]/gu, '').length >= 3 ? quoted(clean) : null;
}

export function socialQuery(name) {
  const who = exactName(name);
  return who ? `${who} ${anyOf('site:', SOCIAL_SITES)}` : null;
}

export function documentsQuery(name) {
  const who = exactName(name);
  return who ? `${who} ${anyOf('filetype:', DOCUMENT_TYPES)}` : null;
}

// Eén zoekopdracht per groepje databrokers (zie brokers/registry.js), met de databrokers erbij.
export function brokerQueries(name) {
  const who = exactName(name);
  if (!who) return [];
  return searchGroups().map((brokers) => ({
    brokers,
    query: `${who} ${anyOf('site:', brokers.map((broker) => broker.domain))}`,
  }));
}

export function phoneQuery(phone) {
  return phone ? phoneVariants(phone).map(quoted).join(' OR ') : null;
}

export function emailQuery(email) {
  return email ? quoted(email) : null;
}
