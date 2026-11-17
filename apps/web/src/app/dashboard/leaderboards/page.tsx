import Link from 'next/link';
import { HistoryChart } from '@/components/charts/history-chart';
import { PageHeader } from '@/components/dashboard/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Select } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { getClubs, getClubSummaries, getPlayerClubs, getPlayers } from '@/lib/data/queries';
import { formatDateTime, formatNumber, formatTag } from '@/lib/utils';

export const dynamic = 'force-dynamic';

export default async function LeaderboardsPage({
  searchParams,
}: Readonly<{
  searchParams: Promise<{ club?: string | string[] }>;
}>) {
  const params = await searchParams;
  const selectedParam = Array.isArray(params.club) ? params.club[0] : params.club;

  const [clubSummaries, clubs] = await Promise.all([getClubSummaries(), getClubs({ page: 1, pageSize: 100 })]);
  const validClub =
    selectedParam !== undefined && clubs.rows.some((club) => club.id === selectedParam)
      ? selectedParam
      : undefined;

  const players = await getPlayers({
    page: 1,
    pageSize: 100,
    ...(validClub === undefined ? {} : { clubId: validClub }),
  });
  const playerClubs = await getPlayerClubs(players.rows.map((player) => player.id));
  const chartClub =
    clubSummaries.rows.find((summary) => summary.club.id === validClub) ?? clubSummaries.rows[0];
  const chartData = (chartClub?.snapshots ?? [])
    .filter((snapshot) => snapshot.trophies !== null)
    .map((snapshot) => ({
      label: formatDateTime(snapshot.captured_at),
      value: snapshot.trophies as number,
    }));

  return (
    <>
      <PageHeader
        title="Leaderboards"
        description="Rankings calculated from real club and player records. No estimated values are used."
      />

      <Card className="mb-5">
        <CardContent className="pt-5">
          <form method="get" className="flex flex-wrap items-end gap-3">
            <div>
              <label htmlFor="club" className="muted-text mb-1.5 block text-xs font-semibold uppercase tracking-wider">
                Player leaderboard scope
              </label>
              <Select id="club" name="club" defaultValue={validClub ?? ''} className="min-w-60">
                <option value="">All registered clubs</option>
                {clubs.rows.map((club) => (
                  <option key={club.id} value={club.id}>
                    {club.name}
                  </option>
                ))}
              </Select>
            </div>
            <Button type="submit">Apply</Button>
          </form>
        </CardContent>
      </Card>

      <section className="grid gap-4 lg:grid-cols-5">
        <Card className="lg:col-span-3">
          <CardHeader>
            <CardTitle>Club leaderboard</CardTitle>
            <CardDescription>Ranked by current club trophies.</CardDescription>
          </CardHeader>
          <CardContent>
            {clubSummaries.rows.length === 0 ? (
              <p className="muted-text py-8 text-center text-sm">No clubs have been registered yet.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>#</TableHead>
                    <TableHead>Club</TableHead>
                    <TableHead className="text-right">Trophies</TableHead>
                    <TableHead className="text-right">Members</TableHead>
                    <TableHead className="text-right">Avg. member</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {clubSummaries.rows.map((summary, index) => (
                    <TableRow key={summary.club.id}>
                      <TableCell className="font-semibold text-muted">{index + 1}</TableCell>
                      <TableCell>
                        <Link href={`/dashboard/clubs/${summary.club.id}`} className="font-semibold hover:underline">
                          {summary.club.name}
                        </Link>
                        <p className="font-mono text-xs text-muted">{formatTag(summary.club.tag)}</p>
                      </TableCell>
                      <TableCell className="text-right">{formatNumber(summary.club.trophies)}</TableCell>
                      <TableCell className="text-right">{formatNumber(summary.rosterCount)}</TableCell>
                      <TableCell className="text-right">{formatNumber(summary.averageMemberTrophies)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Club trophy progression</CardTitle>
            <CardDescription>
              {chartClub === undefined
                ? 'No snapshots collected yet.'
                : `Actual snapshots for ${chartClub.club.name}. Collection began ${formatDateTime(chartClub.snapshots[0]?.captured_at)}.`}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {chartData.length === 0 ? (
              <p className="muted-text py-10 text-center text-sm">No snapshot history available.</p>
            ) : (
              <HistoryChart data={chartData} valueLabel="Club trophies" color="#34d399" />
            )}
          </CardContent>
        </Card>
      </section>

      <Card className="mt-6">
        <CardHeader className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle>Player leaderboard</CardTitle>
            <CardDescription>
              {validClub === undefined
                ? 'Top 100 players across all clubs.'
                : `Top players in ${clubs.rows.find((club) => club.id === validClub)?.name ?? 'this club'}.`}
            </CardDescription>
          </div>
          <Badge variant="neutral">{players.count} in scope</Badge>
        </CardHeader>
        <CardContent>
          {players.rows.length === 0 ? (
            <p className="muted-text py-8 text-center text-sm">No player records available for this scope.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>#</TableHead>
                  <TableHead>Player</TableHead>
                  <TableHead>Tag</TableHead>
                  <TableHead>Current club</TableHead>
                  <TableHead className="text-right">Trophies</TableHead>
                  <TableHead className="text-right">Highest</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {players.rows.map((player, index) => (
                  <TableRow key={player.id}>
                    <TableCell className="font-semibold text-muted">{index + 1}</TableCell>
                    <TableCell>
                      <Link href={`/dashboard/players/${player.id}`} className="font-semibold hover:underline">
                        {player.name}
                      </Link>
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted">{formatTag(player.tag)}</TableCell>
                    <TableCell>{playerClubs.get(player.id)?.club?.name ?? 'Unavailable'}</TableCell>
                    <TableCell className="text-right font-medium">{formatNumber(player.trophies)}</TableCell>
                    <TableCell className="text-right">{formatNumber(player.highest_trophies)}</TableCell>
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
