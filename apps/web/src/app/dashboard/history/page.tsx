import { HistoryChart, type HistoryPoint } from '@/components/charts/history-chart';
import { PageHeader } from '@/components/dashboard/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Select } from '@/components/ui/input';
import { getAccessibleReadClubIds, requirePageSession } from '@/lib/auth/session';
import {
  getAllClubSnapshots,
  getAllPlayerSnapshots,
  getClubs,
  getPlayers,
} from '@/lib/data/queries';
import { formatDateTime } from '@/lib/utils';

export const dynamic = 'force-dynamic';

const RANGES = [
  { value: '7', label: 'Last 7 days', days: 7 },
  { value: '30', label: 'Last 30 days', days: 30 },
  { value: '90', label: 'Last 90 days', days: 90 },
  { value: 'all', label: 'All collected history', days: undefined },
] as const;

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function selectedRange(value: string | string[] | undefined): (typeof RANGES)[number] {
  const raw = firstValue(value);
  return RANGES.find((range) => range.value === raw) ?? RANGES[3]!;
}

function groupSnapshots<T>(
  rows: T[],
  capturedAt: (row: T) => string,
  value: (row: T) => number | null,
): HistoryPoint[] {
  const points = new Map<string, number>();
  for (const row of rows) {
    const snapshotValue = value(row);
    if (snapshotValue === null) continue;
    const time = capturedAt(row);
    points.set(time, (points.get(time) ?? 0) + snapshotValue);
  }
  return [...points.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([time, total]) => ({ label: formatDateTime(time), value: total }));
}

export default async function HistoryPage({
  searchParams,
}: Readonly<{
  searchParams: Promise<{ range?: string | string[]; club?: string | string[]; player?: string | string[] }>;
}>) {
  const session = await requirePageSession();
  const scope = getAccessibleReadClubIds(session);
  const scopeOptions = scope === null ? {} : { allowedClubIds: [...scope] };
  const clubScopeOptions = scope === null ? {} : { clubIds: [...scope] };
  const params = await searchParams;
  const range = selectedRange(params.range);
  const clubParam = firstValue(params.club);
  const playerParam = firstValue(params.player);

  const [clubs, players] = await Promise.all([
    getClubs({ page: 1, pageSize: 100, ...clubScopeOptions }),
    getPlayers({ page: 1, pageSize: 100, ...scopeOptions }),
  ]);
  const clubId =
    clubParam !== undefined && clubs.rows.some((club) => club.id === clubParam) ? clubParam : undefined;
  const playerId =
    playerParam !== undefined && players.rows.some((player) => player.id === playerParam)
      ? playerParam
      : undefined;

  const [clubSnapshots, playerSnapshots] = await Promise.all([
    getAllClubSnapshots(range.days, clubScopeOptions),
    getAllPlayerSnapshots(range.days, clubScopeOptions),
  ]);

  const relevantClubSnapshots = clubId === undefined
    ? clubSnapshots.rows
    : clubSnapshots.rows.filter((snapshot) => snapshot.club_id === clubId);
  const relevantPlayerSnapshots = playerId === undefined
    ? []
    : playerSnapshots.rows.filter((snapshot) => snapshot.player_id === playerId);

  const trophyData = groupSnapshots(
    relevantClubSnapshots,
    (snapshot) => snapshot.captured_at,
    (snapshot) => snapshot.trophies,
  );
  const memberData = groupSnapshots(
    relevantClubSnapshots,
    (snapshot) => snapshot.captured_at,
    (snapshot) => snapshot.member_count,
  );
  const playerTrophyData = groupSnapshots(
    relevantPlayerSnapshots,
    (snapshot) => snapshot.captured_at,
    (snapshot) => snapshot.trophies,
  );

  const firstCollection = [
    clubSnapshots.rows[0]?.captured_at,
    playerSnapshots.rows[0]?.captured_at,
  ].filter((value): value is string => value !== undefined).sort()[0];

  return (
    <>
      <PageHeader
        title="Historical data"
        description="Snapshot-only charts. Every plotted point comes from a stored sync snapshot; no values are interpolated or simulated."
      />

      <Card className="mb-5">
        <CardContent className="pt-5">
          <form method="get" className="flex flex-wrap items-end gap-3">
            <div>
              <label htmlFor="range" className="muted-text mb-1.5 block text-xs font-semibold uppercase tracking-wider">
                Time range
              </label>
              <Select id="range" name="range" defaultValue={range.value} className="min-w-48">
                {RANGES.map((item) => (
                  <option key={item.value} value={item.value}>
                    {item.label}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <label htmlFor="club" className="muted-text mb-1.5 block text-xs font-semibold uppercase tracking-wider">
                Club scope
              </label>
              <Select id="club" name="club" defaultValue={clubId ?? ''} className="min-w-52">
                <option value="">All clubs</option>
                {clubs.rows.map((club) => (
                  <option key={club.id} value={club.id}>
                    {club.name}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <label htmlFor="player" className="muted-text mb-1.5 block text-xs font-semibold uppercase tracking-wider">
                Player progression
              </label>
              <Select id="player" name="player" defaultValue={playerId ?? ''} className="min-w-52">
                <option value="">Select a player</option>
                {players.rows.map((player) => (
                  <option key={player.id} value={player.id}>
                    {player.name}
                  </option>
                ))}
              </Select>
            </div>
            <Button type="submit">Update charts</Button>
          </form>
        </CardContent>
      </Card>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Badge variant="neutral">{range.label}</Badge>
        <Badge variant="neutral">{relevantClubSnapshots.length} club snapshots</Badge>
        <Badge variant="neutral">{relevantPlayerSnapshots.length} player snapshots</Badge>
        {firstCollection === undefined ? null : (
          <span className="muted-text text-xs">
            Historical collection began {formatDateTime(firstCollection)}.
          </span>
        )}
      </div>

      {clubSnapshots.error === null ? null : (
        <p className="mb-4 rounded-lg border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger">
          Club snapshot query failed: {clubSnapshots.error}
        </p>
      )}
      {playerSnapshots.error === null ? null : (
        <p className="mb-4 rounded-lg border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger">
          Player snapshot query failed: {playerSnapshots.error}
        </p>
      )}

      <section className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Club trophy progression</CardTitle>
            <CardDescription>
              {clubId === undefined ? 'Combined trophies across all clubs at each captured timestamp.' : 'Actual snapshots for the selected club.'}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {trophyData.length === 0 ? (
              <p className="muted-text py-10 text-center text-sm">No snapshots in this range.</p>
            ) : (
              <HistoryChart data={trophyData} valueLabel="Club trophies" color="#7c96ff" />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Historical member count</CardTitle>
            <CardDescription>
              Membership growth measured only where club snapshots were stored.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {memberData.length === 0 ? (
              <p className="muted-text py-10 text-center text-sm">No member counts in this range.</p>
            ) : (
              <HistoryChart data={memberData} valueLabel="Members" color="#34d399" />
            )}
          </CardContent>
        </Card>
      </section>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Player trophy progression</CardTitle>
          <CardDescription>
            {playerId === undefined
              ? 'Select a player above to plot their real snapshot history.'
              : 'Only stored snapshots for the selected player are plotted.'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {playerTrophyData.length === 0 ? (
            <p className="muted-text py-10 text-center text-sm">
              {playerId === undefined
                ? 'No player selected.'
                : 'This player has no snapshots in the selected range.'}
            </p>
          ) : (
            <HistoryChart data={playerTrophyData} valueLabel="Player trophies" color="#fbbf24" />
          )}
        </CardContent>
      </Card>
    </>
  );
}
