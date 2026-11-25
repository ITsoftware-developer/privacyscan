// Tests voor het opbouwen van de zoekopdracht, het opschonen van resultaten en de demo-zoekdienst.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildQuery, cleanName, cleanResults, createDemoSearch, createSearch, parseCity,
} from '../src/search.js';

// Een zoekopdracht bestaat uit hooguit twee stukken tekst tussen aanhalingstekens.
// Wat erin staat is gewoon tekst; er staat niets buiten dat een zoekdienst als
// operator (OR, -, site:) zou kunnen lezen.
const ONLY_QUOTED_PHRASES = /^"[^"]+"( "[^"]+")?$/;

test('cleanName houdt letters, spaties, apostrofs, punten en streepjes over', () => {
  assert.equal(cleanName('Anna de Vries'), 'Anna de Vries');
  assert.equal(cleanName("Jan van 't Hoff"), "Jan van 't Hoff");
  assert.equal(cleanName('Zoë Müller-Łukasz'), 'Zoë Müller-Łukasz');
  assert.equal(cleanName('  Anna \t\n de   Vries  '), 'Anna de Vries');
  assert.equal(cleanName('St. Anna'), 'St. Anna');
});

test('cleanName haalt aanhalingstekens, zoekoperatoren en vreemde tekens weg', () => {
  assert.equal(cleanName('Anna "de" Vries'), 'Anna de Vries');
  assert.equal(cleanName('Anna -Vries'), 'Anna Vries'); // geen "sluit dit woord uit"
  assert.equal(cleanName('-Anna --Vries'), 'Anna Vries');
  assert.equal(cleanName('Anna site:evil.example (de)'), 'Anna site evil.example de');
  assert.equal(cleanName('Anna 😀 Vries'), 'Anna Vries');
  assert.equal(cleanName('<b>Anna</b>'), 'b Anna b');
});

test('cleanName kapt af op de maximale lengte en kan tegen lege invoer', () => {
  assert.equal(cleanName('a'.repeat(200)).length, 80);
  assert.equal(cleanName('a'.repeat(200), 10), 'a'.repeat(10));
  assert.equal(cleanName(null), '');
  assert.equal(cleanName(undefined), '');
  assert.equal(cleanName(42), '');
});

test('buildQuery zet naam en woonplaats tussen aanhalingstekens', () => {
  assert.equal(buildQuery({ name: 'Anna de Vries', city: 'Utrecht' }), '"Anna de Vries" "Utrecht"');
  assert.equal(buildQuery({ name: 'Anna de Vries', city: null }), '"Anna de Vries"');
  assert.equal(buildQuery({ name: 'Anna de Vries', city: '' }), '"Anna de Vries"');
  assert.equal(buildQuery({ name: 'Anna de Vries' }), '"Anna de Vries"');
});

test('buildQuery: een naam of woonplaats kan geen zoekoperator of tweede zoekterm worden', () => {
  const evil = [
    { name: 'Anna de Vries', city: 'OR Jan Jansen' },
    { name: 'Anna de Vries', city: 'Ut" OR "Jan Jansen' },
    { name: 'Anna de Vries', city: '-Utrecht' },
    { name: 'Anna de Vries', city: 'Utrecht site:evil.example' },
    { name: 'Anna" OR "Jan Jansen', city: 'Utrecht' },
    { name: '"Anna de Vries" -Vries filetype:pdf', city: null },
  ];
  for (const input of evil) {
    const query = buildQuery(input);
    assert.match(query, ONLY_QUOTED_PHRASES, JSON.stringify(input));
  }
  // Wat er van een "woonplaats" als OR Jan Jansen overblijft, is één zin die ook op de pagina moet staan.
  assert.equal(buildQuery({ name: 'Anna de Vries', city: 'OR Jan Jansen' }), '"Anna de Vries" "OR Jan Jansen"');
});

test('buildQuery geeft niets terug als er te weinig letters in de naam zitten', () => {
  for (const name of ['', ' ', 'A', '1234', '--', '"', '😀😀', null, undefined]) {
    assert.equal(buildQuery({ name, city: 'Utrecht' }), null, String(name));
  }
  assert.equal(buildQuery({ name: 'Li', city: null }), '"Li"');
});

test('parseCity: geldige woonplaatsen, leeg en ongeldig', () => {
  assert.deepEqual(parseCity('  Utrecht '), { city: 'Utrecht' });
  assert.deepEqual(parseCity('Bergen   op Zoom'), { city: 'Bergen op Zoom' });
  assert.deepEqual(parseCity("'s-Hertogenbosch"), { city: "'s-Hertogenbosch" });
  assert.deepEqual(parseCity(''), { city: null });
  assert.deepEqual(parseCity(undefined), { city: null });
  for (const bad of ['Utrecht 3584', '<b>x</b>', '"Utrecht"', '-Utrecht', 'a/b', 'x'.repeat(61)]) {
    assert.match(parseCity(bad).error, /alleen letters/, bad);
  }
});

