import { DatabaseSync } from 'node:sqlite';

// A deliberately simulated downstream system ("dispatch service"): it sends replies,
// issues refunds, restarts services, etc. It keeps its OWN database, separate from the
// Situation Model, so the two can genuinely disagree. It is the authoritative source
// of truth for whether a side effect happened.

export type ExternalStatus = 'succeeded' | 'failed' | 'pending';

export type ExternalFault = 'none' | 'external_failure' | 'external_timeout';

export interface ExternalRecord {
  idempotency_key: string;
  item_id: string;
  action_type: string;
  status: ExternalStatus;
  error: string | null;
  /** how many times the real-world side effect was applied for this key (should never exceed 1) */
  side_effects: number;
  submissions: number;
  polls_until_settled: number;
  created_at: string;
  completed_at: string | null;
}

export class ExternalTimeoutError extends Error {
  constructor(key: string) {
    super(`dispatch service did not respond in time for ${key}`);
    this.name = 'ExternalTimeoutError';
  }
}

export interface DispatchOptions {
  /** status polls a timed-out request needs before it settles to success */
  pendingPolls?: number;
  now?: () => Date;
}

export class DispatchService {
  readonly db: DatabaseSync;
  private readonly pendingPolls: number;
  private readonly now: () => Date;

  constructor(path = ':memory:', opts: DispatchOptions = {}) {
    this.db = new DatabaseSync(path);
    this.pendingPolls = opts.pendingPolls ?? 1;
    this.now = opts.now ?? (() => new Date());
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ext_actions (
        idempotency_key TEXT PRIMARY KEY,
        item_id TEXT NOT NULL,
        action_type TEXT NOT NULL,
        status TEXT NOT NULL,
        error TEXT,
        side_effects INTEGER NOT NULL DEFAULT 0,
        submissions INTEGER NOT NULL DEFAULT 1,
        polls_until_settled INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        completed_at TEXT
      );`);
  }

  /**
   * Submit an action. Honors idempotency keys: re-submitting a known key returns the
   * existing record and never re-applies the side effect.
   */
  async submit(key: string, itemId: string, actionType: string, fault: ExternalFault = 'none'): Promise<ExternalRecord> {
    const existing = this.get(key);
    if (existing) {
      this.db.prepare('UPDATE ext_actions SET submissions = submissions + 1 WHERE idempotency_key = ?').run(key);
      return this.get(key)!;
    }
    const ts = this.now().toISOString();
    const insert = this.db.prepare(`INSERT INTO ext_actions
      (idempotency_key, item_id, action_type, status, error, side_effects, polls_until_settled, created_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);

    if (fault === 'external_failure') {
      insert.run(key, itemId, actionType, 'failed', 'downstream rejected the request (simulated HTTP 503)', 0, 0, ts, ts);
      return this.get(key)!;
    }
    if (fault === 'external_timeout') {
      // Accepted but not finished; the caller gets no answer.
      insert.run(key, itemId, actionType, 'pending', null, 0, this.pendingPolls, ts, null);
      throw new ExternalTimeoutError(key);
    }
    insert.run(key, itemId, actionType, 'succeeded', null, 1, 0, ts, ts);
    return this.get(key)!;
  }

  /** Authoritative status read. Pending actions settle to success after N polls. */
  async status(key: string): Promise<ExternalRecord | null> {
    const rec = this.get(key);
    if (!rec || rec.status !== 'pending') return rec;
    if (rec.polls_until_settled <= 1) {
      this.db.prepare(`UPDATE ext_actions SET status = 'succeeded', side_effects = side_effects + 1,
        polls_until_settled = 0, completed_at = ? WHERE idempotency_key = ?`).run(this.now().toISOString(), key);
    } else {
      this.db.prepare('UPDATE ext_actions SET polls_until_settled = polls_until_settled - 1 WHERE idempotency_key = ?').run(key);
    }
    return this.get(key);
  }

  get(key: string): ExternalRecord | null {
    return (this.db.prepare('SELECT * FROM ext_actions WHERE idempotency_key = ?').get(key) as unknown as ExternalRecord) ?? null;
  }

  list(itemId?: string): ExternalRecord[] {
    const rows = itemId
      ? this.db.prepare('SELECT * FROM ext_actions WHERE item_id = ? ORDER BY created_at').all(itemId)
      : this.db.prepare('SELECT * FROM ext_actions ORDER BY created_at').all();
    return rows as unknown as ExternalRecord[];
  }

  /** Total side effects applied per item; >1 would mean a duplicate real-world action. */
  sideEffectsByItem(): Map<string, number> {
    const rows = this.db.prepare('SELECT item_id, SUM(side_effects) AS n FROM ext_actions GROUP BY item_id').all() as { item_id: string; n: number }[];
    return new Map(rows.map((r) => [r.item_id, Number(r.n)]));
  }

  reset(): void {
    this.db.exec('DELETE FROM ext_actions');
  }
}
