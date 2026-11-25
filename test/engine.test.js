// Tests voor de onderdelen van de Deep Scan: de stappen, de blootstelling en de controle
// van het bewijs. De regel die telkens terugkomt: wat niet gedaan is, heet nooit "voltooid".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STATUSES, STEP_DEFS, STEP_TITLES, describeStep, exposureFrom, exposureNote, publicPlan, publicRun,
  verifyFindings, verifyNote, withEvidence,
} from '../src/engine.js';
import { SOURCES } from '../src/sources.js';

const XON = SOURCES.xon;
const statusOf = (steps, id) => steps.find((step) => step.id === id).status;
const noteOf = (steps, id) => steps.find((step) => step.id === id).note;

// Een datalek zoals de pagina's het krijgen, met of zonder bewijs.
const breach = (title, dataClasses, extra = {}) => ({
  name: title, title, dataClasses, url: `https://example.com/${title.toLowerCase()}`, ...extra,
});

test('de vijf stappen heten zoals in het plan, in die volgorde', () => {
  assert.deepEqual(STEP_DEFS.map((step) => step.title), [
    'Datalekdatabases onderzoeken',
    'Databrokers controleren',
    'Openbare internetbronnen onderzoeken',
    'Blootstelling van persoonsgegevens controleren',
    'Bevindingen verifiëren',
  ]);
  assert.deepEqual(STEP_DEFS.map((step) => step.id), ['datalekken', 'databrokers', 'web', 'blootstelling', 'verificatie']);
  assert.equal(STEP_TITLES.databrokers, 'Databrokers controleren');
});

// --- describeStep -------------------------------------------------------------------------

test('describeStep geeft de titel, de kleur, de status als tekst en de toelichting', () => {
  const view = describeStep({ id: 'datalekken', status: 'done', note: '3 datalekken gevonden.' });
  assert.deepEqual(view, {
    title: 'Datalekdatabases onderzoeken', tone: 'ok', label: 'Voltooid', note: '3 datalekken gevonden.',
  });

  assert.equal(describeStep({ id: 'databrokers', status: 'planned' }).label, 'Nog niet gebouwd');
  assert.equal(describeStep({ id: 'web', status: 'unreachable' }).label, 'Niet toegankelijk');
  assert.equal(describeStep({ id: 'web', status: 'unavailable' }).label, 'Niet beschikbaar');
  assert.equal(describeStep({ id: 'web', status: 'skipped' }).label, 'Overgeslagen');
  assert.equal(describeStep({ id: 'web', status: 'failed' }).label, 'Mislukt');
  assert.equal(describeStep({ id: 'web', status: 'failed' }).note, ''); // geen toelichting: leeg, niet "undefined"
});

test('een stap uit de demo heet "Voltooid (demo)", zodat nepdata nooit voor echt doorgaat', () => {
  assert.equal(describeStep({ id: 'web', status: 'done', demo: true }).label, 'Voltooid (demo)');
  assert.equal(describeStep({ id: 'web', status: 'done', demo: false }).label, 'Voltooid');
  // Alleen "voltooid" krijgt dat achtervoegsel.
  assert.equal(describeStep({ id: 'web', status: 'skipped', demo: true }).label, 'Overgeslagen');
});

test('een status die we niet kennen, tonen we als "Onbekend" en nooit als voltooid', () => {
  // Zoiets kan uit een kapotte of handmatig aangepaste database komen, ook als naam van een eigenschap.
  for (const status of ['klaar', 'DONE', '', null, undefined, 7, 'constructor', '__proto__', 'toString']) {
    const view = describeStep({ id: 'web', status });
    assert.equal(view.label, 'Onbekend', String(status));
    assert.equal(view.tone, 'idle', String(status));
  }
  // Ook een stap die er helemaal niet is, gooit niets.
  for (const leeg of [undefined, null, {}]) {
    assert.equal(describeStep(leeg).label, 'Onbekend');
    assert.equal(describeStep(leeg).title, '');
  }
});

test('alleen een stap die echt gelopen is, heet "Voltooid"', () => {
  const voltooid = Object.entries(STATUSES).filter(([, { label }]) => label === 'Voltooid');
  assert.deepEqual(voltooid.map(([status]) => status), ['done']);
  for (const [status, { tone, label }] of Object.entries(STATUSES)) {
    assert.ok(['ok', 'bad', 'warn', 'idle'].includes(tone), status);
    assert.ok(label.length > 0, status);
  }
  // Wat niet bestaat of niet lukte, is nooit groen.
  for (const status of ['planned', 'unreachable', 'failed', 'skipped', 'unavailable', 'after', 'account']) {
    assert.notEqual(STATUSES[status].tone, 'ok', status);
  }
});

test('de titel komt uit het id en de toelichting wordt altijd tekst', () => {
  assert.equal(describeStep({ id: 'blootstelling', status: 'done' }).title, 'Blootstelling van persoonsgegevens controleren');
  assert.equal(describeStep({ title: 'Eigen titel', status: 'done' }).title, 'Eigen titel');
  assert.equal(describeStep({ id: 'web', status: 'done', note: 12 }).note, '12');
});

