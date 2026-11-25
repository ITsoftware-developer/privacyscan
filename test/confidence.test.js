// Tests voor de zekerheid van een bevinding: hoe zeker is het dat hij over jou gaat?
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BREACH_CONFIDENCE, CONFIDENCE_LABELS, DEMO_CONFIDENCE, confidenceLabel, rateWebResult,
} from '../src/confidence.js';

const ANNA = { name: 'Anna de Vries', city: 'Utrecht' };
const rate = (title, snippet = '', who = ANNA) => rateWebResult({ ...who, title, snippet });

test('je volledige naam én je woonplaats geven "hoog", met de uitleg dat een naamgenoot kan', () => {
  const result = rate('Anna de Vries', 'Fotograaf in Utrecht.');
  assert.equal(result.level, 'hoog');
  assert.match(result.note, /volledige naam én je woonplaats/);
  assert.match(result.note, /naamgenoot/); // ook "hoog" is geen bewijs
});

test('alleen je volledige naam geeft "gemiddeld", en de uitleg zegt wat er ontbreekt', () => {
  const metWoonplaats = rate('Anna de Vries wint de clubprijs', 'Uitslag uit Groningen.');
  assert.equal(metWoonplaats.level, 'gemiddeld');
  assert.match(metWoonplaats.note, /woonplaats niet/);

  // Zonder ingestelde woonplaats kan het nooit hoger dan "gemiddeld".
  const zonderWoonplaats = rate('Anna de Vries', 'Fotograaf in Utrecht.', { name: ANNA.name, city: null });
  assert.equal(zonderWoonplaats.level, 'gemiddeld');
  assert.match(zonderWoonplaats.note, /Zonder woonplaats/);
});

test('is de naam er niet, of alleen in losse stukken, dan is de zekerheid "laag"', () => {
  const afwezig = rate('Vacatures in Utrecht', 'Wij zoeken een fotograaf.');
  assert.equal(afwezig.level, 'laag');
  assert.match(afwezig.note, /staat niet in de titel/);

  // Alle delen staan erin, maar niet achter elkaar: dat kan een heel andere persoon zijn.
  const losse = rate('Vries, Anna de', 'Utrecht');
  assert.equal(losse.level, 'laag');
  assert.match(losse.note, /Alle delen van je naam/);
});

test('hele woorden tellen: een deel van een ander woord is geen overeenkomst', () => {
  // "Utrecht" zit in "Utrechtseweg", maar dat is geen woonplaats.
  assert.equal(rate('Anna de Vries', 'Woont aan de Utrechtseweg').level, 'gemiddeld');
  // "Jan Bos" zit in "Jan Bosman", maar dat is een andere naam.
  assert.equal(rate('Jan Bosman', '', { name: 'Jan Bos', city: null }).level, 'laag');
});

test('hoofdletters, accenten en leestekens maken niet uit', () => {
  const jose = { name: 'José van Dijk', city: 'Zwolle' };
  assert.equal(rate('JOSE VAN-DIJK', 'bij Zwolle', jose).level, 'hoog');
  assert.equal(rate('Jose  van Dijk!', '', jose).level, 'gemiddeld');
  assert.equal(rate('José, van Dijk (Zwólle)', '', jose).level, 'hoog');
});

test('een lege of ontbrekende naam gooit niets en geeft nooit een hoge zekerheid', () => {
  for (const who of [{ name: '' }, { name: null }, { name: undefined }, { name: '   ', city: 'Utrecht' }]) {
    const result = rateWebResult({ ...who, title: 'Anna de Vries', snippet: 'Utrecht' });
    assert.equal(result.level, 'laag', JSON.stringify(who));
  }
  assert.equal(rateWebResult({ name: 'Anna de Vries' }).level, 'laag'); // geen titel en geen fragment
});

test('een naam van één woord werkt ook', () => {
  assert.equal(rate('Madonna op tournee', '', { name: 'Madonna', city: null }).level, 'gemiddeld');
  assert.equal(rate('Een zangeres', '', { name: 'Madonna', city: null }).level, 'laag');
});

test('de zekerheid hangt alleen van titel en fragment af, en elke beoordeling heeft een uitleg', () => {
  const samples = [
    rate('Anna de Vries', 'Utrecht'), rate('Anna de Vries', ''), rate('Iets anders', ''), rate('Vries Anna de', ''),
  ];
  for (const sample of samples) {
    assert.ok(['hoog', 'gemiddeld', 'laag'].includes(sample.level));
    assert.ok(sample.note.length > 20, 'elke beoordeling legt uit waarom');
    assert.ok(Object.hasOwn(CONFIDENCE_LABELS, sample.level));
  }
});

test('confidenceLabel: de namen kennen we, al het andere is "Niet beoordeeld"', () => {
  assert.equal(confidenceLabel('hoog'), 'Hoog');
  assert.equal(confidenceLabel('gemiddeld'), 'Gemiddeld');
  assert.equal(confidenceLabel('laag'), 'Laag');
  assert.equal(confidenceLabel('demo'), 'Demo (verzonnen)');
  // Oude bevindingen hebben geen zekerheid, en uit een kapotte database kan van alles komen,
  // ook namen die toevallig op een eigenschap van een object lijken.
  for (const vreemd of [null, undefined, '', 'onzin', 'constructor', '__proto__', 'toString', 'hasOwnProperty', 42, {}, []]) {
    assert.equal(confidenceLabel(vreemd), 'Niet beoordeeld', String(vreemd));
  }
});

test('een datalek is "hoog", de demo is "demo" en zegt dat alles verzonnen is', () => {
  assert.equal(BREACH_CONFIDENCE.level, 'hoog');
  assert.match(BREACH_CONFIDENCE.note, /letterlijke overeenkomst/);
  assert.equal(DEMO_CONFIDENCE.level, 'demo');
  assert.match(DEMO_CONFIDENCE.note, /verzonnen/);
  for (const level of [BREACH_CONFIDENCE.level, DEMO_CONFIDENCE.level]) {
    assert.ok(Object.hasOwn(CONFIDENCE_LABELS, level));
  }
});
