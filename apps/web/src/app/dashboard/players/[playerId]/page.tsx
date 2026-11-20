import Link from 'next/link';
import { HistoryChart } from '@/components/charts/history-chart';
import { EventList } from '@/components/dashboard/event-list';
import { PageHeader } from '@/components/dashboard/page-header';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { getAccessibleReadClubIds, requirePageSession } from '@/lib/auth/session';
import {
  getPlayerBattles,
  getPlayerById,
  getPlayerEvents,
  getPlayerMemberships,
  getPlayerSnapshots,
} from '@/lib/data/queries';
import { formatDateTime, formatNumber, formatTag } from '@/lib/utils';

export const dynamic = 'force-dynamic';

export default async function PlayerProfilePage({
  params,
}: Readonly<{ params: Promise<{ playerId: string }> }>) {
  const session = await requirePageSession();
  const scope = getAccessibleReadClubIds(session);
  const scopeOptions = scope === null ? {} : { allowedClubIds: [...scope] };
  const { playerId } = await params;

  const [playerResult, memberships, events, snapshots, battles] = await Promise.all([
    getPlayerById(playerId, scopeOptions),
    getPlayerMemberships(playerId, scopeOptions),
    getPlayerEvents(playerId, scopeOptions),
    getPlayerSnapshots(playerId, scopeOptions),
    getPlayerBattles(playerId, scopeOptions),
  ]);

  if (playerResult.rows.length === 0) {
    return (
      <EmptyState
        title="Player not found"
        description="This player has not been collected by the sync engine."
      />
    );
  }

  const player = playerResult.rows[0]!;
  const currentMembership = memberships.rows.find((membership) => membership.valid_to === null);
  const chartData = snapshots.rows
    .filter((snapshot) => snapshot.trophies !== null)
    .map((snapshot) => ({ label: formatDateTime(snapshot.captured_at), value: snapshot.trophies as number }));

  const battleRows = battles.rows.map((battle) => {
    const modeMap = [battle.mode, battle.map]
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .join(' / ');
    return {
      id: battle.id,
      time: formatDateTime(battle.battle_time),
      modeMap: modeMap === '' ? '—' : modeMap,
      result: battle.result ?? '—',
      trophyChange: battle.trophy_change === null ? '—' : formatNumber(battle.trophy_change),
    };
  });

  const statistics = [
    { label: 'Current trophies', value: player.trophies },
    { label: 'Highest trophies', value: player.highest_trophies },
    { label: 'Experience level', value: player.exp_level },
    { label: 'Power points', value: player.power_points },
    { label: 'Total victories', value: player.victories },
    { label: 'Solo victories', value: player.solo_victories },
    { label: 'Team victories', value: player.team_victories },
  ];

  return (
    <>
      <PageHeader
        title={player.name}
        description={`${formatTag(player.tag)} · Player profile built from collected database records.`}
        actions={
          currentMembership?.club === undefined ? (
            <Badge variant="neutral">No current club</Badge>
          ) : (
            <Link
              href={`/dashboard/clubs/${currentMembership.club.id}`}
              className="rounded-full border border-accent/40 bg-accent/15 px-3 py-1 text-xs font-semibold text-accent hover:underline"
            >
              {currentMembership.club.name}
            </Link>
          )
        }
      />

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Card className="p-5">
          <p className="muted-text text-xs uppercase tracking-wider">Current trophies</p>
          <p className="mt-2 text-2xl font-bold">{formatNumber(player.trophies)}</p>
        </Card>
        <Card className="p-5">
          <p className="muted-text text-xs uppercase tracking-wider">Highest trophies</p>
          <p className="mt-2 text-2xl font-bold">{formatNumber(player.highest_trophies)}</p>
        </Card>
        <Card className="p-5">
          <p className="muted-text text-xs uppercase tracking-wider">Current club</p>
          <p className="mt-2 truncate text-lg font-bold">{currentMembership?.club?.name ?? 'Unavailable'}</p>
        </Card>
        <Card className="p-5">
          <p className="muted-text text-xs uppercase tracking-wider">Club role</p>
          <p className="mt-2 text-lg font-bold">{currentMembership?.role ?? 'Unavailable'}</p>
        </Card>
      </section>

      <section className="mt-6 grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Available statistics</CardTitle>
            <CardDescription>
              Fields not populated by the official API sync are shown as unavailable rather than zero.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Statistic</TableHead>
                  <TableHead className="text-right">Value</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {statistics.map((stat) => (
                  <TableRow key={stat.label}>
                    <TableCell>{stat.label}</TableCell>
                    <TableCell className="text-right">{formatNumber(stat.value)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Membership history</CardTitle>
            <CardDescription>Real open and closed club memberships.</CardDescription>
          </CardHeader>
          <CardContent>
            {memberships.rows.length === 0 ? (
              <p className="muted-text py-6 text-center text-sm">No membership records collected.</p>
            ) : (
              <ul className="space-y-3">
                {memberships.rows.map((membership) => (
                  <li key={membership.id} className="rounded-lg border border-border bg-surface-muted px-3 py-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-semibold">
                        {membership.club?.name ?? 'Unrecorded club'}
                      </span>
                      <Badge variant={membership.valid_to === null ? 'success' : 'neutral'}>
                        {membership.valid_to === null ? 'Current' : 'Past'}
                      </Badge>
                    </div>
                    <p className="muted-text mt-1 text-xs">
                      Joined {formatDateTime(membership.valid_from)}
                      {membership.valid_to === null ? '' : ` · Left ${formatDateTime(membership.valid_to)}`}
                    </p>
                    <p className="muted-text text-xs">Role: {membership.role ?? 'Unavailable'}</p>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </section>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Join, departure and transfer timeline</CardTitle>
          <CardDescription>Events detected and stored by the sync engine.</CardDescription>
        </CardHeader>
        <CardContent>
          {events.rows.length === 0 ? (
            <p className="muted-text py-6 text-center text-sm">No membership events recorded for this player.</p>
          ) : (
            <EventList events={events.rows} />
          )}
        </CardContent>
      </Card>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Trophy progression</CardTitle>
          <CardDescription>
            {snapshots.rows.length === 0
              ? 'No player snapshots collected yet.'
              : `Collection began ${formatDateTime(snapshots.rows[0]?.captured_at)}. Only actual snapshot points are plotted.`}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {chartData.length === 0 ? (
            <p className="muted-text py-10 text-center text-sm">No trophy history available.</p>
          ) : (
            <HistoryChart data={chartData} valueLabel="Player trophies" color="#fbbf24" />
          )}
        </CardContent>
      </Card>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Historical snapshots</CardTitle>
          <CardDescription>
            Snapshot records contain the collected club-member payload for this player.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {snapshots.rows.length === 0 ? (
            <p className="muted-text py-6 text-center text-sm">No snapshots recorded.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Captured</TableHead>
                  <TableHead className="text-right">Trophies</TableHead>
                  <TableHead>Payload hash</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {[...snapshots.rows].reverse().map((snapshot) => (
                  <TableRow key={snapshot.id}>
                    <TableCell>{formatDateTime(snapshot.captured_at)}</TableCell>
                    <TableCell className="text-right">{formatNumber(snapshot.trophies)}</TableCell>
                    <TableCell className="font-mono text-xs text-muted">{snapshot.payload_hash.slice(0, 16)}…</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Recent battle history</CardTitle>
          <CardDescription>Collected battle-log entries, newest first.</CardDescription>
        </CardHeader>
        <CardContent>
          {battleRows.length === 0 ? (
            <p className="muted-text py-6 text-center text-sm">No battle records collected.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Time</TableHead>
                  <TableHead>Mode / map</TableHead>
                  <TableHead>Result</TableHead>
                  <TableHead className="text-right">Trophy change</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {battleRows.map((battle) => (
                  <TableRow key={battle.id}>
                    <TableCell>{battle.time}</TableCell>
                    <TableCell>{battle.modeMap}</TableCell>
                    <TableCell>{battle.result}</TableCell>
                    <TableCell className="text-right">{battle.trophyChange}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </>
  );
}
