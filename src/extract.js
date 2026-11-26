// Wat er in een webresultaat op persoonsgegevens lijkt, en wat voor soort site het is.
//
// Alles hier werkt op de titel, het fragment en het adres die de zoekdienst al gaf: we openen nooit
// een pagina. Wat we vinden, vatten we gemaskeerd samen (+31 6 •••• 1234): zo zie je per resultaat
// welke gegevens het lijkt te bevatten, genoeg om het te herkennen als het van jou is. Het fragment
// zelf tonen we ongewijzigd, zoals de zoekdienst het gaf: dat is hun tekst, en we laten hem niet
// langer staan dan de zoekdienst toestaat. Het is ook maar wat het lijkt, want een resultaat kan
// over een naamgenoot gaan. "Mogelijk" is hier een eerlijk woord.
//
// Niets hiervan wordt bewaard. De weergave rekent het bij elke keer opnieuw uit uit de titel en
// het fragment die er toch al staan.
import { brokerForUrl } from './brokers/registry.js';
const DOT = '•';
const MAX_PER_KIND = 2;

// --- Telefoonnummers -----------------------------------------------------------------------------
// Alleen wat een telefoonnummer kan zijn: Nederlandse nummers (06 en vast, ook als +31 of 0031) en
// andere nummers met een landcode. Lange cijferreeksen, datums en postcodes vallen af.

// Geeft { display, label } voor één stuk tekst, of null als het geen telefoonnummer is.
function parsePhone(piece) {
  const text = piece.trim();
  const digits = text.replace(/\D/g, '');
  const international = text.startsWith('+') || digits.startsWith('00');

  if (international) {
    const all = digits.startsWith('00') ? digits.slice(2) : digits;
    if (all.startsWith('31')) {
      let rest = all.slice(2);
      if (rest.startsWith('0')) rest = rest.slice(1); // +31 (0)6 ...
      if (rest.length !== 9 || !/^[1-7]/.test(rest)) return null;
      return dutch(rest);
    }
    if (all.length < 8 || all.length > 14 || all.startsWith('0')) return null;
    return { display: `+${DOT.repeat(2)} ${DOT.repeat(4)} ${all.slice(-4)}`, label: 'Telefoonnummer (buitenland)', phone: `+${all}` };
  }

  if (digits.length === 10 && /^0[1-7]/.test(digits)) return dutch(digits.slice(1));
  return null;
}

// `rest` zijn de 9 cijfers na de 0 of de landcode. `phone` is het hele nummer (+31...), alleen om te
// vergelijken met je eigen bevestigde nummer; het komt niet op de pagina.
function dutch(rest) {
  const last = rest.slice(-4);
  return rest.startsWith('6')
    ? { display: `+31 6 ${DOT.repeat(4)} ${last}`, label: 'Telefoonnummer (mobiel)', phone: `+31${rest}` }
    : { display: `+31 ${DOT.repeat(2)} ${DOT.repeat(4)} ${last}`, label: 'Telefoonnummer (vast)', phone: `+31${rest}` };
}

// Een rekeningnummer (IBAN) bestaat grotendeels uit cijfers en lijkt dan op een telefoonnummer:
// "NL91 ABNA 0417 1643 00" eindigt op tien cijfers. Die halen we weg voordat we naar nummers zoeken.
const IBAN = /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,3})?\b/g;

