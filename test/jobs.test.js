// Tests voor de onderzoekswachtrij (src/jobs/) en de Deep Scan op de achtergrond.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, removeExpired } from '../src/db.js';
import { listEvents } from '../src/events.js';
import {
  MAX_ATTEMPTS, activeJob, claimNextJob, enqueueJob, finishJob, getJob, jobOf, queueOverview, requeueInterrupted,
  saveProgress,
} from '../src/jobs/queue.js';
import { JobError, createWorker } from '../src/jobs/worker.js';
import { plannedSteps, runDeepScan } from '../src/scanner.js';
import {
  ANNA, CLUB, fakeHibp, fakeSearch, registerConfirmed, send, startServer,
} from './helpers.js';

function addUser(db, id = 1) {
  db.prepare('INSERT INTO users (id, name, email, password_hash, created_at, email_confirmed_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, `Gebruiker ${id}`, `gebruiker${id}@example.com`, 'x', 1, 1);
}

// --- De wachtrij zelf -------------------------------------------------------------------------------

test('per account hooguit één onderzoek in de wachtrij; de oudste gaat eerst', () => {
  const db = openDatabase(':memory:');
  addUser(db, 1);
  addUser(db, 2);
  const first = enqueueJob(db, { userId: 1, steps: plannedSteps() }, 100);
  assert.equal(first.created, true);
  assert.equal(first.job.status, 'queued');
  assert.equal(first.job.steps.length, plannedSteps().length);
  const again = enqueueJob(db, { userId: 1 }, 200);
  assert.equal(again.created, false);
  assert.equal(again.job.id, first.job.id);
  enqueueJob(db, { userId: 2 }, 150);

  const claimed = claimNextJob(db, 300);
  assert.equal(claimed.id, first.job.id);
  assert.equal(claimed.status, 'running');
  assert.equal(claimed.attempts, 1);
  assert.equal(claimed.startedAt, 300);
  assert.equal(activeJob(db, 1).status, 'running');
  assert.equal(claimNextJob(db, 301).userId, 2);
  assert.equal(claimNextJob(db, 302), null);

  saveProgress(db, claimed.id, [{ id: 'datalekken', status: 'done' }], 400);
  assert.deepEqual(getJob(db, claimed.id).steps, [{ id: 'datalekken', status: 'done' }]);
  assert.equal(getJob(db, claimed.id).heartbeatAt, 400);

  finishJob(db, claimed.id, { status: 'done' }, 500);
  assert.equal(getJob(db, claimed.id).status, 'done');
  assert.equal(getJob(db, claimed.id).finishedAt, 500);
  assert.equal(activeJob(db, 1), null);
  assert.equal(enqueueJob(db, { userId: 1 }, 600).created, true); // klaar: dan mag er een nieuwe
  assert.throws(() => finishJob(db, claimed.id, { status: 'running' }), /Geen eindtoestand/);
});

test('jobOf geeft alleen een onderzoek van dat account', () => {
  const db = openDatabase(':memory:');
  addUser(db, 1);
  addUser(db, 2);
  const { job } = enqueueJob(db, { userId: 1 });
  assert.equal(jobOf(db, 1, job.id).id, job.id);
  assert.equal(jobOf(db, 2, job.id), null);
});

test('na een herstart gaat een onderbroken onderzoek terug in de wachtrij, tot het te vaak gebeurde', () => {
  const db = openDatabase(':memory:');
  addUser(db, 1);
  addUser(db, 2);
  const { job } = enqueueJob(db, { userId: 1 });
  claimNextJob(db);
  assert.deepEqual(requeueInterrupted(db), { requeued: 1, failed: 0 });
  assert.equal(getJob(db, job.id).status, 'queued');
  assert.equal(getJob(db, job.id).startedAt, null);

  const { job: stuck } = enqueueJob(db, { userId: 2 });
  db.prepare("UPDATE jobs SET status = 'running', attempts = ? WHERE id = ?").run(MAX_ATTEMPTS, stuck.id);
  assert.deepEqual(requeueInterrupted(db), { requeued: 0, failed: 1 });
  assert.equal(getJob(db, stuck.id).status, 'failed');
  assert.equal(getJob(db, stuck.id).error, 'interrupted');
  assert.deepEqual(queueOverview(db).counts, { queued: 1, running: 0, done: 0, failed: 1 });
});

test('afgeronde onderzoeken blijven 30 dagen; met het account verdwijnen ze meteen', () => {
  const db = openDatabase(':memory:');
  addUser(db, 1);
  addUser(db, 2);
  const day = 24 * 60 * 60 * 1000;
  const now = Date.now();
  const { job: old } = enqueueJob(db, { userId: 1 }, now - 40 * day);
  finishJob(db, old.id, { status: 'done' }, now - 31 * day);
  const { job: recent } = enqueueJob(db, { userId: 1 }, now - 2 * day);
  finishJob(db, recent.id, { status: 'failed', error: 'unexpected' }, now - day);
  removeExpired(db, now);
  assert.equal(getJob(db, old.id), null);
  assert.ok(getJob(db, recent.id));

  enqueueJob(db, { userId: 2 });
  db.prepare('DELETE FROM users WHERE id = 2').run();
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM jobs WHERE user_id = 2').get().n, 0);
});

// --- De werker ----------------------------------------------------------------------------------

test('de werker voert de wachtrij uit, één tegelijk, en bewaart de voortgang', async () => {
  const db = openDatabase(':memory:');
  addUser(db, 1);
  addUser(db, 2);
  enqueueJob(db, { userId: 1 });
  enqueueJob(db, { userId: 2 });
  const order = [];
  let concurrent = 0;
  const worker = createWorker({
    db,
    handlers: {
      async deep(job, { progress }) {
        concurrent += 1;
        assert.equal(concurrent, 1);
        progress([{ id: 'stap', status: 'running' }]);
        assert.deepEqual(getJob(db, job.id).steps, [{ id: 'stap', status: 'running' }]);
        await new Promise((resolve) => { setTimeout(resolve, 5); });
        order.push(job.userId);
        concurrent -= 1;
        return { steps: [{ id: 'stap', status: 'done' }] };
      },
    },
  });
  await Promise.all([worker.drain(), worker.drain()]); // twee keer tegelijk: toch één ronde
  assert.deepEqual(order, [1, 2]);
  assert.deepEqual(db.prepare('SELECT status, steps FROM jobs ORDER BY id').all().map((row) => ({ ...row })), [
    { status: 'done', steps: '[{"id":"stap","status":"done"}]' },
    { status: 'done', steps: '[{"id":"stap","status":"done"}]' },
  ]);
  assert.equal(worker.isBusy(), false);
});

test('een mislukt onderzoek krijgt een vaste foutcode; de foutmelding zelf komt alleen in de terminal', async () => {
  const db = openDatabase(':memory:');
  addUser(db, 1);
  addUser(db, 2);
  addUser(db, 3);
  enqueueJob(db, { userId: 1 });
  enqueueJob(db, { userId: 2 });
  enqueueJob(db, { userId: 3, kind: 'deep' });
  db.prepare("UPDATE jobs SET kind = 'deep' WHERE user_id = 3").run();
  const lines = [];
  const worker = createWorker({
    db,
    log: (line) => lines.push(line),
    handlers: {
      async deep(job) {
        if (job.userId === 1) throw new JobError('account_unavailable');
        if (job.userId === 2) throw new TypeError('kapot bij anna@example.com\ntweede regel');
        return {};
      },
    },
  });
  await worker.drain();
  const rows = db.prepare('SELECT user_id, status, error FROM jobs ORDER BY id').all().map((row) => ({ ...row }));
  assert.deepEqual(rows, [
    { user_id: 1, status: 'failed', error: 'account_unavailable' },
    { user_id: 2, status: 'failed', error: 'unexpected' },
    { user_id: 3, status: 'done', error: null },
  ]);
  assert.deepEqual(lines, ['Onderzoek 2 mislukte (TypeError): kapot bij anna@example.com']); // alleen de terminal
  const log = JSON.stringify(db.prepare('SELECT * FROM system_events').all());
  assert.ok(!log.includes('anna'));
  assert.deepEqual(listEvents(db).map((event) => event.text), [
    'Een onderzoek op de achtergrond mislukte: onverwachte fout (de details staan in de terminal).',
    'Een onderzoek op de achtergrond mislukte: het account bestaat niet meer, is geblokkeerd of niet bevestigd.',
  ]);
});

test('start zet onderbroken onderzoeken terug en meldt dat in het log; stop zet de werker uit', async () => {
  const db = openDatabase(':memory:');
  addUser(db, 1);
  enqueueJob(db, { userId: 1 });
  claimNextJob(db);
  const ran = [];
  const worker = createWorker({ db, pollMs: 5, handlers: { async deep(job) { ran.push(job.id); return {}; } } });
  worker.start();
  try {
    for (let i = 0; i < 100 && ran.length === 0; i += 1) await new Promise((resolve) => { setTimeout(resolve, 5); });
  } finally {
    worker.stop();
  }
  assert.deepEqual(ran, [1]);
  assert.equal(getJob(db, 1).status, 'done');
  assert.equal(getJob(db, 1).attempts, 2);
  assert.match(listEvents(db).map((event) => event.text).join('\n'), /Na een herstart: 1 onderzoek\(en\) opnieuw in de wachtrij gezet\./);
});

// --- De Deep Scan meldt zijn voortgang ----------------------------------------------------------

test('runDeepScan meldt na elke stap alle stappen: gedaan, bezig en wachtend', async () => {
  const db = openDatabase(':memory:');
  addUser(db, 1);
  const user = db.prepare('SELECT * FROM users WHERE id = 1').get();
  const snapshots = [];
  await runDeepScan({
    db, user: { ...user }, hibp: fakeHibp(), search: fakeSearch({ results: [CLUB] }), allowWeb: true,
    onProgress: (steps) => snapshots.push(steps.map((step) => step.status)),
  });
  const total = plannedSteps().length;
  assert.equal(snapshots.length, total + 1);
  assert.deepEqual(snapshots[0], ['running', ...Array(total - 1).fill('pending')]);
  assert.equal(snapshots[1][0], 'done');
  assert.equal(snapshots[1][1], 'running');
  assert.ok(snapshots.at(-1).every((status) => !['pending', 'running'].includes(status)));
});

// --- Via de site, op de achtergrond ------------------------------------------------------------------

test('de Deep Scan loopt op de achtergrond: voortgang op de pagina, en de pagina ververst zichzelf', async (t) => {
  const search = fakeSearch({ results: [CLUB] });
  const { base, db, mailer, jobs } = await startServer(t, { runJobsInline: false, hibp: fakeHibp(), search });
  const cookie = await registerConfirmed(base, mailer, ANNA);

  const response = await send(base, '/scan/deep', { method: 'POST', cookie });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), '/resultaten?gescand=deep#rapport');
  assert.equal(search.calls.length, 0); // nog niets gedaan: het staat in de wachtrij

  const waiting = await (await send(base, '/resultaten?gescand=deep', { cookie })).text();
  assert.match(waiting, /<meta http-equiv="refresh" content="3">/);
  assert.match(waiting, /Je Deep Scan loopt op de achtergrond\. Je mag deze pagina sluiten/);
  assert.match(waiting, /<h2 id="engine-heading">Je Deep Scan loopt<\/h2>/);
  assert.match(waiting, /In de wachtrij/);
  assert.match(waiting, /state-idle">Wacht</);
  const dashboard = await (await send(base, '/dashboard', { cookie })).text();
  assert.match(dashboard, /Je Deep Scan loopt op de achtergrond/);
  assert.doesNotMatch(dashboard, /Start Deep Scan/);

  // Nog een keer op de knop: geen tweede onderzoek, en het telt niet mee in de limieten.
  for (let i = 0; i < 6; i += 1) assert.equal((await send(base, '/scan/deep', { method: 'POST', cookie })).status, 303);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n, 1);

  await jobs.drain();
  // Naam, twee groepen databrokers, sociale media en documenten. Telefoon en e-mail niet:
  // er is geen bevestigd nummer en geen toestemming voor het e-mailadres.
  assert.equal(search.calls.length, 5);
  const done = await (await send(base, '/resultaten?gescand=deep', { cookie })).text();
  assert.doesNotMatch(done, /http-equiv="refresh"/);
  assert.match(done, /Rapport van je laatste Deep Scan/);
  assert.match(done, /Deep Scan klaar: \d+ van 12 stappen voltooid/);
  assert.equal(db.prepare('SELECT status FROM jobs').get().status, 'done');
});

