// Wat er bij het starten van de site met de bewaarde gegevens moet gebeuren, afhankelijk van de
// zoekdienst die nu is ingesteld. server.js roept dit aan; het staat hier apart zodat het getest
// kan worden zonder de server te starten.
import { purgeDemoData, removeExpired } from './db.js';
import { limitRetention } from './findings.js';
import { searchSourceId } from './scans.js';

// 1. Wat de demo ooit verzon, hoort niet tussen echte bevindingen te staan. Is er een andere
//    zoekdienst (of geen), dan wissen we het.
// 2. Staat de zoekdienst bewaren niet toe, dan krijgt wat er nog zonder einddatum van die dienst
//    stond (bijvoorbeeld uit de tijd dat je een abonnement met opslagrechten had) alsnog een
//    einddatum.
// 3. Wat al verlopen is, wissen we meteen.
//
// Geeft terug hoeveel nepresultaten er weg zijn en hoeveel resultaten een einddatum kregen.
export function prepareStorage(db, search, now = Date.now()) {
  const purged = search?.isDemo ? 0 : purgeDemoData(db);
  const limited = search && !search.isDemo && search.retainsResults !== true
    ? limitRetention(db, searchSourceId(search), now)
    : 0;
  removeExpired(db, now);
  return { purged, limited };
}
