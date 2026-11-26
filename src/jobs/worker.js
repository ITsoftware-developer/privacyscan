// De werker: pakt onderzoeken uit de wachtrij (queue.js) en voert ze uit, één tegelijk. Eén tegelijk
// is genoeg, en het houdt de site netjes binnen de limieten van de bronnen (Brave staat maar een
// beperkt aantal aanvragen per seconde toe).
//
// De werker draait in hetzelfde proces als de website. Je hoeft dus niets extra's te starten. Na
// een herstart gaat een onderzoek dat liep terug in de wachtrij (requeueInterrupted).
//
// Een handler krijgt het onderzoek en een functie `progress(steps)` om de voortgang te bewaren. Wat
// hij gooit, wordt een mislukt onderzoek met een vaste foutcode: in de database en het log komt
// nooit een foutmelding, want daar kan van alles in staan.
import { logEvent } from '../events.js';
import {
  claimNextJob, finishJob, requeueInterrupted, saveProgress,
} from './queue.js';

// Een fout met een vaste code, voor wat een handler zelf kan uitleggen (bijvoorbeeld een account
// dat intussen geblokkeerd is).
export class JobError extends Error {
  constructor(code) {
    super(code);
    this.name = 'JobError';
    this.code = code;
  }
}

const hasQueued = (db) => db.prepare("SELECT 1 FROM jobs WHERE status = 'queued' LIMIT 1").get() !== undefined;

export function createWorker({
  db, handlers, clock = Date.now, pollMs = 1000, log = console.error,
}) {
  let timer = null;
  let round = null; // de ronde die nu loopt (een Promise), of null

  async function runOne() {
    const job = claimNextJob(db, clock());
    if (!job) return false;
    let steps = job.steps;
    const progress = (next) => {
      steps = next;
      saveProgress(db, job.id, next, clock());
    };
    try {
      const handler = Object.hasOwn(handlers, job.kind) ? handlers[job.kind] : null;
      if (!handler) throw new JobError('unknown_kind');
      const result = await handler(job, { progress });
      finishJob(db, job.id, { status: 'done', steps: Array.isArray(result?.steps) ? result.steps : steps }, clock());
    } catch (error) {
      const code = error instanceof JobError ? error.code : 'unexpected';
      if (!(error instanceof JobError)) {
        // Alleen de soort fout en de eerste regel, en alleen in de terminal.
        log(`Onderzoek ${job.id} mislukte (${error?.name ?? 'Error'}): ${String(error?.message ?? error).split('\n')[0].slice(0, 200)}`);
      }
      finishJob(db, job.id, { status: 'failed', error: code }, clock());
      logEvent(db, 'job_failed', { job: code }, clock());
    }
    return true;
  }

  // Voert alles uit wat er in de wachtrij staat. Loopt er al een ronde, dan wacht dit daarop en
  // kijkt daarna of er nog iets is bijgekomen.
  async function drain() {
    for (;;) {
      if (round) {
        await round;
        continue;
      }
      if (!hasQueued(db)) return;
      round = (async () => {
        try {
          while (await runOne());
        } finally {
          round = null;
        }
      })();
    }
  }

  // Start de werker: eerst wat bij de vorige keer bleef hangen terug in de wachtrij, daarna elke
  // `pollMs` kijken of er werk is.
  function start() {
    const { requeued, failed } = requeueInterrupted(db, clock());
    if (requeued + failed > 0) logEvent(db, 'jobs_requeued', { count: requeued, failed }, clock());
    timer = setInterval(() => {
      if (!round && hasQueued(db)) drain().catch((error) => log(`Wachtrij: ${error?.name ?? 'Error'}`));
    }, pollMs);
    timer.unref();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return {
    drain, start, stop, runOne, isBusy: () => round !== null,
  };
}