// --- Blootstelling ------------------------------------------------------------------------

test('exposureFrom zegt welke soorten gegevens er gelekt zijn en bij welke lekken', () => {
  const exposure = exposureFrom([
    breach('Adobe', ['Email addresses', 'Password hints', 'Passwords', 'Usernames']),
    breach('Telco', ['Email addresses', 'Phone numbers', 'Physical addresses', 'Names', 'Dates of birth']),
    breach('Forum', ['Email addresses', 'Passwords', 'IP addresses']),
  ]);
  assert.deepEqual(exposure.map((group) => [group.id, group.breaches]), [
    ['inloggegevens', ['Adobe', 'Forum']],
    ['telefoon', ['Telco']],
    ['adres', ['Telco']],
    ['identiteit', ['Telco']],
    ['online', ['Forum']],
  ]);
  // Elke groep heeft een naam en een advies in gewone taal.
  for (const group of exposure) {
    assert.deepEqual(Object.keys(group).sort(), ['advice', 'breaches', 'id', 'label']);
    assert.ok(group.label && group.advice);
  }
});

test('het e-mailadres zelf is geen groep: dat is waarmee we zoeken', () => {
  assert.deepEqual(exposureFrom([breach('Adobe', ['Email addresses'])]), []);
});

test('exposureFrom let niet op hoofdletters of spaties, en telt een lek maar één keer', () => {
  const exposure = exposureFrom([
    breach('Adobe', ['  PASSWORDS ', 'Passwords', 'usernames']),
    breach('Adobe', ['Passwords']),
  ]);
  assert.deepEqual(exposure.map((group) => group.breaches), [['Adobe']]);
});

test('wat we niet herkennen, wordt geen groep, en rommel gooit niets', () => {
  assert.deepEqual(exposureFrom([breach('Rare site', ['Favourite colours', 'Shoe sizes'])]), []);
  for (const dataClasses of [undefined, null, 'Passwords', 7, {}, [null, undefined, {}, 5]]) {
    assert.deepEqual(exposureFrom([{ title: 'X', dataClasses }]), [], String(dataClasses));
  }
  assert.deepEqual(exposureFrom([]), []);
});

test('exposureNote is één zin, en zegt eerlijk dat er niets te beoordelen valt als er geen lek is', () => {
  assert.equal(exposureNote([], 0), 'Er is geen datalek gevonden, dus er is niets om te beoordelen.');
  assert.match(exposureNote([], 2), /herkennen we geen inloggegevens/);

  const exposure = exposureFrom([
    breach('Adobe', ['Passwords']), breach('Forum', ['Passwords', 'Phone numbers']),
  ]);
  assert.equal(exposureNote(exposure, 2), 'Inloggegevens in 2 lekken, telefoonnummers in 1 lek.');
});

// --- Het bewijs controleren ---------------------------------------------------------------

const COMPLETE = { source_id: 'xon', checked_at: 1000, confidence: 'hoog', url: 'https://example.com/a' };

test('verifyFindings telt wat er bij een bevinding ontbreekt', () => {
  assert.deepEqual(verifyFindings([]), {
    checked: 0, withoutSource: 0, withoutDate: 0, unrated: 0, withoutLink: 0,
  });
  assert.deepEqual(verifyFindings([COMPLETE, COMPLETE]), {
    checked: 2, withoutSource: 0, withoutDate: 0, unrated: 0, withoutLink: 0,
  });
  assert.deepEqual(verifyFindings([
    COMPLETE,
    { ...COMPLETE, source_id: null },
    { ...COMPLETE, checked_at: null, confidence: null },
    { ...COMPLETE, url: null },
    {},
  ]), {
    checked: 5, withoutSource: 2, withoutDate: 2, unrated: 2, withoutLink: 2,
  });
});

test('verifyNote vertelt wat er gecontroleerd is, en noemt elk gebrek', () => {
  assert.equal(verifyNote(verifyFindings([])), 'Er zijn geen bevindingen om te controleren.');
  assert.equal(
    verifyNote(verifyFindings([COMPLETE])),
    '1 bevinding gecontroleerd op bron, datum en zekerheid: elk heeft een bron, een datum en een zekerheid.',
  );
  assert.equal(
    verifyNote(verifyFindings([COMPLETE, COMPLETE, COMPLETE])),
    '3 bevindingen gecontroleerd op bron, datum en zekerheid: elk heeft een bron, een datum en een zekerheid.',
  );

  const note = verifyNote(verifyFindings([
    { ...COMPLETE, source_id: null }, { ...COMPLETE, confidence: null }, { ...COMPLETE, url: null }, {},
  ]));
  assert.match(note, /^4 bevindingen gecontroleerd op bron, datum en zekerheid\. Let op: /);
  assert.match(note, /2 zonder bron/);
  assert.match(note, /1 zonder datum/);
  assert.match(note, /2 zonder beoordeling van de zekerheid/);
  assert.match(note, /2 zonder directe link/);
  assert.doesNotMatch(note, /elk heeft een bron/); // met een gebrek mag dat er niet staan
});

// --- De startpagina -----------------------------------------------------------------------

