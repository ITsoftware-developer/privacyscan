// De pauzeknoppen van de beheerpagina. Een gepauzeerde bron krijgt geen aanvragen meer van de site:
// wie zoekt, hoort dat de bron tijdelijk uit staat. Handig als een dienst storing heeft, of als je
// wilt voorkomen dat het verbruik (en de rekening) oploopt. De keuze staat in de database, dus hij
// blijft gelden na een herstart. Sleutels en andere instellingen blijven in .env: die zijn hier niet
// te zien of te veranderen.
import { ScanError } from './scan-error.js';
import { SERVICES } from './services.js';

const keyFor = (service) => `paused:${service}`;

export function canPause(service) {
  return Object.hasOwn(SERVICES, service) && SERVICES[service].pausable;
}

// Sinds wanneer staat deze bron op pauze? null = niet gepauzeerd.
export function pausedSince(db, service) {
  const row = db.prepare('SELECT updated_at FROM settings WHERE key = ? AND value = ?').get(keyFor(service), '1');
  return row ? row.updated_at : null;
}

export function isPaused(db, service) {
  return canPause(service) && pausedSince(db, service) !== null;
}

// Zet een bron op pauze (true) of weer aan (false). Geeft true als er iets veranderde.
export function setPaused(db, service, paused, now = Date.now()) {
  if (!canPause(service)) throw new Error(`Deze bron kan niet gepauzeerd worden: ${service}`);
  if (paused) {
    if (isPaused(db, service)) return false;
    db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, '1', ?)
      ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(keyFor(service), now);
    return true;
  }
  return db.prepare('DELETE FROM settings WHERE key = ?').run(keyFor(service)).changes > 0;
}

// Het id van de zoekdienst als dienst (brave), of null voor de demo en onbekende diensten.
function searchService(search) {
  if (!search || search.isDemo) return null;
  const id = String(search.id ?? search.name ?? '');
  return canPause(id) ? id : null;
}

// De zoekdienst met de pauzeknop ervoor. Alles wat de rest van de app van de zoekdienst leest (naam,
// demo of niet, bewaren of niet) komt ongewijzigd van het origineel; alleen zoeken kan nu "gepauzeerd"
// zijn. (Een Proxy geeft alle andere eigenschappen gewoon door.)
export function pausableSearch(search, db) {
  const service = searchService(search);
  if (!service) return search;
  const guarded = async (request) => {
    if (isPaused(db, service)) throw new ScanError('paused');
    return search.search(request);
  };
  return new Proxy(search, {
    get: (target, property, receiver) => (property === 'search' ? guarded : Reflect.get(target, property, receiver)),
  });
}

// De controle op datalekken met de pauzeknop ervoor. Welke bron een adres opzoekt (HIBP of
// XposedOrNot), bepaalt de controle zelf; staat die bron op pauze, dan vragen we niets.
export function pausableBreachCheck(check, db) {
  const sourceFor = (email) => (typeof check.sourceFor === 'function' ? check.sourceFor(email) : 'hibp');
  const guarded = async (email) => {
    const source = sourceFor(email);
    if (source && isPaused(db, source)) throw new ScanError('paused');
    return check.breachesFor(email);
  };
  return new Proxy(check, {
    get: (target, property, receiver) => (property === 'breachesFor' ? guarded : Reflect.get(target, property, receiver)),
  });
}
