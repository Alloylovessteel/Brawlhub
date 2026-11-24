import type { HistorySeries } from '@/components/charts/history-chart-data';
import { getAccessibleReadClubIds, requirePageSession } from '@/lib/auth/session';
import {
  getAllClubSnapshots,
  getAllPlayerSnapshots,
  getClubs,
  getPlayers,
  getSnapshotCollectionStart,
} from '@/lib/data/queries';
import type { ClubRow, PlayerRow } from '@/lib/data/types';
import { buildClubSeries, buildPlayerSeries } from './history-data';

export const RANGES = [
  { value: '7', label: 'Last 7 days', days: 7 },
  { value: '30', label: 'Last 30 days', days: 30 },
  { value: '90', label: 'Last 90 days', days: 90 },
  { value: 'all', label: 'All collected history', days: undefined },
] as const;

export type HistoryParams = {
  range?: string | string[];
  club?: string | string[];
  player?: string | string[];
};

export interface HistoryViewModel {
  range: (typeof RANGES)[number];
  clubs: ClubRow[];
  players: PlayerRow[];
  clubId: string | undefined;
  playerId: string | undefined;
  selectedPlayer: PlayerRow | undefined;
  clubSnapshots: number;
  playerSnapshots: number;
  collectionStart: string | null;
  clubSnapshotError: string | null;
  playerSnapshotError: string | null;
  clubTrophySeries: HistorySeries[];
  memberSeries: HistorySeries[];
  playerTrophySeries: HistorySeries[];
}

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function selectedRange(value: string | string[] | undefined): (typeof RANGES)[number] {
  const raw = firstValue(value);
  return RANGES.find((range) => range.value === raw) ?? RANGES[3]!;
}

/** Resolves all history-page inputs and chart series before rendering. */
export async function loadHistoryViewModel(params: HistoryParams): Promise<HistoryViewModel> {
  const session = await requirePageSession();
  const scope = getAccessibleReadClubIds(session);
  const scopeOptions = scope === null ? {} : { allowedClubIds: [...scope] };
  const clubScopeOptions = scope === null ? {} : { clubIds: [...scope] };
  const range = selectedRange(params.range);
  const clubParam = firstValue(params.club);
  const playerParam = firstValue(params.player);

  const clubs = await getClubs({ page: 1, pageSize: 100, ...clubScopeOptions });
  const clubId =
    clubParam !== undefined && clubs.rows.some((club) => club.id === clubParam) ? clubParam : undefined;
  const selectedClubScopes = clubId === undefined ? clubScopeOptions : { clubIds: [clubId] };

  // The player list follows the selected club, so an unrelated player cannot
  // be selected or kept selected when the club filter changes.
  const players = await getPlayers({
    page: 1,
    pageSize: 100,
    ...scopeOptions,
    ...(clubId === undefined ? {} : { clubId }),
  });
  const playerId =
    playerParam !== undefined && players.rows.some((player) => player.id === playerParam)
      ? playerParam
      : undefined;
  const selectedPlayer = players.rows.find((player) => player.id === playerId);

  const [clubSnapshots, playerSnapshots, collectionStart] = await Promise.all([
    getAllClubSnapshots(range.days, selectedClubScopes),
    getAllPlayerSnapshots(range.days, {
      ...selectedClubScopes,
      playerIds: playerId === undefined ? [] : [playerId],
    }),
    getSnapshotCollectionStart(clubScopeOptions),
  ]);

  const chartClubs = clubId === undefined ? clubs.rows : clubs.rows.filter((club) => club.id === clubId);
  return {
    range,
    clubs: clubs.rows,
    players: players.rows,
    clubId,
    playerId,
    selectedPlayer,
    clubSnapshots: clubSnapshots.rows.length,
    playerSnapshots: playerSnapshots.rows.length,
    collectionStart: collectionStart.capturedAt,
    clubSnapshotError: clubSnapshots.error,
    playerSnapshotError: playerSnapshots.error,
    clubTrophySeries: buildClubSeries(
      clubSnapshots.rows,
      chartClubs,
      (snapshot) => snapshot.trophies,
    ),
    memberSeries: buildClubSeries(
      clubSnapshots.rows,
      chartClubs,
      (snapshot) => snapshot.member_count,
    ),
    playerTrophySeries: buildPlayerSeries(playerSnapshots.rows, selectedPlayer),
  };
}
