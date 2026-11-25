// Kiest per e-mailadres welke bron de datalekken opzoekt: Have I Been Pwned of de gratis
// dienst XposedOrNot. De rest van de app praat met dit ene object en weet niet welke
// bron er achter zit; alleen bij de resultaten staat welke bron het was (zie sources.js).
//
// De keuze:
//   1. Heeft de site een eigen HIBP-sleutel, dan gaat elk adres naar HIBP.
//   2. Anders gaan de testadressen van HIBP (die werken met hun gratis testsleutel) naar
//      HIBP, en elk ander adres naar XposedOrNot, als de gratis controle aanstaat.
//   3. Staat die uit, dan kunnen alleen de testadressen gecontroleerd worden.

// Leest de instelling FREE_BREACH_CHECK uit .env. Leeg betekent: aan op je eigen computer
// en uit op een openbare site (production), want de gratis dienst is bedoeld voor
// persoonlijk gebruik. Wie hem online toch wil gebruiken, zet hem bewust op "on".
export function parseFreeBreachCheck(value, { production = false } = {}) {
  const text = String(value ?? '').trim().toLowerCase();
  if (text === '') return !production;
  if (['on', 'true', '1', 'aan', 'yes', 'ja'].includes(text)) return true;
  if (['off', 'false', '0', 'uit', 'no', 'nee'].includes(text)) return false;
  throw new Error('FREE_BREACH_CHECK moet "on" of "off" zijn (of leeg). Controleer je .env.');
}

export function createBreachCheck({ hibp, xon = null }) {
  const sourceFor = (email) => {
    if (hibp.hasKeyFor(email)) return 'hibp';
    return xon ? 'xon' : null;
  };

  return {
    // Kan de site elk adres controleren, en niet alleen de testadressen van HIBP?
    // (De naam komt van het HIBP-object waar dit voor in de plaats komt.)
    hasKey: hibp.hasKey || xon !== null,

    // Kunnen we voor dit adres zoeken?
    hasKeyFor: (email) => sourceFor(email) !== null,

    // Welke bron zoekt dit adres op? 'hibp', 'xon' of null.
    sourceFor,

    // Naar welke bron gaan de adressen van gewone bezoekers? Voor de privacyverklaring.
    emailSources: hibp.hasKey || !xon ? ['hibp'] : ['xon'],

    // Geeft de datalekken waarin dit adres voorkomt (een lege lijst als het nergens in staat).
    breachesFor(email) {
      return (sourceFor(email) === 'xon' ? xon : hibp).breachesFor(email);
    },
  };
}
