// Tests voor het bronnenregister ("PrivacyScan Intelligence"): wat is echt aan, en wat bestaat nog niet?
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CATEGORIES, PHASES, SOURCES, STATE_LABELS, describeRegister, evidenceSource,
} from '../src/sources.js';

const entry = (register, id) => register.find((item) => item.id === id);
const stateOf = (register, id) => entry(register, id).state;

test('evidenceSource kent de bronnen van datalekken en de zoekdiensten', () => {
  assert.equal(evidenceSource('hibp'), SOURCES.hibp);
  assert.equal(evidenceSource('xon'), SOURCES.xon);

  const demo = evidenceSource('demo');
  assert.equal(demo.id, 'demo');
  assert.match(demo.name, /nepdata/);
  assert.equal(demo.url, null); // de demo is geen echte bron om naar te linken

  const brave = evidenceSource('brave');
  assert.equal(brave.id, 'brave');
  assert.equal(brave.name, 'Brave Search');
  assert.equal(brave.url, 'https://search.brave.com'); // een echte bron: je kunt hem nalopen
});

test('evidenceSource verzint geen bron: een id die we niet kennen, blijft een tekst zonder link', () => {
  const onbekend = evidenceSource('google');
  assert.deepEqual(onbekend, { id: 'onbekend', name: 'google', url: null, credit: null });

  // Geen id (een bevinding uit de tijd voor deze functie), of rommel.
  for (const leeg of [null, undefined, '', 7, {}]) {
    const bron = evidenceSource(leeg);
    assert.equal(bron.name, 'Onbekende bron', String(leeg));
    assert.equal(bron.url, null);
  }
  // Namen van eigenschappen van een object zijn geen bron, en een lange tekst wordt afgekapt.
  assert.equal(evidenceSource('constructor').url, null);
  assert.equal(evidenceSource('__proto__').id, 'onbekend');
  assert.equal(evidenceSource('x'.repeat(500)).name.length, 40);
});

test('zonder instellingen staat alleen wat echt werkt op "actief"', () => {
  const register = describeRegister();
  assert.equal(stateOf(register, 'hibp'), 'testmodus'); // zonder sleutel: alleen de testadressen
  assert.equal(stateOf(register, 'xon'), 'uit');
  assert.equal(stateOf(register, 'pwned-passwords'), 'actief'); // werkt bij het maken van een account
  // Zonder zoekdienst zoeken we niet op het web: niet "actief", en ook niet "demo"
  assert.equal(stateOf(register, 'search'), 'niet-ingesteld');
  assert.match(entry(register, 'search').note, /niet op het web gezocht en er wordt niets verzonnen/);
  assert.match(entry(register, 'search').note, /BRAVE_API_KEY/);
  for (const id of ['databrokers', 'social', 'documenten', 'darkweb']) {
    assert.equal(stateOf(register, id), 'gepland', id);
  }
});

test('met een HIBP-sleutel is HIBP actief, met de gratis dienst is XposedOrNot actief', () => {
  const metSleutel = describeRegister({ emailSources: ['hibp'], hasKey: true });
  assert.equal(stateOf(metSleutel, 'hibp'), 'actief');
  assert.equal(stateOf(metSleutel, 'xon'), 'uit');

  // De gratis dienst: "hasKey" is dan waar, maar HIBP zelf heeft geen sleutel en is niet actief.
  const gratis = describeRegister({ emailSources: ['xon'], hasKey: true });
  assert.equal(stateOf(gratis, 'xon'), 'actief');
  assert.equal(stateOf(gratis, 'hibp'), 'testmodus');
  assert.match(entry(gratis, 'xon').note, /25 controles per uur/);
});

test('de zoekdienst is "niet ingesteld" zonder dienst, "demo" bij nepdata en pas "actief" bij een echte', () => {
  assert.equal(stateOf(describeRegister({ search: null }), 'search'), 'niet-ingesteld');
  assert.equal(stateOf(describeRegister({ search: { isDemo: true } }), 'search'), 'demo');
  assert.equal(stateOf(describeRegister({ search: { isDemo: false, name: 'echt' } }), 'search'), 'actief');
  assert.match(entry(describeRegister({ search: { isDemo: true } }), 'search').note, /verzonnen/);
});

