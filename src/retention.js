// Wat we van webresultaten bewaren, en hoe lang.
//
// Sommige zoekdiensten (Brave Search) staan niet toe dat we hun resultaten bewaren, behalve de
// tijdelijke opslag die de app nodig heeft om te werken: na een zoekopdracht stuurt de site je naar
// de resultatenpagina, en daar moeten de resultaten nog staan. Daarom bewaren we ze maximaal
// WEB_RESULT_MINUTES minuten. Jouw keuzes (Dit ben ik / Dit ben ik niet / Weet ik niet) blijven wel
// bestaan, zonder de resultaten zelf: daarvoor bewaren we alleen een vingerafdruk van het adres.
import { createHash } from 'node:crypto';

export const WEB_RESULT_MINUTES = 30;
export const WEB_RESULT_MS = WEB_RESULT_MINUTES * 60 * 1000;

// De vingerafdruk (SHA-256) van een webadres, zonder het deel na #. Dat is een code, niet het
// adres zelf. Hij is geen geheim: wie het adres kent, kan de code uitrekenen.
export function webKey(url) {
  let text;
  try {
    const parsed = new URL(String(url));
    parsed.hash = '';
    text = parsed.href;
  } catch {
    text = String(url);
  }
  return createHash('sha256').update(text).digest('hex');
}
