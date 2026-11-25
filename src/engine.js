// De onderdelen van de Deep Scan: de vijf stappen, welke soorten gegevens er zijn blootgesteld,
// en de controle of elke bevinding een bron, datum en zekerheid heeft.
//
// Alles hier is rekenwerk op wat al gevonden is. Er wordt niets opgehaald en niets verzonnen:
// een stap die nog niet bestaat, staat als "nog niet gebouwd" in het rapport en nooit als
// voltooid.
import { BREACH_CONFIDENCE } from './confidence.js';

export const STEP_DEFS = [
  { id: 'datalekken', title: 'Datalekdatabases onderzoeken' },
  { id: 'databrokers', title: 'Databrokers controleren' },
  { id: 'web', title: 'Openbare internetbronnen onderzoeken' },
  { id: 'blootstelling', title: 'Blootstelling van persoonsgegevens controleren' },
  { id: 'verificatie', title: 'Bevindingen verifiëren' },
];

export const STEP_TITLES = Object.fromEntries(STEP_DEFS.map((step) => [step.id, step.title]));

// Hoe een stap eruitziet in de pagina's. `tone` bepaalt de kleur, maar de status staat altijd
// ook als tekst bij, zodat kleur nooit het enige is.
export const STATUSES = {
  // Een stap die gelopen is, of niet kon lopen
  done: { tone: 'ok', label: 'Voltooid' },
  unreachable: { tone: 'bad', label: 'Niet toegankelijk' }, // de bron was er, maar we kwamen er niet bij
  failed: { tone: 'bad', label: 'Mislukt' },
  skipped: { tone: 'warn', label: 'Overgeslagen' },         // mag of kan nu niet, bijvoorbeeld door een regel
  unavailable: { tone: 'warn', label: 'Niet beschikbaar' }, // er is geen bron ingesteld
  planned: { tone: 'idle', label: 'Nog niet gebouwd' },
  // Alleen voor de startpagina, voordat er iets gedaan is
  available: { tone: 'ok', label: 'Beschikbaar' },
  testmode: { tone: 'warn', label: 'Testmodus' },
  account: { tone: 'idle', label: 'Met account' },
  after: { tone: 'idle', label: 'Na stap 1' },
};

// Maakt van een stap wat de pagina nodig heeft: { title, tone, label, note }. Een status die we
// niet kennen (bijvoorbeeld uit een kapotte database) tonen we als "Onbekend", nooit als voltooid.
export function describeStep(step) {
  const known = Object.hasOwn(STATUSES, step?.status);
  const { tone, label } = known ? STATUSES[step.status] : { tone: 'idle', label: 'Onbekend' };
  return {
    title: String(step?.title ?? STEP_TITLES[step?.id] ?? ''),
    tone,
    label: step?.status === 'done' && step.demo ? `${label} (demo)` : label,
    note: step?.note ? String(step.note) : '',
  };
}

const lekken = (n) => (n === 1 ? '1 lek' : `${n} lekken`);
const bevindingen = (n) => (n === 1 ? '1 bevinding' : `${n} bevindingen`);

// --- Blootstelling: welke soorten gegevens zijn gelekt? ----------------------------------------
// We zeggen welke SOORTEN gegevens bij welke lekken zijn blootgesteld, nooit de gegevens zelf (die
// hebben we niet). De namen van de soorten komen van de bron; wat we niet herkennen, tonen we
// niet als groep (het blijft wel zichtbaar bij het lek zelf).
const GROUPS = [
  {
    id: 'inloggegevens',
    label: 'Inloggegevens',
    classes: ['passwords', 'password hints', 'usernames', 'auth tokens', 'security questions and answers'],
    advice: 'Gebruik het wachtwoord van die diensten nergens meer, ook niet op andere sites. Kies overal een eigen wachtwoord en zet tweestapsverificatie aan.',
  },
  {
    id: 'telefoon',
    label: 'Telefoonnummers',
    classes: ['phone numbers'],
    advice: 'Wees alert op nep-sms\'jes en telefoontjes van "je bank" of "een bezorger".',
  },
  {
    id: 'adres',
    label: 'Adressen en locaties',
    classes: ['physical addresses', 'geographic locations'],
    advice: 'Je adres is in handen van anderen. Let op phishing waarin je echte adres staat om geloofwaardig te lijken.',
  },
  {
    id: 'identiteit',
    label: 'Identiteit',
    classes: ['names', 'dates of birth', 'genders', 'ages'],
    advice: 'Met zulke gegevens lijkt een nepmail echt. Wees voorzichtig met onverwachte verzoeken om gegevens of geld.',
  },
  {
    id: 'betaling',
    label: 'Betaalgegevens',
    classes: ['credit cards', 'partial credit card data', 'bank account numbers'],
    advice: 'Controleer je afschriften en vraag bij twijfel je bank wat je het beste kunt doen.',
  },
  {
    id: 'online',
    label: 'Online activiteit',
    classes: ['ip addresses', 'social media profiles', 'private messages', 'device information', 'browser user agent details'],
    advice: 'Bekijk de privacy-instellingen van de diensten in dit lijstje.',
  },
];

const norm = (value) => String(value ?? '').trim().toLowerCase();

