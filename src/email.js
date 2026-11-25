// E-mailadressen: dezelfde regels bij het registreren en bij het instellen van de beheerder.
export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL = 254;

// Spaties eraf en kleine letters.
export function normalizeEmail(value) {
  return String(value ?? '').trim().toLowerCase();
}

// Is dit (al genormaliseerde) adres bruikbaar?
export function isValidEmail(email) {
  return EMAIL_PATTERN.test(email) && email.length <= MAX_EMAIL;
}
