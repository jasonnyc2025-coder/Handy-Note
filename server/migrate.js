// Lightweight forward-only migration runner.
//
// On startup the server calls runMigrations(pool). Every *.sql file in
// ./migrations is applied once, in filename order, inside a transaction, and
// recorded in the schema_migrations table so it never runs again. Adding a new
// schema change is just: drop a new NNN_name.sql file in ./migrations and
// redeploy — it applies automatically, on both fresh and existing databases.
const fs = require('fs');
const path = require('path');

// A fixed key so concurrent server starts serialize instead of racing.
const LOCK_KEY = 8172531; // arbitrary, app-specific

async function runMigrations(pool) {
  const dir = path.join(__dirname, 'migrations');
  if (!fs.existsSync(dir)) {
    console.log('[migrate] no migrations directory, skipping');
    return;
  }
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();

  const client = await pool.connect();
  try {
    // Serialize migration runs across instances/restarts.
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name        TEXT PRIMARY KEY,
        applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    const done = new Set(
      (await client.query('SELECT name FROM schema_migrations')).rows.map(r => r.name)
    );

    for (const file of files) {
      if (done.has(file)) continue;
      const sql = fs.readFileSync(path.join(dir, file), 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        console.log('[migrate] applied', file);
      } catch (err) {
        await client.query('ROLLBACK');
        console.error('[migrate] FAILED', file, '-', err.message);
        throw err;
      }
    }
    console.log('[migrate] up to date (' + files.length + ' migration(s))');
  } finally {
    try { await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]); } catch {}
    client.release();
  }
}

module.exports = { runMigrations };