// breaches: [{ title, dataClasses }]. Geeft per groep waarvan er iets gelekt is:
// { id, label, breaches: [titels], advice }.
export function exposureFrom(breaches) {
  const result = [];
  for (const group of GROUPS) {
    const wanted = new Set(group.classes);
    const titles = [];
    for (const breach of breaches) {
      const classes = Array.isArray(breach.dataClasses) ? breach.dataClasses : [];
      if (classes.some((item) => wanted.has(norm(item))) && !titles.includes(breach.title)) {
        titles.push(breach.title);
      }
    }
    if (titles.length > 0) result.push({ id: group.id, label: group.label, breaches: titles, advice: group.advice });
  }
  return result;
}

// Eén zin voor in het rapport, bijvoorbeeld "Inloggegevens in 2 lekken, telefoonnummers in 1 lek."
export function exposureNote(exposure, breachCount) {
  if (breachCount === 0) return 'Er is geen datalek gevonden, dus er is niets om te beoordelen.';
  if (exposure.length === 0) {
    return 'In de gevonden lekken herkennen we geen inloggegevens, telefoonnummers, adressen of betaalgegevens.';
  }
  const text = exposure.map((group) => `${group.label.toLowerCase()} in ${lekken(group.breaches.length)}`).join(', ');
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

// --- Verifiëren: heeft elke bevinding een bron, een datum en een zekerheid? ----------------------
// Dit controleert de bewijsvoering van onze eigen bevindingen. De inhoud van de bron zelf
// controleren we niet: dat kan alleen jij, door de link te openen.
export function verifyFindings(findings) {
  const counts = { checked: findings.length, withoutSource: 0, withoutDate: 0, unrated: 0, withoutLink: 0 };
  for (const finding of findings) {
    if (!finding.source_id) counts.withoutSource += 1;
    if (!finding.checked_at) counts.withoutDate += 1;
    if (!finding.confidence) counts.unrated += 1;
    if (!finding.url) counts.withoutLink += 1;
  }
  return counts;
}

export function verifyNote({ checked, withoutSource, withoutDate, unrated, withoutLink }) {
  if (checked === 0) return 'Er zijn geen bevindingen om te controleren.';
  const problems = [];
  if (withoutSource) problems.push(`${withoutSource} zonder bron`);
  if (withoutDate) problems.push(`${withoutDate} zonder datum`);
  if (unrated) problems.push(`${unrated} zonder beoordeling van de zekerheid`);
  if (withoutLink) problems.push(`${withoutLink} zonder directe link`);
  const first = `${bevindingen(checked)} gecontroleerd op bron, datum en zekerheid`;
  return problems.length > 0
    ? `${first}. Let op: ${problems.join(', ')}.`
    : `${first}: elk heeft een bron, een datum en een zekerheid.`;
}

// --- De startpagina ------------------------------------------------------------------------
// Een bezoeker zonder account kan één stap echt uitvoeren: de datalekcontrole. De rest toont wat
// er is of komt, zonder iets voltooid te noemen wat niet gedaan is.

const withTitle = (step) => ({ ...step, title: STEP_TITLES[step.id] });

// Voordat er iets gedaan is.
export function publicPlan({ testMode = false } = {}) {
  return [
    {
      id: 'datalekken',
      status: testMode ? 'testmode' : 'available',
      note: testMode ? 'Alleen testadressen: zie de melding hierboven.' : 'Bekende datalekken, gratis en zonder account.',
    },
    { id: 'databrokers', status: 'planned', note: 'Komt in fase 3, alleen via toegestane bronnen.' },
    { id: 'web', status: 'account', note: 'Alleen op je eigen naam, in je account.' },
    { id: 'blootstelling', status: 'after', note: 'Welke soorten gegevens zijn er blootgesteld?' },
    { id: 'verificatie', status: 'after', note: 'Heeft elke bevinding een bron, een datum en een zekerheid?' },
  ].map(withTitle);
}

// Geeft elk datalek op de openbare pagina dezelfde drie dingen die een bevinding in een account
// heeft: een bron, een datum (nu, want zo vers is het antwoord) en een zekerheid. Ze gelden alleen
// voor deze ene weergave. Er wordt niets van bewaard.
export function withEvidence(breaches, { source, now = Date.now() }) {
  return breaches.map((breach) => ({
    ...breach,
    source_id: source.id,
    checked_at: now,
    confidence: BREACH_CONFIDENCE.level,
    confidence_note: BREACH_CONFIDENCE.note,
  }));
}

// Na een geslaagde controle. Alles wordt berekend uit het resultaat dat de bezoeker nu ziet
// (de lekken met hun bewijs, zie withEvidence), en er wordt niets van bewaard. De controle in
// stap 5 kijkt dus naar precies wat er op de pagina staat.
export function publicRun({ breaches, source }) {
  const exposure = exposureFrom(breaches);
  return [
    {
      id: 'datalekken',
      status: 'done',
      note: breaches.length === 0
        ? `Geen datalek gevonden bij ${source.name}.`
        : `${breaches.length === 1 ? '1 datalek' : `${breaches.length} datalekken`} gevonden bij ${source.name}.`,
    },
    { id: 'databrokers', status: 'planned', note: 'Nog niet gebouwd (fase 3).' },
    { id: 'web', status: 'skipped', note: 'Niet onderzocht: dat kan alleen in je eigen account, op je eigen naam.' },
    { id: 'blootstelling', status: 'done', note: exposureNote(exposure, breaches.length) },
    {
      id: 'verificatie',
      status: breaches.length === 0 ? 'skipped' : 'done',
      note: verifyNote(verifyFindings(breaches)),
    },
  ].map(withTitle);
}
