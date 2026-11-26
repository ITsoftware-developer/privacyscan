// Tests voor het herkennen van persoonsgegevens in webresultaten en het soort site.
// Alles wat we tonen is gemaskeerd, en alles is maar "wat het lijkt": een naamgenoot heeft ook een nummer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyUrl, describeWebResult, extractSignals } from '../src/extract.js';

const DOT = '•';
const signals = (snippet, options) => extractSignals({ snippet }, options);
const displays = (snippet, options) => signals(snippet, options).map((signal) => signal.display);

// --- Telefoonnummers ----------------------------------------------------------------------

test('een mobiel nummer wordt gemaskeerd: alleen het begin en de laatste vier cijfers blijven over', () => {
  const found = signals('Bel Anna op 06 12 34 56 78 voor meer informatie.');
  assert.equal(found.length, 1);
  assert.deepEqual(found[0], {
    kind: 'phone',
    label: 'Telefoonnummer (mobiel)',
    display: `+31 6 ${DOT.repeat(4)} 5678`,
    yours: false,
  });
});

test('hetzelfde mobiele nummer in alle schrijfwijzen geeft dezelfde weergave', () => {
  const expected = [`+31 6 ${DOT.repeat(4)} 5678`];
  for (const text of [
    '06 12 34 56 78', '06-12345678', '0612345678', '06 1234 5678',
    '+31 6 1234 5678', '+31612345678', '+31 (0)6 12345678', '0031 6 12345678', '(06) 12 34 56 78',
  ]) {
    assert.deepEqual(displays(`Nummer: ${text}.`), expected, text);
  }
});

test('een vast nummer krijgt een eigen soort en laat het netnummer niet zien', () => {
  for (const text of ['010 123 4567', '020-1234567', '(020) 123 45 67', '+31 20 123 4567']) {
    const found = signals(`Tel: ${text}`);
    assert.equal(found.length, 1, text);
    assert.equal(found[0].label, 'Telefoonnummer (vast)', text);
    assert.equal(found[0].display, `+31 ${DOT.repeat(2)} ${DOT.repeat(4)} 4567`, text);
  }
});

test('een buitenlands nummer laat alleen de laatste vier cijfers zien', () => {
  assert.deepEqual(displays('Call +44 20 7946 0958'), [`+${DOT.repeat(2)} ${DOT.repeat(4)} 0958`]);
  assert.deepEqual(displays('Call +1 (555) 123-4567'), [`+${DOT.repeat(2)} ${DOT.repeat(4)} 4567`]);
  assert.equal(signals('Call +44 20 7946 0958')[0].label, 'Telefoonnummer (buitenland)');
});

test('het gemaskeerde nummer bevat niet meer dan de laatste vier cijfers', () => {
  const found = signals('Mobiel 06 12 34 56 78, vast 020 123 45 67 en +44 20 7946 0958');
  assert.deepEqual(found.map((item) => item.display), [
    `+31 6 ${DOT.repeat(4)} 5678`,
    `+31 ${DOT.repeat(2)} ${DOT.repeat(4)} 4567`,
  ]); // het derde nummer past niet meer: we tonen er maximaal twee
  for (const item of found) {
    const cijfers = item.display.replace(/\D/g, '');
    assert.ok(cijfers.length <= 7, `${item.display} laat te veel cijfers zien`); // 31, 6 en vier cijfers
  }
  const buitenland = signals('Call +44 20 7946 0958')[0].display.replace(/\D/g, '');
  assert.equal(buitenland, '0958');
});

test('wat op een nummer lijkt maar er geen is, wordt niet als nummer getoond', () => {
  for (const text of [
    'Datum 12-03-2024 en 31.12.2023',
    'KvK 12345678 en BTW NL123456789B01',
    '0900-8844 en 0800 0234 en 0900 1234567',
    'De jaren 2019 2020 2021 2022 2023',
    'Versie 1.2.3.4.5.6.7.8.9.10',
    'Artikelnummer 1234567890',
    'Het totaal is 1.234.567,89 euro',
    'Rekeningnummer NL91 ABNA 0417 1643 00',
    'Zie pagina 12 tot 14 van 2024',
  ]) {
    assert.deepEqual(displays(text), [], text);
  }
});

test('meer dan twee nummers in één resultaat: we tonen er twee, en geen dubbelen', () => {
  const found = displays('06 12 34 56 78 en 06 12 34 56 78 en 06 12 34 56 79 en 06 12 34 56 80');
  assert.deepEqual(found, [`+31 6 ${DOT.repeat(4)} 5678`, `+31 6 ${DOT.repeat(4)} 5679`]);
});

// --- E-mailadressen -----------------------------------------------------------------------

