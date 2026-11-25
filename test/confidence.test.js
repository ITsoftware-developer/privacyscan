// Tests voor de beoordeling van een bevinding: hoe goed past hij bij jou?
// Een datalek is een letterlijke overeenkomst met je bevestigde adres. Een webresultaat is altijd
// een MOGELIJKE overeenkomst: pas als jij het bevestigt, is het van jou.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BREACH_CONFIDENCE, CONFIDENCE_LABELS, DECISION_LABELS, DEMO_CONFIDENCE, MATCH_LABELS,
  confidenceLabel, decisionLabel, rateWebResult,
} from '../src/confidence.js';

const ANNA = { name: 'Anna de Vries', city: 'Utrecht' };
const rate = (title, snippet = '', who = ANNA) => rateWebResult({ ...who, title, snippet });

test('je volledige naam én je woonplaats geven "gemiddeld": een naamgenoot kan dat ook zijn', () => {
  const result = rate('Anna de Vries', 'Fotograaf in Utrecht.');
  assert.equal(result.level, 'gemiddeld');
  assert.match(result.note, /volledige naam én je woonplaats/);
  assert.match(result.note, /naamgenoot/);
  assert.match(result.note, /pas als jij het bevestigt/);
});

test('een naam, ook met woonplaats, is nooit genoeg voor "hoog"', () => {
  for (const [title, snippet] of [['Anna de Vries Utrecht', 'Anna de Vries uit Utrecht, Utrecht'], ['Anna de Vries', 'Utrecht']]) {
    assert.notEqual(rate(title, snippet).level, 'hoog');
  }
});

test('alleen je volledige naam geeft "laag", en de uitleg zegt wat er ontbreekt', () => {
  const metWoonplaats = rate('Anna de Vries wint de clubprijs', 'Uitslag uit Groningen.');
  assert.equal(metWoonplaats.level, 'laag');
  assert.match(metWoonplaats.note, /woonplaats niet/);

  // Zonder ingestelde woonplaats kan het nooit hoger dan "laag".
  const zonderWoonplaats = rate('Anna de Vries', 'Fotograaf in Utrecht.', { name: ANNA.name, city: null });
  assert.equal(zonderWoonplaats.level, 'laag');
  assert.match(zonderWoonplaats.note, /Zonder woonplaats/);
});

test('is de naam er niet, dan is er geen overeenkomst; alleen in losse stukken is "laag"', () => {
  const afwezig = rate('Vacatures in Utrecht', 'Wij zoeken een fotograaf.');
  assert.equal(afwezig.level, 'geen');
  assert.match(afwezig.note, /staat niet in de titel/);
  assert.match(afwezig.note, /pagina zelf lezen we niet/); // misschien staat je naam daar wel

  // Alle delen staan erin, maar niet achter elkaar: dat kan een heel andere persoon zijn.
  const losse = rate('Vries, Anna de', 'Utrecht');
  assert.equal(losse.level, 'laag');
  assert.match(losse.note, /Alle delen van je naam/);
});

test('je bevestigde e-mailadres in de tekst is "hoog": dat is het enige wat we van jou bevestigd hebben', () => {
  const result = rateWebResult({
    name: 'Anna de Vries', city: 'Utrecht', email: 'anna@example.com',
    title: 'Contact', snippet: 'Mail naar Anna@Example.com voor info.',
  });
  assert.equal(result.level, 'hoog');
  assert.match(result.note, /e-mailadres/);
  assert.match(result.note, /geen bewijs/);

  // Ook zonder dat je naam erin staat: het adres zegt genoeg.
  assert.equal(rateWebResult({ name: 'Anna', email: 'anna@example.com', title: 'x', snippet: 'anna@example.com' }).level, 'hoog');
});

test('het e-mailadres moet er als geheel adres staan, niet als deel van een ander', () => {
  const rateMail = (snippet, email = 'anna@example.com') => rateWebResult({ name: 'Anna de Vries', email, title: 'x', snippet }).level;
  assert.equal(rateMail('hanna@example.com'), 'geen');       // ander adres
  assert.equal(rateMail('anna@example.com.nl'), 'geen');     // ander domein
  assert.equal(rateMail('a.nna@example.com'), 'geen');
  assert.equal(rateMail('(anna@example.com), tot ziens.'), 'hoog'); // leestekens eromheen mogen
  for (const leeg of [null, undefined, '', '   ', 'geen-adres', '@', 'a@']) {
    const level = rateWebResult({ name: 'Anna de Vries', email: leeg, title: 'x', snippet: 'anna@example.com' }).level;
    assert.notEqual(level, 'hoog', String(leeg));
  }
});

test('hele woorden tellen: een deel van een ander woord is geen overeenkomst', () => {
  // "Utrecht" zit in "Utrechtseweg", maar dat is geen woonplaats.
  assert.equal(rate('Anna de Vries', 'Woont aan de Utrechtseweg').level, 'laag');
  // "Jan Bos" zit in "Jan Bosman", maar dat is een andere naam.
  assert.equal(rate('Jan Bosman', '', { name: 'Jan Bos', city: null }).level, 'geen');
});

