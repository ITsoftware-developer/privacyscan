// Controleert of een wachtwoord in bekende datalekken voorkomt, via de gratis
// Pwned Passwords-API van Have I Been Pwned (geen API-sleutel nodig).
//
// Je wachtwoord verlaat je server nooit: we sturen alleen de eerste 5 tekens
// van de SHA-1-hash mee. De API stuurt alle hashes terug die zo beginnen, en
// wij kijken zelf of de rest erbij zit. Dat heet "k-anonymity".
import { createHash } from 'node:crypto';

const API_URL = 'https://api.pwnedpasswords.com/range/';

// Geeft terug hoe vaak het wachtwoord in datalekken is gezien (0 = nooit).
export async function timesPwned(password, { fetchFn = fetch, timeoutMs = 3000 } = {}) {
  const sha1 = createHash('sha1').update(password, 'utf8').digest('hex').toUpperCase();
  const prefix = sha1.slice(0, 5);
  const suffix = sha1.slice(5);

  const response = await fetchFn(API_URL + prefix, {
    headers: {
      'Add-Padding': 'true', // extra nepregels, zodat niemand aan de grootte van het antwoord iets afleest
      'User-Agent': 'privacyscan (fase 1)',
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`Pwned Passwords gaf status ${response.status}`);

  for (const line of (await response.text()).split('\n')) {
    const [hashSuffix, count] = line.trim().split(':');
    if (hashSuffix === suffix) return Number(count); // opvulregels hebben count 0
  }
  return 0;
}

// Ja/nee-versie voor het registratieformulier. Is de API niet bereikbaar
// (bijvoorbeeld als je offline werkt), dan laten we de registratie gewoon
// doorgaan in plaats van iedereen buiten te sluiten.
export async function isPwned(password, options) {
  try {
    return (await timesPwned(password, options)) > 0;
  } catch (error) {
    console.warn(`Wachtwoordcheck overgeslagen: ${error.message}`);
    return false;
  }
}
