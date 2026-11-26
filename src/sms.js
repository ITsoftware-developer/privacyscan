// Sms'jes versturen, voor de code waarmee je je telefoonnummer bevestigt.
//
// Er is nog geen sms-dienst gekoppeld. Op je eigen computer komen de sms'jes daarom in een testpostvak
// (/dev/sms, net als de mails op /dev/mails): dan bevestig je je nummer met de code die daar staat. Op
// een openbare site (production) kan bevestigen nog niet, en zegt de site dat eerlijk. Een echte
// sms-dienst koppelen is een aparte stap (zie de README): daar hoort een abonnement en een sleutel bij.
export function createSmsSender({ production = false } = {}) {
  const outbox = [];
  return {
    // Kan de site nu een sms sturen?
    available: !production,
    usesProvider: false,
    outbox,
    async send(to, text) {
      if (production) throw new Error('Er is geen sms-dienst gekoppeld.');
      outbox.unshift({ to, text, sentAt: Date.now() });
      outbox.length = Math.min(outbox.length, 20);
    },
  };
}
