// Wat er op een gelezen pagina staat (zie page-reader.js), vastgelegd bij het webresultaat zelf. De stap
// "Gevonden pagina's zelf controleren" en de AI-stap gebruiken dit allebei, zodat een pagina die de AI
// laat lezen precies zo gecontroleerd wordt als de rest.
//
// We bewaren niet de pagina. Bij het webresultaat komt: wanneer we keken, welke van je gegevens erop
// stonden (naam, woonplaats, e-mailadres, telefoonnummer) en een kort stuk tekst rond je naam. Dat verloopt
// samen met het webresultaat.
import { matchesIn } from '../confidence.js';
import { updateWebFinding } from '../findings.js';
import { FOUND_LABELS } from './page-reader.js';
import { identityOf } from './web-research.js';

// Een kort stuk tekst rond de plek waar je naam (of anders je e-mailadres) op de pagina staat.
export function excerptAround(text, { name, email }, radius = 110) {
  const source = String(text ?? '').replace(/\s+/g, ' ');
  const words = String(name ?? '').trim().split(/\s+/).filter(Boolean)
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  let index = -1;
  let length = 0;
  if (words.length > 0) {
    const match = new RegExp(words.join('\\s+'), 'iu').exec(source);
    if (match) {
      index = match.index;
      length = match[0].length;
    }
  }
  if (index < 0 && email) {
    index = source.toLowerCase().indexOf(String(email).toLowerCase());
    length = String(email).length;
  }
  if (index < 0) return null;
  const start = Math.max(0, index - radius);
  const end = Math.min(source.length, index + length + radius);
  return `${start > 0 ? '…' : ''}${source.slice(start, end).trim()}${end < source.length ? '…' : ''}`;
}

// Nieuwe zekerheid na het lezen van de pagina: alleen omhoog, nooit omlaag (een pagina kan zijn tekst pas
// later laden, en dan zien wij hem niet). Geeft { level, note } of null.
export function ratingFromPage(found, current) {
  if (found.email || found.telefoon) {
    return {
      level: 'hoog',
      note: `Je bevestigde ${found.email ? 'e-mailadres' : 'telefoonnummer'} staat op de pagina zelf. Dat is een sterke aanwijzing, geen bewijs: kijk zelf.`,
    };
  }
  const rank = {
    geen: 0, laag: 1, gemiddeld: 2, hoog: 3,
  };
  if (found.naam && found.woonplaats && (rank[current] ?? 0) < 2) {
    return { level: 'gemiddeld', note: 'Je volledige naam én je woonplaats staan op de pagina zelf. Een naamgenoot in dezelfde plaats is mogelijk.' };
  }
  if (found.naam && (rank[current] ?? 0) < 1) {
    return { level: 'laag', note: 'Je volledige naam staat op de pagina zelf (niet in het fragment van de zoekmachine). Het kan een naamgenoot zijn.' };
  }
  return null;
}

// Legt de uitkomst van één gelezen (of niet gelezen) pagina vast bij het webresultaat. De tekst van een
// gelezen pagina komt alleen in `pages` (in het geheugen, voor deze scan). Geeft 'niet-gelezen',
// 'met-gegevens' of 'zonder-gegevens'.
export function applyPageResult({
  db, user, item, result, now, pages,
}) {
  if (result.status !== 'gelezen') {
    updateWebFinding(db, user.id, item.id, { details: { page: { status: result.status, checkedAt: now } } }, now);
    return 'niet-gelezen';
  }
  pages.set(item.id, { title: result.title, text: result.text });
  const who = identityOf(user);
  const found = matchesIn(`${result.title}\n${result.text}`, who);
  const any = found.naam || found.email || found.telefoon;
  const rating = ratingFromPage(found, item.confidence);
  updateWebFinding(db, user.id, item.id, {
    details: {
      page: {
        status: 'gelezen',
        checkedAt: now,
        found: Object.keys(FOUND_LABELS).filter((key) => found[key]),
        excerpt: any ? excerptAround(result.text, who) : null,
      },
    },
    level: rating?.level ?? null,
    note: rating?.note ?? null,
  }, now);
  return any ? 'met-gegevens' : 'zonder-gegevens';
}