test('hoofdletters, accenten en leestekens maken niet uit', () => {
  const jose = { name: 'José van Dijk', city: 'Zwolle' };
  assert.equal(rate('JOSE VAN-DIJK', 'bij Zwolle', jose).level, 'gemiddeld');
  assert.equal(rate('Jose  van Dijk!', '', jose).level, 'laag');
  assert.equal(rate('José, van Dijk (Zwólle)', '', jose).level, 'gemiddeld');
});

test('een lege of ontbrekende naam gooit niets en geeft nooit een hoge beoordeling', () => {
  for (const who of [{ name: '' }, { name: null }, { name: undefined }, { name: '   ', city: 'Utrecht' }]) {
    const result = rateWebResult({ ...who, title: 'Anna de Vries', snippet: 'Utrecht' });
    assert.equal(result.level, 'geen', JSON.stringify(who));
  }
  assert.equal(rateWebResult({ name: 'Anna de Vries' }).level, 'geen'); // geen titel en geen fragment
});

test('een naam van één woord werkt ook', () => {
  assert.equal(rate('Madonna op tournee', '', { name: 'Madonna', city: null }).level, 'laag');
  assert.equal(rate('Een zangeres', '', { name: 'Madonna', city: null }).level, 'geen');
});

test('de beoordeling hangt alleen van titel en fragment af, en elke beoordeling heeft een uitleg', () => {
  const samples = [
    rate('Anna de Vries', 'Utrecht'), rate('Anna de Vries', ''), rate('Iets anders', ''), rate('Vries Anna de', ''),
    rateWebResult({ name: 'Anna', email: 'anna@example.com', title: 'anna@example.com' }),
  ];
  for (const sample of samples) {
    assert.ok(['hoog', 'gemiddeld', 'laag', 'geen'].includes(sample.level));
    assert.ok(sample.note.length > 20, 'elke beoordeling legt uit waarom');
    assert.ok(Object.hasOwn(MATCH_LABELS, sample.level));
    assert.ok(Object.hasOwn(CONFIDENCE_LABELS, sample.level));
  }
});

test('confidenceLabel: de namen kennen we, al het andere is "Niet beoordeeld"', () => {
  // Een datalek
  assert.equal(confidenceLabel('hoog'), 'Hoog');
  assert.equal(confidenceLabel('gemiddeld'), 'Gemiddeld');
  assert.equal(confidenceLabel('laag'), 'Laag');
  assert.equal(confidenceLabel('demo'), 'Demo (verzonnen)');
  // Een webresultaat is een overeenkomst, geen zekerheid
  assert.equal(confidenceLabel('hoog', 'web'), 'Sterke overeenkomst');
  assert.equal(confidenceLabel('gemiddeld', 'web'), 'Mogelijke overeenkomst');
  assert.equal(confidenceLabel('laag', 'web'), 'Zwakke overeenkomst');
  assert.equal(confidenceLabel('geen', 'web'), 'Geen overeenkomst in titel of fragment');
  assert.equal(confidenceLabel('demo', 'web'), 'Demo (verzonnen)');
  // Oude bevindingen hebben geen beoordeling, en uit een kapotte database kan van alles komen,
  // ook namen die toevallig op een eigenschap van een object lijken.
  for (const vreemd of [null, undefined, '', 'onzin', 'constructor', '__proto__', 'toString', 'hasOwnProperty', 42, {}, []]) {
    assert.equal(confidenceLabel(vreemd), 'Niet beoordeeld', String(vreemd));
    assert.equal(confidenceLabel(vreemd, 'web'), 'Niet beoordeeld', String(vreemd));
  }
});

test('decisionLabel: jouw oordeel staat apart van onze beoordeling', () => {
  assert.equal(decisionLabel('new'), 'Nog niet beoordeeld');
  assert.match(decisionLabel('mine'), /Door jou bevestigd/);
  assert.match(decisionLabel('not_mine'), /Door jou afgewezen/);
  assert.match(decisionLabel('unknown'), /weet het/);
  for (const vreemd of [null, undefined, '', 'onzin', 'constructor', '__proto__', 42]) {
    assert.equal(decisionLabel(vreemd), DECISION_LABELS.new, String(vreemd));
  }
});

test('een datalek is "hoog", de demo is "demo" en zegt dat alles verzonnen is', () => {
  assert.equal(BREACH_CONFIDENCE.level, 'hoog');
  assert.match(BREACH_CONFIDENCE.note, /letterlijke overeenkomst/);
  assert.equal(DEMO_CONFIDENCE.level, 'demo');
  assert.match(DEMO_CONFIDENCE.note, /verzonnen/);
  for (const level of [BREACH_CONFIDENCE.level, DEMO_CONFIDENCE.level]) {
    assert.ok(Object.hasOwn(CONFIDENCE_LABELS, level));
    assert.ok(Object.hasOwn(MATCH_LABELS, level));
  }
});
