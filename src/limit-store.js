// Bewaart de tellers van express-rate-limit in de database in plaats van in
// het geheugen. Zo blijft een pauze gelden, ook als de server tussendoor
// herstart.
//
// De sleutels (IP-adressen en e-mailadressen) slaan we gehasht op, zodat er in
// de database geen leesbaar lijstje staat van wie het heeft geprobeerd.
import { createHash } from 'node:crypto';

function hashKey(prefix, key) {
  return createHash('sha256').update(prefix + key).digest('hex');
}

export class SqliteStore {
  constructor(db, prefix) {
    this.db = db;
    this.prefix = prefix;   // houdt de tellers van verschillende limieten uit elkaar
    this.localKeys = false; // de tellers staan in de database, niet in dit object
  }

  // express-rate-limit roept dit één keer aan, met onder meer windowMs.
  init(options) {
    this.windowMs = options.windowMs;
  }

  get(key) {
    const row = this.db
      .prepare('SELECT hits, reset_at FROM rate_limits WHERE id = ? AND reset_at > ?')
      .get(hashKey(this.prefix, key), Date.now());
    return row ? { totalHits: row.hits, resetTime: new Date(row.reset_at) } : undefined;
  }

  increment(key) {
    const now = Date.now();
    this.db.prepare('DELETE FROM rate_limits WHERE reset_at <= ?').run(now); // verlopen tellers opruimen

    const current = this.get(key);
    if (current) {
      this.db.prepare('UPDATE rate_limits SET hits = hits + 1 WHERE id = ?')
        .run(hashKey(this.prefix, key));
      return { totalHits: current.totalHits + 1, resetTime: current.resetTime };
    }

    const resetAt = now + this.windowMs;
    this.db.prepare('INSERT INTO rate_limits (id, hits, reset_at) VALUES (?, 1, ?)')
      .run(hashKey(this.prefix, key), resetAt);
    return { totalHits: 1, resetTime: new Date(resetAt) };
  }

  decrement(key) {
    this.db.prepare('UPDATE rate_limits SET hits = MAX(hits - 1, 0) WHERE id = ?')
      .run(hashKey(this.prefix, key));
  }

  resetKey(key) {
    this.db.prepare('DELETE FROM rate_limits WHERE id = ?').run(hashKey(this.prefix, key));
  }
}
