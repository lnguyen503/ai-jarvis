import type { DbHandle, Statement } from './dbDriver.js';

export interface MemoryEntry {
  id: number;
  key: string;
  value: string;
  category: 'preference' | 'fact' | 'note';
  created_at: string;
  updated_at: string;
}

export class MemoryRepo {
  private readonly stmtUpsert: Statement;
  private readonly stmtGet: Statement;
  private readonly stmtList: Statement;
  private readonly stmtDelete: Statement;

  constructor(private readonly db: DbHandle) {
    this.stmtUpsert = db.prepare(
      `INSERT INTO memory (key, value, category) VALUES (@key, @value, @category)
       ON CONFLICT(category, key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
    );
    this.stmtGet = db.prepare(
      `SELECT * FROM memory WHERE category = ? AND key = ?`,
    );
    this.stmtList = db.prepare(
      `SELECT * FROM memory WHERE category = ? ORDER BY key ASC`,
    );
    this.stmtDelete = db.prepare(
      `DELETE FROM memory WHERE category = ? AND key = ?`,
    );
  }

  upsert(category: MemoryEntry['category'], key: string, value: string): void {
    this.stmtUpsert.run({ key, value, category });
  }

  get(category: MemoryEntry['category'], key: string): MemoryEntry | undefined {
    return this.stmtGet.get(category, key) as MemoryEntry | undefined;
  }

  list(category: MemoryEntry['category']): MemoryEntry[] {
    return this.stmtList.all(category) as MemoryEntry[];
  }

  delete(category: MemoryEntry['category'], key: string): void {
    this.stmtDelete.run(category, key);
  }
}
