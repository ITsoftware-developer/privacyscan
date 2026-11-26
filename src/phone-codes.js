// De code waarmee je je telefoonnummer bevestigt.
//
// Een bevestigd e-mailadres bewijst niet dat een telefoonnummer van dezelfde persoon is. Daarom sturen we
// een code naar het nummer zelf: wie de code terugtypt, heeft dat nummer in handen. Pas dan onderzoeken we
// het (zie scanner.js, de stap "telefoon").
//
// In de database staat nooit de code zelf, alleen een HMAC ervan (een vingerafdruk met een geheime
// sleutel). Die sleutel staat alleen in het geheugen van de server: wie de database in handen krijgt, kan
// de code er dus niet uit halen, ook niet door alle miljoen mogelijke codes te proberen. Na een herstart
// van de server werkt een openstaande code daarom niet meer; dan vraag je een nieuwe aan.
import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

export const CODE_MINUTES = 10;  // zo lang is een code geldig
export const CODE_ATTEMPTS = 5;  // zo vaak mag je een verkeerde code invullen; daarna vraag je een nieuwe aan
export const CODE_DIGITS = 6;

// Een willekeurige code van zes cijfers, ook met nullen vooraan (012345).
export function newCode() {
  return String(randomInt(0, 10 ** CODE_DIGITS)).padStart(CODE_DIGITS, '0');
}

// Maakt de functie die een code omzet in een vingerafdruk. De code hoort bij één account en één nummer:
// dezelfde code voor een ander nummer of een ander account geeft een andere vingerafdruk.
export function createCodeHasher(key = randomBytes(32)) {
  return (userId, phone, code) => createHmac('sha256', key).update(`${userId}:${phone}:${code}`).digest('hex');
}

// Een nieuwe code voor dit account. Een eerdere code die nog openstond, vervalt daarmee.
export function startVerification(db, { userId, phone, codeHash, now = Date.now() }) {
  db.prepare(`
    INSERT INTO phone_codes (user_id, phone, code_hash, attempts, created_at, expires_at)
    VALUES (?, ?, ?, 0, ?, ?)
    ON CONFLICT (user_id) DO UPDATE SET
      phone = excluded.phone, code_hash = excluded.code_hash, attempts = 0,
      created_at = excluded.created_at, expires_at = excluded.expires_at
  `).run(userId, phone, codeHash, now, now + CODE_MINUTES * 60 * 1000);
}

// De openstaande code van dit account, als die er is en nog geldig is: { phone, attempts, expiresAt }.
export function pendingVerification(db, userId, now = Date.now()) {
  const row = db.prepare('SELECT phone, attempts, expires_at FROM phone_codes WHERE user_id = ? AND expires_at > ?')
    .get(userId, now);
  return row ? { phone: row.phone, attempts: row.attempts, expiresAt: row.expires_at } : null;
}

export function cancelVerification(db, userId) {
  db.prepare('DELETE FROM phone_codes WHERE user_id = ?').run(userId);
}

// Controleert een ingevulde code. Geeft terug:
//   { ok: true, phone }             de code klopt: het nummer is bevestigd (de code is dan opgebruikt)
//   { ok: false, reason: 'none' }   er staat geen geldige code open (nooit aangevraagd, of verlopen)
//   { ok: false, reason: 'wrong', left }  verkeerde code; `left` pogingen over
//   { ok: false, reason: 'too_many' }     te vaak verkeerd: de code is vervallen
export function checkCode(db, { userId, code, hashCode, now = Date.now() }) {
  const row = db.prepare('SELECT phone, code_hash, attempts FROM phone_codes WHERE user_id = ? AND expires_at > ?')
    .get(userId, now);
  if (!row) return { ok: false, reason: 'none' };

  const given = Buffer.from(hashCode(userId, row.phone, code), 'hex');
  const stored = Buffer.from(row.code_hash, 'hex');
  if (given.length === stored.length && timingSafeEqual(given, stored)) {
    cancelVerification(db, userId);
    return { ok: true, phone: row.phone };
  }

  const attempts = row.attempts + 1;
  if (attempts >= CODE_ATTEMPTS) {
    cancelVerification(db, userId);
    return { ok: false, reason: 'too_many' };
  }
  db.prepare('UPDATE phone_codes SET attempts = ? WHERE user_id = ?').run(attempts, userId);
  return { ok: false, reason: 'wrong', left: CODE_ATTEMPTS - attempts };
}

// Zet het bevestigde nummer op het account.
export function savePhone(db, userId, phone, now = Date.now()) {
  db.prepare('UPDATE users SET phone = ?, phone_verified_at = ? WHERE id = ?').run(phone, now, userId);
}

// Haalt het nummer weg, en een code die nog openstond.
export function removePhone(db, userId) {
  db.prepare('UPDATE users SET phone = NULL, phone_verified_at = NULL WHERE id = ?').run(userId);
  cancelVerification(db, userId);
}
