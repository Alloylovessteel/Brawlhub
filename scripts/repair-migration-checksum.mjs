#!/usr/bin/env node
// Guarded one-row checksum repair for the briefly edited 0051 migration.
//
// Usage:
//   node scripts/repair-migration-checksum.mjs            # read-only preflight
//   node scripts/repair-migration-checksum.mjs --apply    # guarded repair
//
// Requires `pg` (root devDependency) and DATABASE_URL. This script never runs
// migration SQL, never touches any version except 0051, and is not a substitute
// for a backup. Use `npm run db:status` before and after.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Client } = pg;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = '0051_report_delivery_bounds_and_pages';
const PUBLISHED_CHECKSUM =
  '1e5161bd9517a0964ea8be005f41d662e3ce5b32800e08a12e6eefd80d0729eb';
const EDITED_CHECKSUM =
  '6980376f866ef9664c7845de912ba97bc1b1b6b3902e50e8be3a50dec3ec2e92';
const APPLY = process.argv.includes('--apply');

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

function expectedTargetChecksum() {
  const file = path.join(ROOT, 'supabase', 'migrations', `${VERSION}.sql`);
  const sql = fs.readFileSync(file, 'utf8');
  return createHash('sha256').update(sql).digest('hex');
}

async function preflight(client, targetChecksum) {
  const ledger = await client.query(
    "SELECT to_regclass('public.schema_migrations') AS reg"
  );
  if (ledger.rows[0]?.reg === null || ledger.rows[0]?.reg === undefined) {
    throw new Error('public.schema_migrations does not exist; no repair was performed');
  }

  const rowResult = await client.query(
    'SELECT version, checksum, applied_at FROM public.schema_migrations WHERE version = $1',
    [VERSION]
  );
  const row = rowResult.rows[0];
  if (!row) {
    throw new Error(
      `No ${VERSION} row is recorded. Run db:migrate to apply the published migration; no repair was performed`
    );
  }
  if (row.checksum === targetChecksum) {
    return { status: 'current', row };
  }
  if (row.checksum !== EDITED_CHECKSUM) {
    throw new Error(
      `Unknown ${VERSION} checksum ${row.checksum}. Stop and investigate; no repair was performed`
    );
  }

  const related = await client.query(
    `SELECT version, checksum
       FROM public.schema_migrations
      WHERE version IN ('0046_security_definer_role_helper', '0050_legacy_oauth_shadow_recovery')`
  );
  const relatedVersions = new Set(related.rows.map((item) => item.version));
  for (const required of [
    '0046_security_definer_role_helper',
    '0050_legacy_oauth_shadow_recovery',
  ]) {
    if (!relatedVersions.has(required)) {
      throw new Error(`Required ledger row ${required} is missing; no repair was performed`);
    }
  }

  const tables = await client.query(
    `SELECT to_regclass('public.guild_settings') AS guild_settings,
            to_regclass('public.guild_report_posts') AS guild_report_posts`
  );
  if (!tables.rows[0]?.guild_settings || !tables.rows[0]?.guild_report_posts) {
    throw new Error('Required 0051 tables are missing; no repair was performed');
  }

  const column = await client.query(
    `SELECT data_type
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'guild_settings'
        AND column_name = 'reports_enabled_at'`
  );
  if (column.rows[0]?.data_type !== 'timestamp with time zone') {
    throw new Error(
      'guild_settings.reports_enabled_at is missing or not timestamptz; no repair was performed'
    );
  }

  const trigger = await client.query(
    `SELECT 1
       FROM pg_trigger
      WHERE tgrelid = 'public.guild_settings'::regclass
        AND tgname = 'guild_settings_touch_reports_enabled_at'
        AND NOT tgisinternal`
  );
  if (trigger.rowCount === 0) {
    throw new Error('0051 reports_enabled_at trigger is missing; no repair was performed');
  }

  const expectedFunctions = [
    'public.touch_guild_reports_enabled_at()',
    'public.report_ledger_message_is_delivered(text)',
    'public.push_missing_report_deliveries(jsonb,integer,text,text,text)',
    'public.push_missing_inactivity_deliveries(text,integer,text)',
    'public.push_report_clubs(text,integer,text,uuid)',
    'public.push_report_activity(text,timestamp with time zone,timestamp with time zone,integer,uuid)',
    'public.push_report_activity_totals(text,timestamp with time zone,timestamp with time zone)',
  ];
  for (const signature of expectedFunctions) {
    const found = await client.query('SELECT to_regprocedure($1) AS reg', [signature]);
    if (found.rows[0]?.reg === null || found.rows[0]?.reg === undefined) {
      throw new Error(`Expected 0051 function ${signature} is missing; no repair was performed`);
    }
  }

  return { status: 'repairable', row };
}

async function main() {
  loadDotEnv(path.join(ROOT, '.env'));

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is not set (set it in the environment or root .env)');
  }

  const targetChecksum = expectedTargetChecksum();
  if (targetChecksum !== PUBLISHED_CHECKSUM) {
    throw new Error(
      `Tracked ${VERSION}.sql hashes to ${targetChecksum}, expected ${PUBLISHED_CHECKSUM}. Stop and investigate; no repair was performed`
    );
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const result = await preflight(client, targetChecksum);
    if (result.status === 'current') {
      console.log('[db:repair] 0051 already records the published checksum; no repair needed');
      return;
    }

    console.log(
      `[db:repair] Preflight passed: ${VERSION} records the edited checksum and the expected 0051 schema objects exist`
    );
    if (!APPLY) {
      console.log('[db:repair] Dry run only; pass --apply to update the single ledger row');
      return;
    }

    await client.query('BEGIN');
    try {
      const update = await client.query(
        `UPDATE public.schema_migrations
            SET checksum = $1
          WHERE version = $2
            AND checksum = $3`,
        [targetChecksum, VERSION, EDITED_CHECKSUM]
      );
      if (update.rowCount !== 1) {
        throw new Error('Guarded 0051 checksum update matched no row; rolled back');
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }

    console.log('[db:repair] Repaired the 0051 ledger checksum; run db:status and db:migrate next');
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(`[db:repair] ${error instanceof Error ? error.message : 'Unknown error'}`);
  process.exitCode = 1;
});
