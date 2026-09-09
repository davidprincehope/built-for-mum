import * as fs from 'fs';
import * as path from 'path';
import pg from 'pg';

function getDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required to run migrations');
  return url;
}

export async function runMigrations(): Promise<string[]> {
  const url = getDatabaseUrl();
  const pool = new pg.Pool({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
    max: 2,
  });
  pool.on('error', (err) => console.error('[migrate pool error]', err.message));

  try {
    // Ensure migrations tracking table exists (also created by 003, but ensure early)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const migrationsDir = path.resolve(__dirname, '../../migrations');
    const altDir = path.resolve(process.cwd(), 'migrations');
    const dir = fs.existsSync(migrationsDir) ? migrationsDir : altDir;

    if (!fs.existsSync(dir)) {
      console.log(`[migrate] no migrations directory at ${dir} — nothing to do`);
      return [];
    }

    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    const { rows } = await pool.query<{ filename: string }>('SELECT filename FROM schema_migrations');
    const applied = new Set(rows.map((r) => r.filename));

    const newlyApplied: string[] = [];

    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = fs.readFileSync(path.join(dir, file), 'utf-8');
      console.log(`[migrate] applying ${file}...`);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
        await client.query('COMMIT');
        newlyApplied.push(file);
        console.log(`[migrate] applied ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    }

    if (newlyApplied.length === 0) {
      console.log('[migrate] 0 new migrations — already up to date');
    } else {
      console.log(`[migrate] done — ${newlyApplied.length} migration(s) applied`);
    }

    return newlyApplied;
  } finally {
    await pool.end();
  }
}

// CLI entrypoint: `npm run migrate` / `npx tsx src/db/migrate.ts`
const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith('migrate.ts') || process.argv[1].endsWith('migrate.js'));
if (isMain) {
  runMigrations()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[migrate] failed:', err);
      process.exit(1);
    });
}