test('bij een echte zoekdienst staat er waar de zoekopdracht heen gaat en hoe lang resultaten blijven', () => {
  const brave = { isDemo: false, name: 'brave', label: 'Brave Search', retainsResults: false };
  const note = entry(describeRegister({ search: brave }), 'search').note;
  assert.match(note, /Je naam en woonplaats gaan als zoekopdracht naar Brave Search/);
  assert.match(note, /hooguit 30 minuten/);
  assert.match(note, /alleen jouw keuzes blijven/);

  // Met opslagrechten mag het wel, en dat staat er dan ook.
  const metRechten = entry(describeRegister({ search: { ...brave, retainsResults: true } }), 'search').note;
  assert.match(metRechten, /bewaren we in je account/);
  assert.doesNotMatch(metRechten, /30 minuten/);
});

test('met een echte zoekdienst markeren we sociale media en documenten, maar zoeken we er nog niet apart', () => {
  const echt = describeRegister({ search: { isDemo: false, name: 'brave', label: 'Brave Search' } });
  for (const id of ['social', 'documenten']) {
    assert.equal(stateOf(echt, id), 'gepland', id);
    assert.match(entry(echt, id).note, /markeren we in de resultaten/);
    assert.match(entry(echt, id).note, /nog niet gebouwd/);
  }
  // Bij de demo of zonder zoekdienst is er niets om te markeren.
  for (const search of [null, { isDemo: true }]) {
    assert.doesNotMatch(entry(describeRegister({ search }), 'social').note, /markeren/);
  }
});

test('wat nog niet bestaat, wordt nooit "actief", wat er ook is ingesteld', () => {
  const alles = describeRegister({
    emailSources: ['hibp', 'xon'], hasKey: true, search: { isDemo: false, name: 'echt' },
  });
  for (const id of ['databrokers', 'social', 'documenten', 'darkweb']) {
    assert.equal(stateOf(alles, id), 'gepland', id);
    assert.ok(entry(alles, id).note, `${id}: er staat wat er nodig is`);
  }
  // Voor het darkweb staat er bovendien dat we het niet zelf doen.
  assert.match(entry(alles, 'darkweb').note, /geen eigen crawler/);
});

test('elk onderdeel van het register heeft een naam, een categorie, een uitleg en een stand in tekst', () => {
  const register = describeRegister({ emailSources: ['xon'], hasKey: true, search: { isDemo: true } });
  assert.deepEqual(register.map((item) => item.id), [
    'hibp', 'xon', 'pwned-passwords', 'search', 'databrokers', 'social', 'documenten', 'darkweb',
  ]);
  for (const item of register) {
    assert.ok(item.name && item.gives, item.id);
    assert.equal(item.categoryName, CATEGORIES[item.category], item.id);
    assert.equal(item.stateLabel, STATE_LABELS[item.state], item.id);
    assert.ok(Object.hasOwn(STATE_LABELS, item.state), item.id);
  }
});

test('de roadmap heeft zes fases, en alleen fase 1 en 2 staan op klaar', () => {
  assert.deepEqual(PHASES.map((phase) => phase.number), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(PHASES.filter((phase) => phase.done).map((phase) => phase.number), [1, 2]);
  assert.deepEqual(PHASES.map((phase) => phase.name), [
    'Veilig fundament', 'Breach Intelligence Engine', 'Data Broker Engine',
    'Deep Research Engine', 'Eigen AI-agent', 'Continuous Monitoring',
  ]);
  for (const phase of PHASES) assert.ok(phase.short && phase.text, phase.name);
});

test('de roadmap belooft nergens iets te verwijderen', () => {
  for (const phase of PHASES) {
    assert.doesNotMatch(`${phase.name} ${phase.text}`, /verwijder/i, phase.name);
  }
  for (const item of describeRegister()) {
    assert.doesNotMatch(`${item.gives} ${item.note ?? ''}`, /verwijder/i, item.id);
  }
});
