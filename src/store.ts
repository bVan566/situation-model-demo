import { DatabaseSync } from 'node:sqlite';
import type { ActionAttempt, AttemptStatus, HistoryEntry, Item, ItemState } from './domain.ts';

// Persistence for the Situation Model (SQLite via node:sqlite, no ORM).
// Items, their append-only history, and the ledger of external action attempts.

export class Store {
  readonly db: DatabaseSync;

  constructor(path = ':memory:') {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS items (
        id TEXT PRIMARY KEY,
        summary TEXT NOT NULL,
        source_event TEXT NOT NULL,
        state TEXT NOT NULL,
        owner TEXT NOT NULL,
        next_action TEXT NOT NULL,
        trigger TEXT NOT NULL DEFAULT '',
        action_type TEXT NOT NULL,
        authority TEXT NOT NULL,
        approval_status TEXT NOT NULL,
        approved_by TEXT,
        approved_action_type TEXT,
        action_status TEXT NOT NULL DEFAULT 'none',
        terminal_condition TEXT NOT NULL,
        closed_reason TEXT,
        classifier TEXT NOT NULL,
        classifier_rationale TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_verified_at TEXT,
        CHECK (owner <> '' AND next_action <> '')
      );
      CREATE TABLE IF NOT EXISTS history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id TEXT NOT NULL REFERENCES items(id),
        kind TEXT NOT NULL,
        from_state TEXT,
        to_state TEXT,
        actor TEXT NOT NULL,
        detail TEXT NOT NULL,
        at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id TEXT NOT NULL REFERENCES items(id),
        idempotency_key TEXT NOT NULL UNIQUE,
        action_type TEXT NOT NULL,
        status TEXT NOT NULL,
        detail TEXT NOT NULL DEFAULT '',
        started_at TEXT NOT NULL,
        finished_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_history_item ON history(item_id);
      CREATE INDEX IF NOT EXISTS idx_attempts_item ON attempts(item_id);
    `);
  }

  nextItemId(): string {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM items').get() as { n: number };
    return `SIT-${String(Number(row.n) + 1).padStart(4, '0')}`;
  }

  insertItem(item: Item): void {
    const cols = Object.keys(item);
    this.db
      .prepare(`INSERT INTO items (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
      .run(...(Object.values(item) as (string | null)[]));
  }

  updateItem(id: string, patch: Partial<Item>): void {
    const cols = Object.keys(patch);
    if (cols.length === 0) return;
    this.db
      .prepare(`UPDATE items SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`)
      .run(...(Object.values(patch) as (string | null)[]), id);
  }

  getItem(id: string): Item | null {
    return (this.db.prepare('SELECT * FROM items WHERE id = ?').get(id) as unknown as Item) ?? null;
  }

  listItems(): Item[] {
    return this.db.prepare('SELECT * FROM items ORDER BY created_at, id').all() as unknown as Item[];
  }

  addHistory(e: Omit<HistoryEntry, 'id'>): void {
    this.db
      .prepare('INSERT INTO history (item_id, kind, from_state, to_state, actor, detail, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(e.item_id, e.kind, e.from_state, e.to_state, e.actor, e.detail, e.at);
  }

  history(itemId: string): HistoryEntry[] {
    return this.db.prepare('SELECT * FROM history WHERE item_id = ? ORDER BY id').all(itemId) as unknown as HistoryEntry[];
  }

  countHistory(kind: string): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM history WHERE kind = ?').get(kind) as { n: number };
    return Number(row.n);
  }

  insertAttempt(a: Omit<ActionAttempt, 'id'>): void {
    this.db
      .prepare('INSERT INTO attempts (item_id, idempotency_key, action_type, status, detail, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(a.item_id, a.idempotency_key, a.action_type, a.status, a.detail, a.started_at, a.finished_at);
  }

  updateAttempt(key: string, status: AttemptStatus, detail: string, finishedAt: string | null): void {
    this.db
      .prepare('UPDATE attempts SET status = ?, detail = ?, finished_at = ? WHERE idempotency_key = ?')
      .run(status, detail, finishedAt, key);
  }

  attempts(itemId: string): ActionAttempt[] {
    return this.db.prepare('SELECT * FROM attempts WHERE item_id = ? ORDER BY id').all(itemId) as unknown as ActionAttempt[];
  }

  countByState(): Record<ItemState, number> {
    const out: Record<string, number> = { NOW: 0, NEXT: 0, WAITING: 0, DECISIONS: 0, WATCHING: 0, CLOSED: 0 };
    for (const r of this.db.prepare('SELECT state, COUNT(*) AS n FROM items GROUP BY state').all() as { state: string; n: number }[]) {
      out[r.state] = Number(r.n);
    }
    return out as Record<ItemState, number>;
  }

  /** Runs fn inside a transaction so an item update and its history entry land together. */
  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  reset(): void {
    this.db.exec('DELETE FROM history; DELETE FROM attempts; DELETE FROM items;');
  }
}
