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
  // Databrokers, sociale media en documenten gaan via de zoekdienst: zonder zoekdienst gebeurt er niets.
  for (const id of ['databrokers', 'social', 'documenten']) {
    assert.equal(stateOf(register, id), 'niet-ingesteld', id);
  }
  assert.equal(stateOf(register, 'darkweb'), 'gepland');
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

test('met een echte zoekdienst zoeken we apart bij databrokers, op sociale media en naar documenten', () => {
  const echt = describeRegister({ search: { isDemo: false, name: 'brave', label: 'Brave Search' } });
  for (const id of ['databrokers', 'social', 'documenten']) {
    assert.equal(stateOf(echt, id), 'actief', id);
    assert.match(entry(echt, id).note, /In de Deep Scan/, id);
  }
  assert.match(entry(echt, 'databrokers').note, /bij 14 bekende databrokers en telefoongidsen/);
  assert.match(entry(echt, 'databrokers').note, /We openen hun sites niet/);
  // Bij de demo wordt er niet echt gezocht, en dat staat er.
  for (const id of ['databrokers', 'social', 'documenten']) {
    assert.equal(stateOf(describeRegister({ search: { isDemo: true } }), id), 'demo', id);
  }
});

test('wat nog niet bestaat, wordt nooit "actief", wat er ook is ingesteld', () => {
  const alles = describeRegister({
    emailSources: ['hibp', 'xon'], hasKey: true, search: { isDemo: false, name: 'echt' },
  });
  assert.equal(stateOf(alles, 'darkweb'), 'gepland');
  assert.ok(entry(alles, 'darkweb').note, 'er staat wat er nodig is');
  // Voor het darkweb staat er bovendien dat we het niet zelf doen.
  assert.match(entry(alles, 'darkweb').note, /geen eigen crawler/);
});

test('elk onderdeel van het register heeft een naam, een categorie, een uitleg en een stand in tekst', () => {
  const register = describeRegister({ emailSources: ['xon'], hasKey: true, search: { isDemo: true } });
  assert.deepEqual(register.map((item) => item.id), [
    'hibp', 'xon', 'pwned-passwords', 'search', 'databrokers', 'social', 'documenten', 'telefoon', 'email-web', 'darkweb',
  ]);
  for (const item of register) {
    assert.ok(item.name && item.gives, item.id);
    assert.equal(item.categoryName, CATEGORIES[item.category], item.id);
    assert.equal(item.stateLabel, STATE_LABELS[item.state], item.id);
    assert.ok(Object.hasOwn(STATE_LABELS, item.state), item.id);
  }
});

test('de roadmap heeft zes fases, en fase 1, 2 en 3 staan op klaar', () => {
  assert.deepEqual(PHASES.map((phase) => phase.number), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(PHASES.filter((phase) => phase.done).map((phase) => phase.number), [1, 2, 3]);
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

test('je telefoonnummer staat in het register als niet ingesteld zolang er geen sms-dienst is', () => {
  const search = { isDemo: false, name: 'echt' };
  const without = describeRegister({ search, sms: false });
  assert.equal(stateOf(without, 'telefoon'), 'niet-ingesteld');
  assert.match(entry(without, 'telefoon').note, /geen sms-dienst/);
  const withSms = describeRegister({ search, sms: true });
  assert.equal(stateOf(withSms, 'telefoon'), 'actief');
  assert.match(entry(withSms, 'telefoon').note, /alleen als je het met een sms-code hebt bevestigd/);
  // Zonder zoekdienst helpt een sms-dienst niets.
  assert.equal(stateOf(describeRegister({ search: null, sms: true }), 'telefoon'), 'niet-ingesteld');
  assert.equal(stateOf(describeRegister({ search, sms: true }), 'email-web'), 'actief');
  assert.match(entry(describeRegister({ search }), 'email-web').note, /alleen als je dat zelf aanzet/);
});