test('cleanResults haalt tags weg, ontsmet adressen en laat dubbelen vallen', () => {
  const results = cleanResults([
    { title: '<b>Hoi</b> &amp; dag', url: 'https://example.org/a', snippet: '<i>tekst</i> met <script>x</script>' },
    { title: 'dubbel', url: 'https://example.org/a', snippet: 'nog een keer' },
    { title: 'js', url: 'javascript:alert(1)' },
    { title: 'data', url: 'data:text/html,<script>alert(1)</script>' },
    { title: 'ftp', url: 'ftp://example.org/bestand' },
    { title: 'wachtwoord', url: 'https://gebruiker:geheim@example.org/' },
    { title: 'geen adres', url: 'dit is geen adres' },
    { title: 'zonder adres' },
    { url: 42 },
    null,
    'tekst',
    { title: '', url: 'http://example.org/zonder-titel', snippet: undefined },
  ]);

  assert.deepEqual(results, [
    { title: 'Hoi & dag', url: 'https://example.org/a', snippet: 'tekst met x' },
    { title: 'http://example.org/zonder-titel', url: 'http://example.org/zonder-titel', snippet: '' },
  ]);
});

test('cleanResults behandelt hetzelfde adres in verschillende schrijfwijzen als één', () => {
  const results = cleanResults([
    { title: 'een', url: 'https://EXAMPLE.org' },
    { title: 'twee', url: 'https://example.org/' },
  ]);
  assert.equal(results.length, 1);
  assert.equal(results[0].url, 'https://example.org/');
});

test('cleanResults kapt titels, teksten en adressen af en houdt hooguit max resultaten over', () => {
  const [long] = cleanResults([{ title: 't'.repeat(500), url: 'https://example.org/', snippet: 's'.repeat(2000) }]);
  assert.ok(long.title.length <= 200);
  assert.ok(long.snippet.length <= 400);

  assert.deepEqual(cleanResults([{ title: 'x', url: `https://example.org/${'a'.repeat(2100)}` }]), []);

  const many = Array.from({ length: 30 }, (_, i) => ({ title: `t${i}`, url: `https://example.org/${i}` }));
  assert.equal(cleanResults(many).length, 20);
  assert.equal(cleanResults(many, 5).length, 5);
  assert.equal(cleanResults(many)[0].title, 't0'); // de volgorde van de zoekdienst blijft
});

test('cleanResults tegen iets wat geen lijst is', () => {
  for (const value of [undefined, null, 'tekst', 42, {}, { length: 3 }]) {
    assert.deepEqual(cleanResults(value), []);
  }
});

test('de demo-zoekdienst verzint vijf resultaten op voorbeelddomeinen en stuurt niets naar buiten', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('de demo mag het netwerk niet gebruiken');
  });
  const demo = createDemoSearch();
  const results = await demo.search({ query: '"Anna de Vries" "Utrecht"', name: 'Anna de Vries', city: 'Utrecht' });

  assert.equal(demo.isDemo, true);
  assert.equal(results.length, 5);
  assert.ok(results.every((r) => r.title.includes('Anna de Vries') || r.title.includes('Anna')));
  assert.ok(results.some((r) => r.title.includes('Utrecht')), 'de woonplaats komt in een resultaat terug');
  for (const { url } of results) {
    assert.match(new URL(url).hostname, /^example\.(org|net|com)$/, url);
  }
  assert.equal(fetchMock.mock.callCount(), 0);

  // Wat de demo teruggeeft, komt ongeschonden door cleanResults.
  assert.equal(cleanResults(results).length, 5);
});

test('de demo-zoekdienst werkt ook zonder woonplaats', async () => {
  const results = await createDemoSearch().search({ query: '"Bram Bakker"', name: 'Bram Bakker', city: '' });
  assert.equal(results.length, 5);
  assert.ok(results.every((r) => !r.title.includes(' in ')));
});

test('createSearch kent alleen "demo" en weigert de rest met een duidelijke fout', () => {
  assert.equal(createSearch().isDemo, true);
  assert.equal(createSearch('demo').name, 'demo');
  assert.throws(() => createSearch('google'), /Onbekende zoekdienst "google"/);
  assert.throws(() => createSearch(''), /Onbekende zoekdienst/);
});
