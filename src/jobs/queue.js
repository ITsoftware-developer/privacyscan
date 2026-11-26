// De onderzoekswachtrij: wat er moet gebeuren, wat er loopt en hoe ver het is. Alles staat in de
// database (tabel jobs), dus een herstart van de server verliest niets: een onderzoek dat liep,
// gaat bij het starten terug in de wachtrij (zie requeueInterrupted).
//
// Per account staat er hooguit één onderzoek in de wachtrij of loopt er één. Wie nog een keer op
// de knop drukt, krijgt het onderzoek dat er al is.

export const JOB_STATUSES = {
  queued: { tone: 'idle', label: 'In de wachtrij' },
  running: { tone: 'warn', label: 'Bezig' },
  done: { tone: 'ok', label: 'Klaar' },
  failed: { tone: 'bad', label: 'Mislukt' },
};

// Hoe vaak een onderzoek opnieuw mag beginnen na een herstart, voordat het als mislukt telt.
export const MAX_ATTEMPTS = 3;

function parseSteps(text) {
  try {
    const steps = JSON.parse(text);
    return Array.isArray(steps) ? steps : [];
  } catch {
    return [];
  }
}

function fromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    kind: row.kind,
    status: row.status,
    steps: parseSteps(row.steps),
    error: row.error ?? null,
    attempts: row.attempts,
    createdAt: row.created_at,
    startedAt: row.started_at ?? null,
    heartbeatAt: row.heartbeat_at ?? null,
    finishedAt: row.finished_at ?? null,
  };
}

// Het onderzoek dat voor dit account in de wachtrij staat of loopt, of null.
export function activeJob(db, userId) {
  return fromRow(db.prepare(`
    SELECT * FROM jobs WHERE user_id = ? AND status IN ('queued', 'running')
    ORDER BY created_at, id LIMIT 1`).get(userId));
}

// Zet een onderzoek in de wachtrij. Staat er al een voor dit account, dan krijg je dat terug
// (created: false). `steps` is de voortgang zoals die op de pagina komt voordat er iets loopt.
export function enqueueJob(db, { userId, kind = 'deep', steps = [] }, now = Date.now()) {
  const existing = activeJob(db, userId);
  if (existing) return { job: existing, created: false };
  const { lastInsertRowid } = db.prepare(`
    INSERT INTO jobs (user_id, kind, status, steps, created_at) VALUES (?, ?, 'queued', ?, ?)`)
    .run(userId, kind, JSON.stringify(steps), now);
  return { job: getJob(db, Number(lastInsertRowid)), created: true };
}

export function getJob(db, id) {
  return fromRow(db.prepare('SELECT * FROM jobs WHERE id = ?').get(id));
}

// Alleen een onderzoek van dit account (anders null), voor de pagina's van de gebruiker.
export function jobOf(db, userId, id) {
  return fromRow(db.prepare('SELECT * FROM jobs WHERE id = ? AND user_id = ?').get(id, userId));
}

// Het laatste onderzoek van dit account, in welke toestand ook.
export function latestJob(db, userId) {
  return fromRow(db.prepare('SELECT * FROM jobs WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 1').get(userId));
}

// Pakt het oudste onderzoek uit de wachtrij en zet het op "bezig", in één stap: twee werkers kunnen
// zo nooit hetzelfde onderzoek pakken.
export function claimNextJob(db, now = Date.now()) {
  return fromRow(db.prepare(`
    UPDATE jobs SET status = 'running', started_at = ?, heartbeat_at = ?, attempts = attempts + 1
    WHERE id = (SELECT id FROM jobs WHERE status = 'queued' ORDER BY created_at, id LIMIT 1)
    RETURNING *`).get(now, now));
}

// Bewaart de voortgang van een lopend onderzoek (en laat zien dat het nog leeft).
export function saveProgress(db, id, steps, now = Date.now()) {
  db.prepare("UPDATE jobs SET steps = ?, heartbeat_at = ? WHERE id = ? AND status = 'running'")
    .run(JSON.stringify(steps), now, id);
}

export function finishJob(db, id, { status, steps = null, error = null }, now = Date.now()) {
  if (status !== 'done' && status !== 'failed') throw new Error(`Geen eindtoestand: ${status}`);
  db.prepare(`
    UPDATE jobs SET status = ?, error = ?, finished_at = ?, heartbeat_at = ?, steps = COALESCE(?, steps)
    WHERE id = ?`).run(status, error, now, now, steps === null ? null : JSON.stringify(steps), id);
}

// Bij het starten van de server: wat nog "bezig" was, is onderbroken (er is maar één werker, en die
// stond net uit). Dat gaat terug in de wachtrij, tenzij het al te vaak opnieuw begonnen is.
// Geeft { requeued, failed }.
export function requeueInterrupted(db, now = Date.now()) {
  const failed = db.prepare(`
    UPDATE jobs SET status = 'failed', error = 'interrupted', finished_at = ?
    WHERE status = 'running' AND attempts >= ?`).run(now, MAX_ATTEMPTS).changes;
  const requeued = db.prepare(`
    UPDATE jobs SET status = 'queued', started_at = NULL, heartbeat_at = NULL
    WHERE status = 'running'`).run().changes;
  return { requeued: Number(requeued), failed: Number(failed) };
}

// Voor de beheerpagina: wat er nu in de wachtrij staat of loopt, en de laatste die mislukten.
export function queueOverview(db, { limit = 20 } = {}) {
  const active = db.prepare(`
    SELECT * FROM jobs WHERE status IN ('queued', 'running') ORDER BY created_at, id LIMIT ?`).all(limit).map(fromRow);
  const failed = db.prepare(`
    SELECT * FROM jobs WHERE status = 'failed' ORDER BY finished_at DESC, id DESC LIMIT ?`).all(5).map(fromRow);
  const counts = { queued: 0, running: 0, done: 0, failed: 0 };
  for (const row of db.prepare('SELECT status, COUNT(*) AS n FROM jobs GROUP BY status').all()) counts[row.status] = row.n;
  return { active, failed, counts };
}
