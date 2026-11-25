// Mail versturen. Er zijn twee manieren:
//
// - SMTP_URL is ingesteld, bijvoorbeeld smtp://127.0.0.1:1025 voor Mailpit op je
//   eigen computer, of later de server van je mailprovider: de mail wordt echt
//   verstuurd.
// - Geen SMTP_URL: de mail komt in een testpostvak in het geheugen, te lezen op
//   /dev/mails (alleen op je eigen computer). Zo kun je alles proberen zonder iets
//   extra's te installeren. De mails verdwijnen als je de server herstart.
import nodemailer from 'nodemailer';

const OUTBOX_SIZE = 20;

export function createMailer({
  smtpUrl,
  from = 'Privacyscan <noreply@localhost>',
  createTransport = nodemailer.createTransport, // de tests vervangen deze
} = {}) {
  const transport = smtpUrl ? createTransport(smtpUrl) : null;
  const outbox = []; // het testpostvak, nieuwste mail eerst

  return {
    usesSmtp: Boolean(transport),
    outbox,

    async send({ to, subject, text }) {
      if (transport) {
        // Het adres gaat als los object mee. Zo leest nodemailer er nooit meerdere
        // adressen uit, ook niet als er een komma in een adres zou staan.
        await transport.sendMail({ from, to: { name: '', address: to }, subject, text });
        return;
      }
      outbox.unshift({ to, subject, text, sentAt: Date.now() });
      outbox.length = Math.min(outbox.length, OUTBOX_SIZE);
    },
  };
}