test('een e-mailadres laat alleen de eerste letter en het domein zien', () => {
  const [found] = signals('Mail Anna: anna.devries@example.com graag.');
  assert.deepEqual(found, {
    kind: 'email', label: 'E-mailadres', display: `a${DOT.repeat(3)}@example.com`, yours: false,
  });
  assert.ok(!found.display.includes('devries'));
});

test('hoofdletters in een e-mailadres geven geen dubbele of verschillende weergave', () => {
  assert.deepEqual(displays('Anna.DeVries@Mail.Example.NL'), [`a${DOT.repeat(3)}@mail.example.nl`]);
  assert.deepEqual(displays('a@example.com en A@EXAMPLE.COM').length, 1);
});

test('het e-mailadres van je account wordt als het jouwe herkend, een ander adres niet', () => {
  const own = { ownEmail: 'Anna@Example.com' };
  assert.equal(signals('Mail anna@example.com', own)[0].yours, true);
  assert.equal(signals('Mail ANNA@EXAMPLE.COM', own)[0].yours, true);
  // Een ander adres dat het jouwe bevat, is niet het jouwe.
  assert.equal(signals('Mail hanna@example.com', own)[0].yours, false);
  assert.equal(signals('Mail anna@example.com.nl', own)[0].yours, false);
  // Zonder bekend adres is niets "het jouwe".
  assert.equal(signals('Mail anna@example.com')[0].yours, false);
  assert.equal(signals('Mail anna@example.com', { ownEmail: '' })[0].yours, false);
  assert.equal(signals('Mail anna@example.com', { ownEmail: null })[0].yours, false);
});

test('je bevestigde telefoonnummer wordt als het jouwe herkend, in elke schrijfwijze; een ander nummer niet', () => {
  const own = { ownPhone: '+31612345678' };
  for (const text of ['Bel 06-12345678', 'Tel. +31 6 12345678', '+31 (0)6 12 34 56 78', '0031 6 1234 5678']) {
    const [signal] = signals(text, own);
    assert.equal(signal.kind, 'phone', text);
    assert.equal(signal.yours, true, text);
  }
  assert.equal(signals('Bel 06-87655678', own)[0].yours, false); // dezelfde laatste cijfers, een ander nummer
  assert.equal(signals('Bel 06-12345678')[0].yours, false);
  assert.equal(signals('Bel 06-12345678', { ownPhone: null })[0].yours, false);
  // Twee nummers die er gemaskeerd hetzelfde uitzien: is één van jou, dan staat dat erbij.
  const both = signals('Bel 06-87655678 of 06-12345678', own);
  assert.equal(both.length, 1);
  assert.equal(both[0].yours, true);
  // Het volledige nummer komt nooit in wat de pagina krijgt.
  assert.doesNotMatch(JSON.stringify(signals('Bel 06-12345678', own)), /12345678|\+31612345678/);
});

// --- Postcodes ----------------------------------------------------------------------------

test('een postcode laat alleen de eerste twee cijfers en de letters zien, en heet "mogelijk"', () => {
  const found = signals('Kantoor in 3512 AB Utrecht en 1012AB Amsterdam');
  assert.deepEqual(found.map((item) => item.display), [`35${DOT.repeat(2)} AB`, `10${DOT.repeat(2)} AB`]);
  assert.ok(found.every((item) => item.kind === 'postcode' && /^Mogelijk/.test(item.label)));
});

test('jaartallen en onmogelijke postcodes tellen niet als postcode', () => {
  for (const text of ['In 2024 AD', 'rond 1999 BC', 'postcode 3500 SS', 'postcode 3500 SA', 'postcode 3500 SD',
    'code 0123 AB', 'de 12345 AB', 'X3512 ABC']) {
    assert.deepEqual(displays(text), [], text);
  }
});

// --- Alles samen --------------------------------------------------------------------------

test('titel en fragment worden allebei bekeken, en elke soort staat apart', () => {
  const found = extractSignals({
    title: 'Anna de Vries - 06 12 34 56 78',
    snippet: 'Mail anna@example.com, 3512 AB Utrecht.',
  });
  assert.deepEqual(found.map((item) => item.kind), ['phone', 'email', 'postcode']);
});

test('zonder titel, zonder fragment of zonder argumenten geeft het niets en crasht het niet', () => {
  assert.deepEqual(extractSignals(), []);
  assert.deepEqual(extractSignals({}), []);
  assert.deepEqual(extractSignals({ title: null, snippet: undefined }), []);
  assert.deepEqual(extractSignals({ title: 'Alleen een titel' }), []);
});

