// Je e-mailadres bevestigen. De mail bevat een link met een willekeurig token. In
// de database bewaren we alleen de hash van dat token (net als bij sessies). De
// link is kort geldig en werkt maar één keer.
import { createHash, randomBytes } from 'node:crypto';

export const CONFIRM_MINUTES = 30;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/; // 32 willekeurige bytes, als base64url

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

// Maakt een nieuw token. Oudere links voor dit account werken daarna niet meer.
export function createConfirmation(db, userId, now = Date.now()) {
  const token = randomBytes(32).toString('base64url');
  db.prepare('DELETE FROM email_confirmations WHERE user_id = ?').run(userId);
  db.prepare('INSERT INTO email_confirmations (id, user_id, expires_at) VALUES (?, ?, ?)')
    .run(hashToken(token), userId, now + CONFIRM_MINUTES * 60 * 1000);
  return token;
}

function findConfirmation(db, token, now) {
  if (!TOKEN_PATTERN.test(token)) return null;
  return db
    .prepare('SELECT user_id FROM email_confirmations WHERE id = ? AND expires_at > ?')
    .get(hashToken(token), now) ?? null;
}

// Is dit een bestaand token dat nog niet verlopen is? Verandert niets.
export function isConfirmationValid(db, token, now = Date.now()) {
  return findConfirmation(db, token, now) !== null;
}

// Bevestigt het e-mailadres en maakt het token onbruikbaar. Geeft true of false.
export function confirmEmail(db, token, now = Date.now()) {
  const found = findConfirmation(db, token, now);
  if (!found) return false;
  db.prepare('UPDATE users SET email_confirmed_at = COALESCE(email_confirmed_at, ?) WHERE id = ?')
    .run(now, found.user_id);
  db.prepare('DELETE FROM email_confirmations WHERE user_id = ?').run(found.user_id);
  return true;
}

// Maakt een token en mailt de link. baseUrl komt uit de instellingen en nooit uit
// het verzoek zelf: anders kan iemand met een verzonnen Host-header een mail laten
// versturen met een link naar zijn eigen site.
export async function sendConfirmationMail({ db, mailer, baseUrl, user }) {
  const token = createConfirmation(db, user.id);
  const link = `${baseUrl}/e-mail-bevestigen?token=${token}`;
  const name = String(user.name).replace(/\s+/g, ' ');

  await mailer.send({
    to: user.email,
    subject: 'Bevestig je e-mailadres voor Privacyscan',
    text: [
      `Hoi ${name},`,
      '',
      'Je hebt bij Privacyscan een account gemaakt met dit e-mailadres.',
      'Klik op deze link om te bevestigen dat het adres van jou is:',
      '',
      link,
      '',
      `De link is ${CONFIRM_MINUTES} minuten geldig en werkt één keer. Is hij verlopen?`,
      'Log dan in en vraag op je dashboard een nieuwe mail aan.',
      '',
      'Heb je zelf geen account gemaakt? Dan hoef je niets te doen. Zolang dit adres',
      'niet bevestigd is, zoeken we niets voor je op.',
      '',
    ].join('\n'),
  });
}
