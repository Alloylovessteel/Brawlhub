#!/usr/bin/env node
// BrawlHub migration runner.
// Usage: node scripts/migrate.mjs [--status]
// Requires `pg` (root devDependency) and DATABASE_URL.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Client } = pg;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS_DIR = path.join(ROOT, 'supabase', 'migrations');
const STATUS_ONLY = process.argv.includes('--status');
const BASELINE = process.argv.includes('--baseline');

/** Minimal .env loader; existing environment variables always win. */
function loadDotEnv(filePath) {
  let contents;
  try {
    contents = fs.readFileSync(filePath, 'utf8');
  } catch {
    return;
  }

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;

    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;

    let value = rawValue.trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    } else {
      const commentAt = value.indexOf(' #');
      if (commentAt !== -1) value = value.slice(0, commentAt).trim();
    }
    process.env[key] = value;
  }
}

function readMigrations() {
  if (!fs.existsSync(MIGRATIONS_DIR)) {
    throw new Error(`Migrations directory not found: ${MIGRATIONS_DIR}`);
  }

  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8');
      return {
        version: name.slice(0, -'.sql'.length),
        filename: name,
        checksum: createHash('sha256').update(sql).digest('hex'),
        sql,
      };
    });
}

async function withClient(databaseUrl, fn) {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function readApplied(client) {
  const exists = await client.query(
    "SELECT to_regclass('public.schema_migrations') AS reg"
  );
  if (!exists.rows[0]?.reg) return new Map();

  const { rows } = await client.query(
    'SELECT version, checksum FROM public.schema_migrations'
  );
  return new Map(rows.map((row) => [row.version, row.checksum]));
}

async function ensureMigrationTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS public.schema_migrations (
      version text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

/** Apply one migration and its bookkeeping in a single transaction. */
async function applyMigration(databaseUrl, migration) {
  await withClient(databaseUrl, async (client) => {
    await client.query('BEGIN');
    try {
      await client.query(migration.sql);
      await client.query(
        `INSERT INTO public.schema_migrations (version, checksum)
         VALUES ($1, $2)
         ON CONFLICT (version) DO NOTHING`,
        [migration.version, migration.checksum]
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
  console.log(`[db:migrate] Applied ${migration.filename}`);
}

async function main() {
  loadDotEnv(path.join(ROOT, '.env'));

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is not set (set it in the environment or root .env)');
  }

  const migrations = readMigrations();
  if (migrations.length === 0) {
    console.log('[db] No migration files found.');
    return;
  }

  if (BASELINE) {
    if (STATUS_ONLY) {
      throw new Error('--baseline and --status cannot be used together');
    }
    await withClient(databaseUrl, async (client) => {
      await ensureMigrationTable(client);
      for (const migration of migrations) {
        await client.query(
          `INSERT INTO public.schema_migrations (version, checksum)
           VALUES ($1, $2)
           ON CONFLICT (version) DO UPDATE SET checksum = EXCLUDED.checksum`,
          [migration.version, migration.checksum],
        );
        console.log(`[db:baseline] Marked ${migration.filename} as applied`);
      }
    });
    return;
  }

  if (STATUS_ONLY) {
    await withClient(databaseUrl, async (client) => {
      const applied = await readApplied(client);
      const appliedNames = [];
      const pendingNames = [];
      const changedNames = [];

      for (const migration of migrations) {
        const recorded = applied.get(migration.version);
        if (recorded === undefined) {
          pendingNames.push(migration.filename);
        } else if (recorded !== migration.checksum) {
          changedNames.push(migration.filename);
        } else {
          appliedNames.push(migration.filename);
        }
      }

      console.log(`[db:status] Applied (${appliedNames.length}):`);
      for (const name of appliedNames) console.log(`  - ${name}`);
      console.log(`[db:status] Pending (${pendingNames.length}):`);
      for (const name of pendingNames) console.log(`  - ${name}`);
      if (changedNames.length > 0) {
        console.log(`[db:status] Checksum mismatch (${changedNames.length}):`);
        for (const name of changedNames) console.log(`  - ${name}`);
        process.exitCode = 1;
      }
    });
    return;
  }

  await withClient(databaseUrl, async (client) => {
    await ensureMigrationTable(client);
  });

  const applied = await withClient(databaseUrl, readApplied);
  let appliedCount = 0;

  for (const migration of migrations) {
    const recorded = applied.get(migration.version);
    if (recorded === undefined) {
      await applyMigration(databaseUrl, migration);
      appliedCount += 1;
    } else if (recorded === migration.checksum) {
      console.log(`[db:migrate] Skipping ${migration.filename} (already applied)`);
    } else {
      throw new Error(
        `Checksum mismatch for already-applied migration ${migration.filename}. ` +
          'Create a new migration instead of editing an applied one.'
      );
    }
  }

  console.log(
    appliedCount === 0
      ? '[db:migrate] No pending migrations.'
      : `[db:migrate] Done. ${appliedCount} migration(s) applied.`
  );
}

main().catch((error) => {
  // Log only the message: error objects can contain connection configuration.
  console.error(`[db] Failed: ${error?.message ?? 'Unknown error'}`);
  process.exit(1);
});