test('de gemaskeerde weergave bevat nooit het oorspronkelijke nummer, adres of de volledige postcode', () => {
  const text = 'Anna de Vries, 06 12 34 56 78, anna.devries@example.com, 3512 AB Utrecht';
  const dump = JSON.stringify(extractSignals({ snippet: text }));
  for (const geheim of ['06 12 34 56 78', '0612345678', '12 34 56', 'devries', 'anna.devries', '3512', '12 34']) {
    assert.ok(!dump.includes(geheim), `"${geheim}" staat nog in de weergave`);
  }
});

// --- Soort site ---------------------------------------------------------------------------

test('classifyUrl herkent sociale media, ook met www of een landsubdomein', () => {
  for (const url of [
    'https://www.facebook.com/anna', 'https://nl.linkedin.com/in/anna', 'https://x.com/anna',
    'https://twitter.com/anna', 'https://www.instagram.com/anna/',
  ]) {
    assert.deepEqual(classifyUrl(url), { type: 'social', label: 'Sociale media' }, url);
  }
});

test('classifyUrl laat zich niet foppen door een adres dat er alleen op lijkt', () => {
  for (const url of [
    'https://notfacebook.com/x', 'https://evilfacebook.com/', 'https://facebook.com.evil.example/x',
    'https://max.com/a', 'https://example.org/linkedin.com/in/anna', 'https://example.org/?u=facebook.com',
  ]) {
    assert.equal(classifyUrl(url).type, 'web', url);
  }
});

test('classifyUrl herkent bekende personenzoeksites en telefoongidsen als "mogelijk"', () => {
  for (const url of ['https://www.spokeo.com/Anna-de-Vries', 'https://telefoonboek.nl/x', 'https://www.11880.com/a']) {
    assert.deepEqual(classifyUrl(url), { type: 'broker', label: 'Mogelijke personenzoeksite of telefoongids' }, url);
  }
});

test('classifyUrl herkent openbare documenten aan de bestandsnaam, ook met hoofdletters of een query', () => {
  assert.deepEqual(classifyUrl('https://example.org/a/verslag.pdf'), { type: 'document', label: 'Openbaar document (PDF)' });
  assert.equal(classifyUrl('https://example.org/a/verslag.PDF').label, 'Openbaar document (PDF)');
  assert.equal(classifyUrl('https://example.org/a/verslag.pdf?x=1').type, 'document');
  assert.equal(classifyUrl('https://example.org/a/ledenlijst.xlsx').label, 'Openbaar document (XLSX)');
  assert.equal(classifyUrl('https://example.org/a/brief.docx').label, 'Openbaar document (DOCX)');
  // Een pdf in de query of een pagina over pdf's is geen document.
  assert.equal(classifyUrl('https://example.org/a?bestand=verslag.pdf').type, 'web');
  assert.equal(classifyUrl('https://example.org/pdf/index.html').type, 'web');
});

test('een gewone pagina of een kapot adres is gewoon een webpagina', () => {
  assert.deepEqual(classifyUrl('https://example.org/index.html'), { type: 'web', label: 'Webpagina' });
  for (const kapot of ['geen adres', '', null, undefined]) {
    assert.deepEqual(classifyUrl(kapot), { type: 'web', label: 'Webpagina' });
  }
});

test('een personenzoeksite wint van sociale media en documenten: hij wordt het voorzichtigst behandeld', () => {
  assert.equal(classifyUrl('https://www.spokeo.com/a/verslag.pdf').type, 'broker');
});

// --- describeWebResult --------------------------------------------------------------------

test('describeWebResult leest het fragment uit een bewaard resultaat en uit een vers resultaat', () => {
  const bewaard = describeWebResult({
    title: 'Anna de Vries', url: 'https://www.facebook.com/anna', details: { snippet: 'Tel 06 12 34 56 78' },
  });
  assert.equal(bewaard.site.type, 'social');
  assert.deepEqual(bewaard.signals.map((item) => item.kind), ['phone']);

  const vers = describeWebResult({ title: 'T', url: 'https://example.org/', snippet: 'Mail anna@example.com' });
  assert.equal(vers.site.type, 'web');
  assert.deepEqual(vers.signals.map((item) => item.kind), ['email']);
});

test('describeWebResult geeft het account-adres door, zodat "jouw adres" herkend wordt', () => {
  const result = { title: 'T', url: 'https://example.org/', details: { snippet: 'Mail anna@example.com' } };
  assert.equal(describeWebResult(result, { ownEmail: 'anna@example.com' }).signals[0].yours, true);
  assert.equal(describeWebResult(result).signals[0].yours, false);
});

test('describeWebResult werkt ook zonder details of zonder fragment', () => {
  assert.deepEqual(describeWebResult({ title: 'T', url: 'https://example.org/' }).signals, []);
  assert.deepEqual(describeWebResult({ title: 'T', url: 'https://example.org/', details: {} }).signals, []);
});
