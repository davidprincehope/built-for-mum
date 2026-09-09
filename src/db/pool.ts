import pg from 'pg';

let _pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (_pool) return _pool;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set — cannot create pg Pool');
  }

  _pool = new pg.Pool({
    connectionString,
    ssl: { rejectUnauthorized: false },
    max: 10,
    idleTimeoutMillis: 30000,
  });

  _pool.on('error', (err: Error) => {
    // Prevent process crash on idle client error; log to stderr as fallback if pino not yet wired
    console.error('[pg pool idle error]', err.message);
  });

  return _pool;
}

// Singleton default export for ergonomic imports; lazy so env validation still controls boot order
export const pool: pg.Pool = new Proxy({} as pg.Pool, {
  get(_target, prop) {
    const p = getPool() as unknown as Record<string, unknown>;
    const v = p[prop as string];
    if (typeof v === 'function') return (v as (...args: unknown[]) => unknown).bind(p);
    return v;
  },
});

// For tests: allow injecting a mock pool
export function _setPoolForTests(mock: pg.Pool | null): void {
  _pool = mock;
}