test('wie geblokkeerd wordt terwijl zijn onderzoek wacht, wordt niet onderzocht', async (t) => {
  const search = fakeSearch({ results: [CLUB] });
  const hibp = fakeHibp();
  const { base, db, mailer, jobs } = await startServer(t, { runJobsInline: false, hibp, search });
  const cookie = await registerConfirmed(base, mailer, ANNA);
  await send(base, '/scan/deep', { method: 'POST', cookie });
  db.prepare('UPDATE users SET blocked_at = 1').run();
  await jobs.drain();
  assert.equal(search.calls.length, 0);
  assert.equal(hibp.calls.length, 0);
  assert.deepEqual({ ...db.prepare('SELECT status, error FROM jobs').get() }, { status: 'failed', error: 'account_unavailable' });
});

test('een mislukt onderzoek staat eerlijk op de resultatenpagina, en de knop werkt weer', async (t) => {
  const { base, db, mailer, jobs } = await startServer(t, { runJobsInline: false, hibp: fakeHibp() });
  const cookie = await registerConfirmed(base, mailer, ANNA);
  await send(base, '/scan/deep', { method: 'POST', cookie });
  db.prepare("UPDATE jobs SET status = 'failed', error = 'interrupted', finished_at = 1").run();
  const page = await (await send(base, '/resultaten', { cookie })).text();
  assert.match(page, /Je laatste Deep Scan is niet afgemaakt \(te vaak onderbroken door een herstart van de server\)/);
  assert.match(await (await send(base, '/dashboard', { cookie })).text(), /Start Deep Scan/);
  await send(base, '/scan/deep', { method: 'POST', cookie });
  await jobs.drain();
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status = 'done'").get().n, 1);
});

