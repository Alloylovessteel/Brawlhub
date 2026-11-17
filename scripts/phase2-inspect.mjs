import { config as loadEnv } from 'dotenv';
import { createClient } from '@supabase/supabase-js';

loadEnv({ path: '.env' });

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});

async function rows(table, columns) {
  const { data, error } = await db.from(table).select(columns);
  if (error) throw new Error(`${table}: ${error.message}`);
  return data ?? [];
}

async function count(table) {
  const { count, error } = await db.from(table).select('*', { count: 'exact', head: true });
  if (error) throw new Error(`${table}: ${error.message}`);
  return count ?? 0;
}

const tables = [
  'sync_runs',
  'clubs',
  'players',
  'club_memberships',
  'membership_events',
  'club_snapshots',
  'player_snapshots',
  'notifications',
];
const counts = {};
for (const table of tables) counts[table] = await count(table);

const clubs = await rows('clubs', 'id, tag, name, member_count, trophies, required_trophies');
const openMemberships = await rows('club_memberships', 'id, club_id, player_id, valid_to');
const events = await rows('membership_events', 'id, event_type, player_id, from_club_id, to_club_id, source_sync_run_id');
const clubSnapshots = await rows('club_snapshots', 'id, club_id, sync_run_id, member_count, trophies, captured_at, payload_hash');
const syncRuns = await rows('sync_runs', 'id, period_start, status, started_at, finished_at, error, last_error, records_processed, club_tags');
const notifications = await rows('notifications', 'id, event_id, event_type, channel_id, kind, discord_message_id');

const openByClub = {};
for (const club of clubs) {
  openByClub[`${club.tag} (${club.name})`] = openMemberships.filter(
    (membership) => membership.club_id === club.id && membership.valid_to === null,
  ).length;
}

const eventsByType = {};
for (const event of events) {
  eventsByType[event.event_type] = (eventsByType[event.event_type] ?? 0) + 1;
}

const latestClubSnapshots = clubs.map((club) => {
  const snapshots = clubSnapshots
    .filter((snapshot) => snapshot.club_id === club.id)
    .sort((a, b) => String(b.captured_at).localeCompare(String(a.captured_at)));
  const latest = snapshots[0];
  return {
    tag: club.tag,
    name: club.name,
    api_member_count: club.member_count,
    latest_snapshot_member_count: latest?.member_count ?? null,
    snapshot_rows: snapshots.length,
    latest_payload_hash: latest?.payload_hash ?? null,
  };
});

console.log(JSON.stringify({
  counts,
  clubs: clubs.map((club) => ({ tag: club.tag, name: club.name, trophies: club.trophies, required_trophies: club.required_trophies })),
  openMembershipsByClub: openByClub,
  uniquePlayersWithOpenMembership: new Set(openMemberships.filter((m) => m.valid_to === null).map((m) => m.player_id)).size,
  eventsByType,
  latestClubSnapshots,
  playerSnapshotRows: counts.player_snapshots,
  notifications,
  syncRuns: syncRuns.slice(0, 8),
}, null, 2));
