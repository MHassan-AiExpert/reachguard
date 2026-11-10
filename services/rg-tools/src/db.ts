import pg from 'pg';

export interface QueryResult<T = Record<string, unknown>> {
  rows: T[];
  rowCount: number | null;
}

export interface Db {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
}

export function createPool(connectionString: string): Db & { end(): Promise<void> } {
  const pool = new pg.Pool({ connectionString, max: 10 });
  return {
    query: (text, params) => pool.query(text, params as unknown[]) as never,
    end: () => pool.end(),
  };
}