// --- Stoppen, en het account opnieuw lezen tijdens het onderzoek -------------------------------------

// Een zoekdienst die bij de zoveelste aanvraag iets laat gebeuren (bijvoorbeeld: de gebruiker stopt het
// onderzoek), en daarna gewoon antwoordt.
function searchThatDoes(at, action) {
  const search = fakeSearch({
    results: () => {
      if (search.calls.length === at) action();
      return [CLUB];
    },
  });
  return search;
}

test('een onderzoek in de wachtrij stoppen: meteen gestopt, er wordt niets gezocht', async (t) => {
  const search = fakeSearch({ results: [CLUB] });
  const { base, db, mailer, jobs } = await startServer(t, { runJobsInline: false, hibp: fakeHibp(), search });
  const cookie = await registerConfirmed(base, mailer, ANNA);
  await send(base, '/scan/deep', { method: 'POST', cookie });

  const stop = await send(base, '/scan/deep/stoppen', { method: 'POST', cookie });
  assert.equal(stop.headers.get('location'), '/resultaten?gestopt#rapport');
  await jobs.drain();
  assert.equal(search.calls.length, 0);
  assert.deepEqual({ ...db.prepare('SELECT status, error, cancel_requested FROM jobs').get() }, { status: 'failed', error: 'cancelled', cancel_requested: 'user' });
  const page = await (await send(base, '/resultaten?gestopt', { cookie })).text();
  assert.match(page, /Je Deep Scan is gestopt\. Wat hij al gevonden had, staat hieronder\./);
  assert.match(page, /Je gestopte Deep Scan/);
  assert.doesNotMatch(page, /http-equiv="refresh"/);
  assert.ok(listEvents(db, { limit: 20 }).some((event) => event.text === 'Een onderzoek op de achtergrond is gestopt door de gebruiker zelf.'));
  // Daarna kan er gewoon een nieuwe.
  assert.equal((await send(base, '/scan/deep', { method: 'POST', cookie })).status, 303);
  assert.equal(activeJob(db, 1).status, 'queued');
});

