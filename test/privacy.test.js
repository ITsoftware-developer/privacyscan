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
  assert.match(text, /sturen we je naam \(en je woonplaats, als je die hebt ingevuld\) als zoekopdracht naar de zoekdienst Zoekmachine X/);
  assert.doesNotMatch(text, /demo met verzonnen resultaten/);
  // Deze dienst staat bewaren toe, dus er hoeft geen bewaartermijn van 30 minuten bij.
  assert.doesNotMatch(text, /bewaren we maar \d+ minuten/);
  assert.doesNotMatch(text, /niet toestaat dat we ze bewaren/);
});

test('een zoekdienst die bewaren verbiedt: de privacyverklaring noemt de korte bewaartermijn en de hash', async (t) => {
  const { WEB_RESULT_MINUTES } = await import('../src/retention.js');
  const text = await privacyText(t, {
    search: fakeSearch({ isDemo: false, name: 'Zoekmachine X', retainsResults: false }),
  });
  assert.match(text, new RegExp(`De webresultaten zelf bewaren we maar ${WEB_RESULT_MINUTES} minuten`));
  assert.match(text, /omdat Zoekmachine X niet toestaat dat we ze bewaren/);
  assert.match(text, /alleen de keuze zelf bewaard, samen met een vingerafdruk \(hash\) van het adres/);
  assert.match(text, /een code, niet het adres, de titel of de tekst zelf/);
  // De naam gaat nog steeds als zoekopdracht naar die dienst.
  assert.match(text, /als zoekopdracht naar de zoekdienst Zoekmachine X/);
});

test('bij de demo-zoekdienst staat er geen bewaartermijn: de demo bewaart eigen, verzonnen resultaten', async (t) => {
  const text = await privacyText(t, { search: fakeSearch({ isDemo: true, retainsResults: false }) });
  assert.doesNotMatch(text, /niet toestaat dat we ze bewaren/);
});

test('zonder zoekdienst zegt de privacyverklaring dat er niet op het web gezocht wordt', async (t) => {
  const text = await privacyText(t, { search: null });
  assert.match(text, /Er is geen zoekdienst ingesteld\. Je naam gaat daarom niet naar een zoekdienst/);
  assert.match(text, /er wordt niet op het web gezocht/);
  assert.doesNotMatch(text, /demo met verzonnen resultaten/);
  assert.doesNotMatch(text, /sturen we je naam/);
  assert.doesNotMatch(text, /niet toestaat dat we ze bewaren/);
});

test('op een openbare site zonder zoekdienst blijft de privacyverklaring ook kloppen', async (t) => {
  const text = await privacyText(t, { production: true, search: null });
  assert.match(text, /Zoeken op naam staat op deze site uit/);
  assert.match(text, /Er is geen zoekdienst ingesteld\. Je naam gaat daarom niet naar een zoekdienst/);
  assert.doesNotMatch(text, /sturen we je naam/);
  assert.doesNotMatch(text, /demo met verzonnen resultaten/);
});

test('op een openbare site zegt de privacyverklaring dat zoeken op naam uit staat', async (t) => {
  const text = await privacyText(t, { production: true, search: fakeSearch({ isDemo: false }) });
  assert.match(text, /Zoeken op naam staat op deze site uit/);
  assert.match(text, /Je naam gaat niet naar een zoekdienst/);
  assert.doesNotMatch(text, /sturen we je naam/);
  // We vragen dan ook niet om een woonplaats, dus de verklaring noemt die niet.
  assert.doesNotMatch(text, /Je woonplaats/);
  assert.doesNotMatch(text, /wijzig je je woonplaats/);
  // En zonder sms-dienst ook niet om een telefoonnummer.
  assert.doesNotMatch(text, /Je telefoonnummer/);
  assert.doesNotMatch(text, /sms/);
  // Zoeken op je e-mailadres kan wel, als je het zelf aanzet.
  assert.match(text, /Of we ook op het web naar je e-mailadres mogen zoeken/);
  assert.match(text, /Heb je zoeken op je e-mailadres aangezet, dan sturen we ook je e-mailadres als zoekopdracht/);
});

test('de geldigheid van de link in de privacyverklaring komt uit dezelfde instelling als de mail', async (t) => {
  const { CONFIRM_MINUTES } = await import('../src/confirm.js');
  const text = await privacyText(t);
  assert.match(text, new RegExp(`De link is ${CONFIRM_MINUTES} minuten geldig`));
});

