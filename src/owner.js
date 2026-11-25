// De beheerder: het ene account dat op een openbare site op naam mag zoeken, zonder
// identiteitscheck. Dat is vertrouwen en geen bewijs: de site gelooft dat de naam op
// dat account van de beheerder zelf is. Daarom is het één account, aangewezen door
// wie de site draait (OWNER_EMAIL in .env), en niet iets wat een bezoeker zelf kan
// aanzetten.
import { isValidEmail, normalizeEmail } from './email.js';

// Leest OWNER_EMAIL. Leeg betekent: er is geen beheerder (null). Een ongeldig adres
// is een fout, zodat een typfout niet stilletjes betekent dat niemand mag zoeken.
export function parseOwnerEmail(value) {
  const email = normalizeEmail(value);
  if (email === '') return null;
  if (!isValidEmail(email)) {
    throw new Error(`OWNER_EMAIL is geen geldig e-mailadres: "${String(value).trim()}".`);
  }
  return email;
}

// Is dit het adres van de beheerder? Het moet precies kloppen; hoofdletters of kleine
// letters maken niet uit. Over bevestigd zijn zegt dit nog niets.
export function hasOwnerAddress(user, ownerEmail) {
  return Boolean(ownerEmail) && normalizeEmail(user?.email) === ownerEmail;
}

// Is deze gebruiker de beheerder? Het adres moet ook bevestigd zijn. Zonder die
// bevestiging zou iedereen beheerder worden door te registreren met jouw adres.
export function isOwner(user, ownerEmail) {
  return hasOwnerAddress(user, ownerEmail) && Boolean(user.email_confirmed_at);
}