test('voordat er iets gedaan is, staat er wat er te doen is, en niets is voltooid', () => {
  const plan = publicPlan();
  assert.deepEqual(plan.map((step) => step.id), STEP_DEFS.map((step) => step.id));
  assert.deepEqual(plan.map((step) => step.title), STEP_DEFS.map((step) => step.title));
  assert.deepEqual(plan.map((step) => step.status), ['available', 'planned', 'account', 'after', 'after']);
  for (const step of plan) assert.notEqual(describeStep(step).label, 'Voltooid');
});

test('zonder eigen sleutel staat de datalekstap als testmodus, en de tekst verwijst naar de melding', () => {
  const plan = publicPlan({ testMode: true });
  assert.equal(statusOf(plan, 'datalekken'), 'testmode');
  assert.match(noteOf(plan, 'datalekken'), /testadressen/);
  assert.equal(describeStep(plan[0]).label, 'Testmodus');
  assert.equal(statusOf(publicPlan({ testMode: false }), 'datalekken'), 'available');
});

test('na een controle is alleen gedaan wat echt gedaan is', () => {
  const source = XON;
  const breaches = withEvidence([
    breach('Adobe', ['Passwords']), breach('Telco', ['Phone numbers']),
  ], { source, now: 5000 });
  const steps = publicRun({ breaches, source });

  assert.deepEqual(steps.map((step) => step.status), ['done', 'planned', 'skipped', 'done', 'done']);
  assert.equal(noteOf(steps, 'datalekken'), '2 datalekken gevonden bij XposedOrNot.');
  // Databrokers bestaan nog niet en het web kan alleen in je eigen account: nooit voltooid.
  assert.equal(describeStep(steps[1]).label, 'Nog niet gebouwd');
  assert.equal(describeStep(steps[2]).label, 'Overgeslagen');
  assert.match(noteOf(steps, 'web'), /alleen in je eigen account/);
  assert.match(noteOf(steps, 'blootstelling'), /Inloggegevens in 1 lek, telefoonnummers in 1 lek/);
  assert.match(noteOf(steps, 'verificatie'), /elk heeft een bron, een datum en een zekerheid/);
});

test('bij één lek staat er "1 datalek", en geen lek geeft goed nieuws zonder iets te "verifiëren"', () => {
  const een = publicRun({ breaches: withEvidence([breach('Adobe', ['Passwords'])], { source: XON }), source: XON });
  assert.equal(noteOf(een, 'datalekken'), '1 datalek gevonden bij XposedOrNot.');

  const geen = publicRun({ breaches: [], source: XON });
  assert.equal(noteOf(geen, 'datalekken'), 'Geen datalek gevonden bij XposedOrNot.');
  assert.equal(statusOf(geen, 'datalekken'), 'done');
  assert.equal(statusOf(geen, 'blootstelling'), 'done');
  assert.equal(statusOf(geen, 'verificatie'), 'skipped'); // er was niets om te controleren
  assert.equal(noteOf(geen, 'verificatie'), 'Er zijn geen bevindingen om te controleren.');
});

test('stap 5 kijkt naar wat er echt is: een lek zonder bewijs of zonder link valt op', () => {
  // Zonder bewijs (niet door withEvidence gehaald) zegt de controle eerlijk dat het ontbreekt.
  const kaal = publicRun({ breaches: [breach('Adobe', ['Passwords'])], source: XON });
  assert.match(noteOf(kaal, 'verificatie'), /zonder bron/);
  assert.match(noteOf(kaal, 'verificatie'), /zonder datum/);
  assert.match(noteOf(kaal, 'verificatie'), /zonder beoordeling van de zekerheid/);
  assert.doesNotMatch(noteOf(kaal, 'verificatie'), /elk heeft een bron/);

  // Met bewijs maar zonder link (zoals LinkedIn bij XposedOrNot): dat noemt hij ook.
  const zonderLink = publicRun({
    breaches: withEvidence([breach('Adobe', ['Passwords']), breach('LinkedIn', ['Passwords'], { url: null })], { source: XON }),
    source: XON,
  });
  assert.match(noteOf(zonderLink, 'verificatie'), /Let op: 1 zonder directe link\./);
});

test('withEvidence geeft elk lek een bron, een datum en een zekerheid, zonder het origineel te veranderen', () => {
  const origineel = [breach('Adobe', ['Passwords'])];
  const met = withEvidence(origineel, { source: XON, now: 1234 });

  assert.equal(met.length, 1);
  assert.equal(met[0].source_id, 'xon');
  assert.equal(met[0].checked_at, 1234);
  assert.equal(met[0].confidence, 'hoog');
  assert.match(met[0].confidence_note, /letterlijke overeenkomst/);
  assert.equal(met[0].title, 'Adobe'); // de rest blijft
  assert.deepEqual(met[0].dataClasses, ['Passwords']);
  assert.equal(origineel[0].source_id, undefined); // het origineel is ongemoeid
  assert.ok(withEvidence([breach('X', [])], { source: XON })[0].checked_at > 0); // zonder "now": nu
  assert.deepEqual(withEvidence([], { source: XON }), []);
});