test('op een openbare site vragen we niet om je woonplaats', async (t) => {
  const search = fakeSearch({ results: [] });
  const { db, base, mailer } = await startServer(t, { hibp: fakeHibp(), search, production: true });
  const cookie = await registerConfirmed(base, mailer);

  const profile = await send(base, '/profiel', { cookie });
  assert.equal(profile.status, 200);
  assert.doesNotMatch(await profile.text(), /name="woonplaats"/);
  const post = await send(base, '/profiel', { method: 'POST', cookie, fields: { woonplaats: 'Utrecht' } });
  assert.equal(post.status, 404);
  assert.equal(db.prepare('SELECT city FROM users').get().city, null); // er is niets bewaard

  const dashboard = await (await send(base, '/dashboard', { cookie })).text();
  assert.doesNotMatch(dashboard, /Woonplaats (toevoegen|wijzigen)/);
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
    /Er is geen zoekvak waarin je een andere naam kunt invullen, of het telefoonnummer van iemand anders/,
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

test('op je eigen computer noemt de privacyverklaring je telefoonnummer, de sms-code en wat we per databroker bijhouden', async (t) => {
  const { CODE_MINUTES } = await import('../src/phone-codes.js');
  const text = await privacyText(t, { search: fakeSearch({ isDemo: false, name: 'Zoekmachine X' }) });
  for (const onderwerp of [
    /Je telefoonnummer, als je dat zelf toevoegt en bevestigt/,
    new RegExp(`De code is ${CODE_MINUTES} minuten geldig en werkt één keer`),
    /sleutel die alleen in het geheugen van de server staat/,
    /Pas als je hem invult, bewaren we het nummer/,
    /Of we ook op het web naar je e-mailadres mogen zoeken, en sinds wanneer\. Dat staat uit, tot jij het aanzet/,
    /met welk gegeven het gevonden is \(je naam, je telefoonnummer of je e-mailadres\)/,
    /Per databroker of telefoongids uit ons register bewaren we wanneer we voor het laatst keken/,
    /gericht bij databrokers en telefoongidsen, op sociale media en in openbare documenten/,
    /Dat zoeken gaat via de zoekdienst/,
    /Heb je je telefoonnummer bevestigd, dan sturen we bij de Deep Scan ook dat nummer \(in een paar schrijfwijzen\) als zoekopdracht naar Zoekmachine X/,
    /Er is nog geen sms-dienst gekoppeld\. De sms met de code komt op deze installatie in een testpostvak/,
    new RegExp(`Een code voor je telefoonnummer: ${CODE_MINUTES} minuten`),
    /Wat we per databroker bijhouden: zolang je account bestaat/,
    /verwijder je je telefoonnummer/,
  ]) {
    assert.match(text, onderwerp);
  }
});

test('bij de demo-zoekdienst gaan ook je telefoonnummer en e-mailadres nergens heen', async (t) => {
  const text = await privacyText(t, { search: fakeSearch({ isDemo: true }) });
  assert.doesNotMatch(text, /dan sturen we ook je e-mailadres als zoekopdracht/);
  assert.doesNotMatch(text, /dan sturen we bij de Deep Scan ook dat nummer/);
});

test('leest de site gevonden pagina\'s zelf, dan zegt de privacyverklaring wat er gebeurt en wat we bewaren', async (t) => {
  const reader = { async read() { return { status: 'onbereikbaar' }; } };
  const on = await privacyText(t, { search: fakeSearch(), pageReader: reader });
  assert.match(on, /Gevonden pagina's lezen we soms zelf\./);
  assert.match(on, /Sites van databrokers, personenzoeksites en sociale media openen we niet/);
  assert.match(on, /robots\.txt/);
  assert.match(on, /alleen welke van je gegevens erop stonden en een kort stukje tekst rond je naam/);
  const off = await privacyText(t, { search: fakeSearch() });
  assert.doesNotMatch(off, /Gevonden pagina's lezen we soms zelf/);
});

test('met een AI-model zegt de privacyverklaring welk model, wat het krijgt en waar het draait', async (t) => {
  const { createAiAgent } = await import('../src/ai/agent.js');
  const provider = (url, local) => ({
    name: 'Ollama', model: 'qwen3:8b', url, local, async chat() { return { content: {} }; },
  });
  const local = await privacyText(t, { search: fakeSearch(), ai: createAiAgent({ provider: provider('http://127.0.0.1:11434', true) }) });
  assert.match(local, /Een AI-model kijkt mee\. Bij de Deep Scan beoordeelt een AI-model \(qwen3:8b, via Ollama\)/);
  assert.match(local, /je naam, je woonplaats, je bevestigde e-mailadres en telefoonnummer, en de tekst van de resultaten/);
  assert.match(local, /Het model draait op dezelfde computer als deze site: er gaat niets naar een externe AI-dienst\./);
  assert.match(local, /We gebruiken niets om een AI-model te trainen\./);

  const remote = await privacyText(t, { search: fakeSearch(), ai: createAiAgent({ provider: provider('http://192.168.1.20:11434', false) }) });
  assert.match(remote, /Het model draait op een andere computer \(192\.168\.1\.20:11434\): daar gaan die gegevens heen\./);

  const none = await privacyText(t, { search: fakeSearch() });
  assert.doesNotMatch(none, /AI-model/);
});