test('een lopend onderzoek stopt bij het volgende controlepunt; wat al gedaan was, blijft', async (t) => {
  let db;
  const search = searchThatDoes(1, () => db.prepare("UPDATE jobs SET cancel_requested = 'user' WHERE status = 'running'").run());
  const server = await startServer(t, { runJobsInline: false, hibp: fakeHibp(), search });
  db = server.db;
  const cookie = await registerConfirmed(server.base, server.mailer, ANNA);
  await send(server.base, '/scan/deep', { method: 'POST', cookie });
  await server.jobs.drain();

  // Na de eerste zoekopdracht (je naam) is er niets meer gezocht.
  assert.equal(search.calls.length, 1);
  const job = db.prepare('SELECT status, error, steps FROM jobs').get();
  assert.equal(job.status, 'failed');
  assert.equal(job.error, 'cancelled');
  const steps = JSON.parse(job.steps);
  assert.equal(steps.find((step) => step.id === 'datalekken').status, 'done');
  assert.equal(steps.find((step) => step.id === 'telefoon').status, 'skipped');
  assert.ok(steps.every((step) => !['pending', 'running'].includes(step.status)));
  // Wat de eerste zoekopdracht vond, staat er wel.
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM findings WHERE kind = 'web'").get().n, 1);
});

