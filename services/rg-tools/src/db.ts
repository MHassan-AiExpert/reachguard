import pg from 'pg';

export interface QueryResult<T = Record<string, unknown>> {
  rows: T[];
  rowCount: number | null;
}

export interface Db {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
  /** Runs fn on one connection inside BEGIN/COMMIT, rolling back if it throws. Nested calls join the open transaction. */
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
}

export function createPool(connectionString: string): Db & { end(): Promise<void> } {
  const pool = new pg.Pool({ connectionString, max: 10 });
  return {
    query: (text, params) => pool.query(text, params as unknown[]) as never,
    async tx(fn) {
      const client = await pool.connect();
      const inner: Db = {
        query: (text, params) => client.query(text, params as unknown[]) as never,
        tx: (f) => f(inner),
      };
      try {
        await client.query('BEGIN');
        const result = await fn(inner);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    },
    end: () => pool.end(),
  };
}
