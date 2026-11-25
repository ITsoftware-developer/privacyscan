// Tests voor de privacyverklaring: die moet kloppen met wat de app echt doet,
// ook als dat per instelling verschilt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ANNA, fakeHibp, fakeSearch, registerConfirmed, send, startServer } from './helpers.js';

// De zichtbare tekst van een pagina: zonder tags, met enkele spaties en zonder
// spatie voor leestekens (die ontstaat doordat een tag door een spatie wordt vervangen).
const READABLE = (html) => html
  .replace(/<[^>]+>/g, ' ')
  .replace(/\s+/g, ' ')
  .replace(/\s+([.,;:)])/g, '$1');

async function privacyText(t, options = {}) {
  const { base } = await startServer(t, { hibp: fakeHibp(), ...options });
  const response = await send(base, '/privacy');
  assert.equal(response.status, 200);
  return READABLE(await response.text());
}

test('de privacyverklaring noemt alles wat fase 2 bewaart en verstuurt', async (t) => {
  const text = await privacyText(t, { search: fakeSearch({ isDemo: true }) });

  for (const onderwerp of [
    /Of je e-mailadres bevestigd is/,
    /hash van die code/,
    /30 minuten geldig/,
    /Je woonplaats/,
    /Wat de zoekopdrachten vinden/,
    /Dit ben ik niet/,
    /Tellers met gehashte gegevens/,
    /sturen we je e-mailadres naar Have I Been Pwned/,
    /bevestigingsmail gebruiken we een e-maildienst/,
    /Waarop we zoeken/,
    /Er is geen zoekvak waarin je een andere naam/,
    /je keuzes en het rapport van je laatste Deep Scan: zolang je account bestaat/,
    /Bij elke bevinding bewaren we uit welke bron hij komt, wanneer we hem onderzochten/,
    /Bevestigingslinks: 30 minuten/,
  ]) {
    assert.match(text, onderwerp);
  }
  assert.doesNotMatch(text, /Zoeken op naam staat op deze site uit/);
});

test('de privacyverklaring is eerlijk over de demo-zoekdienst: er gaat niets naar buiten', async (t) => {
  const text = await privacyText(t, { search: fakeSearch({ isDemo: true }) });
  assert.match(text, /demo met verzonnen resultaten\. Daarbij gaat er niets naar buiten/);
  assert.doesNotMatch(text, /sturen we je naam/);
});

test('met een echte zoekdienst noemt de privacyverklaring die en zegt wat er naartoe gaat', async (t) => {
  const text = await privacyText(t, { search: fakeSearch({ isDemo: false, name: 'Zoekmachine X' }) });
  assert.match(text, /sturen we je naam \(en je woonplaats, als je die hebt ingevuld\) naar de zoekdienst Zoekmachine X/);
  assert.doesNotMatch(text, /demo met verzonnen resultaten/);
});

test('op een openbare site zegt de privacyverklaring dat zoeken op naam uit staat', async (t) => {
  const text = await privacyText(t, { production: true, search: fakeSearch({ isDemo: false }) });
  assert.match(text, /Zoeken op naam staat op deze site uit/);
  assert.match(text, /Je naam gaat niet naar een zoekdienst/);
  assert.doesNotMatch(text, /sturen we je naam/);
  // We vragen dan ook niet om een woonplaats, dus de verklaring noemt die niet.
  assert.doesNotMatch(text, /Je woonplaats/);
  assert.doesNotMatch(text, /Zoekgegevens/);
});

test('de geldigheid van de link in de privacyverklaring komt uit dezelfde instelling als de mail', async (t) => {
  const { CONFIRM_MINUTES } = await import('../src/confirm.js');
  const text = await privacyText(t);
  assert.match(text, new RegExp(`De link is ${CONFIRM_MINUTES} minuten geldig`));
});

test('op een openbare site bestaat de pagina met je woonplaats niet', async (t) => {
  const search = fakeSearch({ results: [] });
  const { db, base, mailer } = await startServer(t, { hibp: fakeHibp(), search, production: true });
  const cookie = await registerConfirmed(base, mailer);

  assert.equal((await send(base, '/profiel', { cookie })).status, 404);
  const post = await send(base, '/profiel', { method: 'POST', cookie, fields: { woonplaats: 'Utrecht' } });
  assert.equal(post.status, 404);
  assert.equal(db.prepare('SELECT city FROM users').get().city, null); // er is niets bewaard

  const dashboard = await (await send(base, '/dashboard', { cookie })).text();
  assert.doesNotMatch(dashboard, /href="\/profiel"/);
});

test('op je eigen computer staat de woonplaats-pagina er wel, en de privacyverklaring noemt hem', async (t) => {
  const { base, mailer } = await startServer(t, { hibp: fakeHibp(), search: fakeSearch() });
  const cookie = await registerConfirmed(base, mailer, ANNA);

  assert.equal((await send(base, '/profiel', { cookie })).status, 200);
  const text = READABLE(await (await send(base, '/privacy')).text());
  assert.match(text, /op de pagina "Zoekgegevens"/);
});

test('de privacyverklaring beschrijft de openbare e-mailcontrole en zegt dat het adres niet bewaard wordt', async (t) => {
  const text = await privacyText(t);

  for (const onderwerp of [
    /Op de startpagina kan iedereen een e-mailadres controleren, ook zonder account/,
    /Het adres dat je intypt, bewaren we niet/,
    /Gevoelige datalekken, zoals die van datingsites, laten we nooit zien/,
    /Als je op de startpagina een e-mailadres controleert, sturen we ook dat adres naar Have I Been Pwned/,
    /Het e-mailadres dat je op de startpagina controleert: we bewaren het niet, ook niet in een logboek/,
    /zoekopdrachten en controles van e-mailadressen/,
    /controles van e-mailadressen: maximaal een uur/,
    /Er is geen zoekvak waarin je een andere naam kunt invullen/,
  ]) {
    assert.match(text, onderwerp);
  }
  // Dat je geen ander e-mailadres kunt invullen, klopt niet meer.
  assert.doesNotMatch(text, /een andere naam of een ander e-mailadres/);
});

test('de openbare controle staat ook in de privacyverklaring van een openbare site', async (t) => {
  const text = await privacyText(t, { production: true, search: fakeSearch({ isDemo: false }) });
  assert.match(text, /Op de startpagina kan iedereen een e-mailadres controleren/);
  assert.match(text, /Het adres dat je intypt, bewaren we niet/);
});