test('de beheerder kan een onderzoek stoppen; een ander account niet', async (t) => {
  const search = fakeSearch({ results: [CLUB] });
  const owner = { ...ANNA, email: 'eigenaar@example.com', naam: 'Eva Eigenaar' };
  const { base, db, mailer, jobs } = await startServer(t, {
    runJobsInline: false, hibp: fakeHibp(), search, ownerEmail: owner.email,
  });
  const admin = await registerConfirmed(base, mailer, owner);
  const anna = await registerConfirmed(base, mailer, ANNA);
  await send(base, '/scan/deep', { method: 'POST', cookie: anna });
  const id = db.prepare('SELECT id FROM jobs').get().id;

  // Anna kan geen beheerroute gebruiken.
  assert.equal((await send(base, `/beheerder/onderzoeken/${id}/stoppen`, { method: 'POST', cookie: anna })).status, 404);
  assert.equal(db.prepare('SELECT status FROM jobs').get().status, 'queued');

  const html = await (await send(base, '/beheerder', { cookie: admin })).text();
  assert.match(html, new RegExp(`action="/beheerder/onderzoeken/${id}/stoppen"`));
  const stop = await send(base, `/beheerder/onderzoeken/${id}/stoppen`, { method: 'POST', cookie: admin });
  assert.equal(stop.headers.get('location'), '/beheerder?melding=gestopt#onderzoeken');
  assert.equal((await send(base, '/beheerder/onderzoeken/999/stoppen', { method: 'POST', cookie: admin })).status, 404);
  await jobs.drain();
  assert.equal(search.calls.length, 0);
  assert.deepEqual({ ...db.prepare('SELECT status, error FROM jobs').get() }, { status: 'failed', error: 'cancelled_admin' });
  assert.match(await (await send(base, '/resultaten', { cookie: anna })).text(), /gestopt door de beheerder/);
});

test('wie tijdens zijn onderzoek geblokkeerd wordt: het onderzoek stopt bij het volgende controlepunt', async (t) => {
  let db;
  const search = searchThatDoes(1, () => db.prepare('UPDATE users SET blocked_at = 1').run());
  const hibp = fakeHibp();
  const server = await startServer(t, { runJobsInline: false, hibp, search });
  db = server.db;
  const cookie = await registerConfirmed(server.base, server.mailer, ANNA);
  await send(server.base, '/scan/deep', { method: 'POST', cookie });
  await server.jobs.drain();
  assert.equal(search.calls.length, 1);
  assert.deepEqual({ ...db.prepare('SELECT status, error FROM jobs').get() }, { status: 'failed', error: 'account_unavailable' });
});

test('wie tijdens zijn onderzoek zoeken op zijn e-mailadres uitzet of zijn nummer verwijdert, wordt daar niet meer op onderzocht', async (t) => {
  let db;
  const search = searchThatDoes(1, () => db.prepare('UPDATE users SET email_web_at = NULL, phone = NULL, phone_verified_at = NULL').run());
  const server = await startServer(t, { runJobsInline: false, hibp: fakeHibp(), search });
  db = server.db;
  const cookie = await registerConfirmed(server.base, server.mailer, ANNA);
  // Bij de start: toestemming voor het e-mailadres, en een bevestigd nummer.
  db.prepare("UPDATE users SET email_web_at = 1, phone = '+31612345678', phone_verified_at = 1").run();
  await send(server.base, '/scan/deep', { method: 'POST', cookie });
  await server.jobs.drain();

  assert.ok(search.calls.length > 1);
  assert.ok(search.calls.every((call) => !call.query.includes(ANNA.email) && !call.query.includes('0612345678')));
  const steps = JSON.parse(db.prepare('SELECT steps FROM jobs').get().steps);
  assert.equal(steps.find((step) => step.id === 'telefoon').status, 'skipped');
  assert.equal(steps.find((step) => step.id === 'e-mail').status, 'skipped');
  assert.equal(db.prepare('SELECT status FROM jobs').get().status, 'done');
});

test('na een herstart krijgt een onderzoek waarvoor om stoppen gevraagd was, geen nieuwe ronde', () => {
  const db = openDatabase(':memory:');
  addUser(db, 1);
  addUser(db, 2);
  enqueueJob(db, { userId: 1 }, 1);
  enqueueJob(db, { userId: 2 }, 2);
  claimNextJob(db, 3);
  claimNextJob(db, 4);
  db.prepare("UPDATE jobs SET cancel_requested = 'admin' WHERE user_id = 1").run();
  requeueInterrupted(db, 5);
  assert.deepEqual({ ...db.prepare('SELECT status, error FROM jobs WHERE user_id = 1').get() }, { status: 'failed', error: 'cancelled_admin' });
  assert.equal(db.prepare('SELECT status FROM jobs WHERE user_id = 2').get().status, 'queued');
});
