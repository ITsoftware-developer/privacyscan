// De regie van het onderzoek op de achtergrond: wat de werker (jobs/worker.js) doet met een
// onderzoek uit de wachtrij. Nu is dat de Deep Scan; de stappen zelf staan in scanner.js.
//
// Het onderzoek gebruikt altijd de gegevens van het account zoals ze NU in de database staan, niet
// zoals ze waren toen je op de knop drukte. Is het account intussen verwijderd, geblokkeerd of niet
// bevestigd, dan loopt er niets.
import { DEFAULT_LIMITS, perScanLimit } from '../budget.js';
import { logEvent } from '../events.js';
import { cancelRequested } from '../jobs/queue.js';
import { JobError } from '../jobs/worker.js';
import { canSearchByName } from '../owner.js';
import { runDeepScan } from '../scanner.js';

export function createResearchHandlers({
  db, check, search, monitor, production = false, ownerEmail = null, clock = Date.now, perScan = DEFAULT_LIMITS.perScan,
  pageReader = null, // leest gevonden pagina's zelf (zie research/page-reader.js), of null: staat uit
  ai = null,         // de AI-agent (zie ai/agent.js), of null: er is geen AI ingesteld
}) {
  function loadUser(userId) {
    const row = db.prepare(`
      SELECT id, name, email, created_at, email_confirmed_at, city, blocked_at, phone, phone_verified_at, email_web_at
      FROM users WHERE id = ?`).get(userId);
    if (!row || row.blocked_at || !row.email_confirmed_at) throw new JobError('account_unavailable');
    return { ...row };
  }

  return {
    async deep(job, { progress }) {
      const user = loadUser(job.userId);
      // Het controlepunt, voor elke stap en elke aanvraag: is het onderzoek gestopt? Bestaat het account
      // nog, is het niet geblokkeerd en nog bevestigd? Geeft de gegevens zoals ze NU zijn.
      const checkpoint = () => {
        const by = cancelRequested(db, job.id);
        if (by) throw new JobError(by === 'admin' ? 'cancelled_admin' : 'cancelled');
        return loadUser(job.userId);
      };
      const started = clock();
      const run = await monitor.track('deep', () => runDeepScan({
        db,
        user,
        hibp: check,
        search: perScanLimit(search, perScan), // elke Deep Scan zijn eigen grens
        allowWeb: canSearchByName(user, { production, ownerEmail }),
        now: started,
        onProgress: progress,
        checkpoint,
        pageReader,
        ai,
      }));
      const done = run.steps.filter((step) => step.status === 'done').length;
      logEvent(db, 'deep_scan_done', { done, total: run.steps.length, ms: clock() - started });
      return run;
    },
  };
}
