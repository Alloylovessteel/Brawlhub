export interface ClubRow {
  id: string;
  tag: string;
  name: string;
  description: string | null;
  badge_id: number | null;
  trophies: number | null;
  required_trophies: number | null;
  member_count: number | null;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface PlayerRow {
  id: string;
  tag: string;
  name: string;
  trophies: number | null;
  highest_trophies: number | null;
  exp_level: number | null;
  power_points: number | null;
  victories: number | null;
  solo_victories: number | null;
  team_victories: number | null;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ClubRef {
  id: string;
  tag: string;
  name: string;
  badge_id: number | null;
}

export interface PlayerRef {
  id: string;
  tag: string;
  name: string;
  trophies: number | null;
}

export interface MembershipRow {
  id: string;
  club_id: string;
  player_id: string;
  role: string | null;
  valid_from: string;
  valid_to: string | null;
  club?: ClubRef;
  player?: PlayerRef;
}

export interface MembershipEventRow {
  id: string;
  player_id: string;
  from_club_id: string | null;
  to_club_id: string | null;
  event_type: 'join' | 'leave' | 'transfer';
  detected_at: string;
  player?: PlayerRef;
  from_club?: ClubRef;
  to_club?: ClubRef;
}

export interface ClubSnapshotRow {
  id: string;
  club_id: string;
  sync_run_id: string;
  captured_at: string;
  trophies: number | null;
  member_count: number | null;
  payload_hash: string;
}

export interface PlayerSnapshotRow {
  id: string;
  player_id: string;
  sync_run_id: string;
  captured_at: string;
  trophies: number | null;
  payload_hash: string;
}

export interface SyncRunRow {
  id: string;
  scope: string;
  period_start: string;
  status: 'running' | 'completed' | 'failed';
  started_at: string;
  finished_at: string | null;
  error: string | null;
  last_error: string | null;
  records_processed: number;
  affected_club_ids: string[];
  club_tags: string[];
}

export interface NotificationRow {
  id: string;
  event_id: string | null;
  event_type: string | null;
  channel_id: string | null;
  kind: string | null;
  discord_message_id: string | null;
  created_at: string;
}

export interface QueryResult<T> {
  rows: T[];
  count: number;
  error: string | null;
}