function phonesIn(text, ownPhone = null) {
  const found = [];
  // Reeksen cijfers met spaties, streepjes, punten en haakjes ertussen. Zo'n reeks kan meer zijn
  // dan één nummer (of een nummer met een jaartal ernaast), dus we zoeken per stuk, van lang naar kort.
  for (const candidate of text.replace(IBAN, ' ').match(/\+?\(?\d[\d\s().-]{6,}\d/g) ?? []) {
    const tokens = candidate.split(/\s+/);
    for (let start = 0; start < tokens.length; start += 1) {
      let hit = null;
      for (let end = tokens.length; end > start && !hit; end -= 1) {
        hit = parsePhone(tokens.slice(start, end).join(' '));
        if (hit) start = end - 1;
      }
      if (hit) found.push({ ...hit, yours: Boolean(ownPhone) && hit.phone === ownPhone });
    }
  }
  return found;
}

// --- E-mailadressen ------------------------------------------------------------------------------

function emailsIn(text, ownEmail) {
  const own = String(ownEmail ?? '').trim().toLowerCase();
  return (text.match(/[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g) ?? []).map((address) => {
    const [local, domain] = address.split('@');
    return {
      display: `${local[0]}${DOT.repeat(3)}@${domain}`.toLowerCase(),
      label: 'E-mailadres',
      yours: own !== '' && address.toLowerCase() === own,
    };
  });
}

// --- Postcodes -----------------------------------------------------------------------------------
// Nederlandse postcodes: vier cijfers en twee hoofdletters. De lettercombinaties SA, SD en SS
// bestaan niet. "2024 AD" is een jaartal, geen postcode.

function postcodesIn(text) {
  const found = [];
  for (const match of text.matchAll(/(?<![\p{L}\p{N}])([1-9]\d{3}) ?([A-Z]{2})(?![\p{L}\p{N}])/gu)) {
    const [, digits, letters] = match;
    if (['SA', 'SD', 'SS'].includes(letters)) continue;
    if (Number(digits) <= 2099 && ['AD', 'BC', 'CE'].includes(letters)) continue;
    found.push({ display: `${digits.slice(0, 2)}${DOT.repeat(2)} ${letters}`, label: 'Mogelijk een postcode' });
  }
  return found;
}

// Wat er in titel en fragment op persoonsgegevens lijkt: [{ kind, label, display, yours }].
// `ownEmail` is het bevestigde e-mailadres van het account: komt dat voor, dan zeggen we dat.
export function extractSignals({ title = '', snippet = '' } = {}, { ownEmail = null, ownPhone = null } = {}) {
  const text = `${title}\n${snippet}`;
  const groups = [
    ['phone', phonesIn(text, ownPhone)],
    ['email', emailsIn(text, ownEmail)],
    ['postcode', postcodesIn(text)],
  ];
  const result = [];
  for (const [kind, items] of groups) {
    const seen = new Set();
    for (const item of items) {
      // Twee nummers met dezelfde laatste cijfers zien er gemaskeerd hetzelfde uit; is één daarvan van jou,
      // dan zeggen we dat.
      if (seen.has(item.display)) {
        if (item.yours) {
          const earlier = result.find((signal) => signal.kind === kind && signal.display === item.display);
          if (earlier) earlier.yours = true;
        }
        continue;
      }
      if (seen.size >= MAX_PER_KIND) continue;
      seen.add(item.display);
      result.push({ kind, label: item.label, display: item.display, yours: Boolean(item.yours) });
    }
  }
  return result;
}

// --- Soort site ----------------------------------------------------------------------------------

const SOCIAL = [
  'facebook.com', 'instagram.com', 'linkedin.com', 'x.com', 'twitter.com', 'tiktok.com',
  'pinterest.com', 'reddit.com', 'snapchat.com', 'threads.net', 'tumblr.com', 'flickr.com',
  'youtube.com', 'strava.com',
];

// Bekende personenzoeksites en telefoongidsen. Dit is een korte, voorzichtige lijst en geen
// compleet overzicht: een site die er niet op staat, is niet "veilig". De naam van de soort blijft
// "mogelijk", want wij zien alleen het adres.
export const PEOPLE_SEARCH = [
  'spokeo.com', 'whitepages.com', 'beenverified.com', 'intelius.com', 'peoplefinders.com',
  'truepeoplesearch.com', 'fastpeoplesearch.com', 'radaris.com', 'mylife.com', 'pipl.com',
  'zabasearch.com', 'peekyou.com', 'thatsthem.com', 'nuwber.com', 'clustrmaps.com',
  'instantcheckmate.com', 'ussearch.com', 'peoplelooker.com',
  'telefoonboek.nl', 'detelefoongids.nl', '11880.com', 'dastelefonbuch.de', '192.com',
];

const DOCUMENT = /\.(pdf|docx?|xlsx?|pptx?|odt|ods|odp|rtf|csv|txt)$/i;

function onDomain(host, domains) {
  return domains.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

// Wat voor soort site is dit? { type: 'social' | 'document' | 'broker' | 'web', label }
export function classifyUrl(url) {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    return { type: 'web', label: 'Webpagina' };
  }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  if (onDomain(host, PEOPLE_SEARCH) || brokerForUrl(parsed.href)) return { type: 'broker', label: 'Mogelijke personenzoeksite of telefoongids' };
  if (onDomain(host, SOCIAL)) return { type: 'social', label: 'Sociale media' };
  const file = parsed.pathname.match(DOCUMENT);
  if (file) return { type: 'document', label: `Openbaar document (${file[1].toUpperCase()})` };
  return { type: 'web', label: 'Webpagina' };
}

// Alles wat de pagina over één webresultaat wil laten zien, naast de titel en het fragment.
export function describeWebResult(result, { ownEmail = null, ownPhone = null } = {}) {
  return {
    signals: extractSignals({ title: result.title, snippet: result.details?.snippet ?? result.snippet }, { ownEmail, ownPhone }),
    site: classifyUrl(result.url),
  };
}
