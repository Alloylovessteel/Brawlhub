#!/usr/bin/env node
// Checks Phase 3 RLS policy metadata without modifying database rows.
// Usage: npm run verify:rls

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Client } = pg;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadDotEnv(filePath) {
  const values = {};
  let contents;
  try {
    contents = fs.readFileSync(filePath, 'utf8');
  } catch {
    return values;
  }
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    process.env[match[1]] ??= match[2].trim().replace(/^['"]|['"]$/g, '');
    values[match[1]] = process.env[match[1]];
  }
  return values;
}

loadDotEnv(path.join(ROOT, '.env'));

if (!process.env.DATABASE_URL) {
  console.error('[verify:rls] DATABASE_URL is required.');
  process.exit(1);
}

const client = new Client({ connectionString: process.env.DATABASE_URL });
const failures = [];
function check(condition, message) {
  if (!condition) failures.push(message);
}

try {
  await client.connect();

  const rlsTables = [
    'clubs',
    'players',
    'club_private',
    'club_memberships',
    'membership_events',
    'club_snapshots',
    'player_snapshots',
    'player_battles',
    'sync_runs',
    'notifications',
    'user_roles',
    'audit_logs',
    'sync_locks',
    'guild_settings',
  ];
  const rls = await client.query(
    `SELECT tablename, relrowsecurity
       FROM pg_tables
       JOIN pg_class ON pg_class.relname = pg_tables.tablename
      WHERE schemaname = 'public' AND tablename = ANY($1::text[])`,
    [rlsTables],
  );
  for (const table of rlsTables) {
    check(
      rls.rows.some((row) => row.tablename === table && row.relrowsecurity === true),
      `RLS is not enabled on public.${table}`,
    );
  }

  const policies = await client.query(
    `SELECT tablename, policyname, cmd, qual
       FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = ANY($1::text[])
        AND cmd = 'SELECT'
        AND ('authenticated' = ANY(roles) OR 'PUBLIC' = ANY(roles))`,
    [['membership_events', 'player_snapshots', 'player_battles', 'audit_logs']],
  );
  const eventPolicy = policies.rows.find((row) => row.tablename === 'membership_events');
  check(eventPolicy !== undefined, 'membership_events SELECT policy is missing');
  check(
    eventPolicy === undefined ||
      (!eventPolicy.qual.includes('true') &&
        (eventPolicy.qual.includes('has_club_access') || eventPolicy.qual.includes('is_global_staff'))),
    'membership_events SELECT policy is not club-scoped',
  );

  const auditPolicy = policies.rows.find((row) => row.tablename === 'audit_logs');
  check(auditPolicy !== undefined, 'audit_logs SELECT policy is missing');
  check(
    auditPolicy === undefined || auditPolicy.qual.includes('is_global_owner'),
    'audit_logs SELECT policy is not owner-only',
  );

  const playerAccessFunction = await client.query(
    `SELECT 1
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname = 'has_player_access'
        AND p.pronargs = 2
        AND pg_get_function_identity_arguments(p.oid) LIKE '%uuid%uuid%'`,
  );
  check(playerAccessFunction.rowCount === 1, 'public.has_player_access(uuid, uuid) is missing');

  for (const table of ['player_snapshots', 'player_battles']) {
    const tablePolicies = policies.rows.filter((row) => row.tablename === table);
    check(tablePolicies.length === 1, `${table} must have exactly one client SELECT policy`);
    for (const policy of tablePolicies) {
      const qual = String(policy.qual ?? '');
      check(
        qual.includes('has_player_access') && !/\btrue\b/i.test(qual),
        `${table} SELECT policy is not player-scoped`,
      );
    }
  }

  const grants = await client.query(
    `SELECT table_name, grantee, privilege_type
       FROM information_schema.role_table_grants
      WHERE table_schema = 'public'
        AND table_name = 'sync_locks'
        AND grantee IN ('anon', 'authenticated', 'PUBLIC')`,
  );
  check(grants.rowCount === 0, 'anon/authenticated still have privileges on sync_locks');

  const mutationPolicies = await client.query(
    `SELECT tablename, policyname, cmd
       FROM pg_policies
      WHERE schemaname = 'public'
        AND cmd IN ('INSERT', 'UPDATE', 'DELETE')
        AND ('authenticated' = ANY(roles) OR 'PUBLIC' = ANY(roles))`,
  );
  check(
    mutationPolicies.rowCount === 1 &&
      mutationPolicies.rows[0].tablename === 'profiles' &&
      mutationPolicies.rows[0].cmd === 'INSERT',
    'Unexpected client-side mutation policies found',
  );

  const sourceColumn = await client.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'user_roles' AND column_name = 'source'`,
  );
  check(sourceColumn.rowCount === 1, 'user_roles.source column is missing');

  if (failures.length > 0) {
    console.error('[verify:rls] FAILED:');
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }

  console.log(
    `[verify:rls] OK: ${rlsTables.length} tables have RLS, event/player history is scoped, audit log is owner-only, and service-only grants are intact.`,
  );
} catch (error) {
  console.error('[verify:rls] Database check failed:', error instanceof Error ? error.message : 'unknown error');
  process.exit(1);
} finally {
  await client.end().catch(() => undefined);
}
