// Telefoonnummers: netjes maken, tonen, en de varianten waarin een nummer op een webpagina kan staan.
//
// Een nummer onderzoeken we alleen als je het met een sms-code hebt bevestigd (zie routes-profile.js):
// een bevestigd e-mailadres bewijst niet dat een telefoonnummer van dezelfde persoon is.

// Maakt van wat iemand intypt een nummer in internationale vorm (+31612345678), of geeft een
// foutmelding. Zonder landcode gaan we uit van Nederland: 06 12 34 56 78 wordt +31612345678.
export function normalizePhone(input) {
  const raw = String(input ?? '').trim();
  if (raw === '') return { phone: null, error: 'Vul een telefoonnummer in.' };
  if (raw.length > 30 || /[^\d\s+().\-/]/.test(raw)) {
    return { phone: null, error: 'Een telefoonnummer bestaat uit cijfers, eventueel met + aan het begin.' };
  }
  let digits = raw.replace(/[^\d+]/g, '');
  if (digits.indexOf('+') > 0 || (digits.match(/\+/g) ?? []).length > 1) {
    return { phone: null, error: 'Een + mag alleen aan het begin staan.' };
  }
  if (digits.startsWith('00')) digits = `+${digits.slice(2)}`;
  else if (digits.startsWith('0')) digits = `+31${digits.slice(1)}`;
  else if (!digits.startsWith('+')) return { phone: null, error: 'Begin met 0 (Nederland) of met + en de landcode.' };

  if (!/^\+[1-9]\d{6,14}$/.test(digits)) {
    return { phone: null, error: 'Dit is geen geldig telefoonnummer.' };
  }
  // Een Nederlands nummer heeft na +31 precies 9 cijfers.
  if (digits.startsWith('+31') && digits.length !== 12) {
    return { phone: null, error: 'Een Nederlands nummer heeft 10 cijfers, zoals 06 12345678.' };
  }
  return { phone: digits, error: null };
}

const isDutch = (phone) => phone.startsWith('+31');

// Zoals mensen het zelf schrijven: 06 12345678, of +44 7700 900123.
export function formatPhone(phone) {
  if (!phone) return '';
  if (isDutch(phone)) {
    const national = `0${phone.slice(3)}`;
    return national.startsWith('06') ? `06 ${national.slice(2)}` : `${national.slice(0, 3)} ${national.slice(3)}`;
  }
  return phone;
}

// De schrijfwijzen waarin het nummer op een pagina kan staan, voor de zoekopdracht. Hooguit vier, met
// aanhalingstekens, zodat de zoekdienst ze letterlijk zoekt.
export function phoneVariants(phone) {
  if (isDutch(phone)) {
    const rest = phone.slice(3); // 612345678
    const national = `0${rest}`;
    return [national, `${national.slice(0, 2)}-${national.slice(2)}`, `${national.slice(0, 2)} ${national.slice(2)}`, phone];
  }
  return [phone, `${phone.slice(0, 3)} ${phone.slice(3)}`];
}

// Staat dit nummer in deze tekst, in welke schrijfwijze ook? We vergelijken alleen cijfers, en een
// treffer moet het hele nummer zijn: 06123456789 bevat 0612345678, maar is een ander nummer. De
// schrijfwijze +31 (0)6 12345678 telt ook: die (0) hoort er niet bij als je vanuit het buitenland belt.
export function containsPhone(text, phone) {
  if (!phone) return false;
  const national = isDutch(phone) ? `0${phone.slice(3)}` : null;
  const international = phone.slice(1);
  for (const run of String(text ?? '').match(/\+?\d[\d\s().\-/]{5,}\d/g) ?? []) {
    let digits = run.replace(/\(0\)/g, '').replace(/\D/g, '');
    if (run.trim().startsWith('+')) digits = `+${digits}`;
    else if (digits.startsWith('00')) digits = `+${digits.slice(2)}`;
    if (digits === phone || digits === `+${international}`) return true;
    if (national && digits === national) return true;
    if (digits === international) return true;
  }
  return false;
}
