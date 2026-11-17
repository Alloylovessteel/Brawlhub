import Link from 'next/link';
import { AlertTriangle, Shield, Trophy, UserRound, UsersRound } from 'lucide-react';
import { HistoryChart } from '@/components/charts/history-chart';
import { EventList } from '@/components/dashboard/event-list';
import { PageHeader } from '@/components/dashboard/page-header';
import { StatCard } from '@/components/dashboard/stat-card';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { getClubSummaries, getOverview } from '@/lib/data/queries';
import { formatDate, formatDateTime, formatNumber, formatTag } from '@/lib/utils';

export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  const [overview, clubSummaries] = await Promise.all([getOverview(), getClubSummaries()]);

  if (!overview.hasData) {
    return (
      <>
        <PageHeader
          title="Overview"
          description="Live club and player insights from the official Brawl Stars API."
        />
        <EmptyState
          title="No collected data yet"
          description="Register real clubs and run a sync to populate BrawlHub. No placeholder statistics are shown."
        />
      </>
    );
  }

  const trophyPoints = new Map<string, number>();
  let earliestSnapshot: string | null = null;
  for (const summary of clubSummaries.rows) {
    for (const snapshot of summary.snapshots) {
      if (snapshot.trophies === null) continue;
      trophyPoints.set(
        snapshot.captured_at,
        (trophyPoints.get(snapshot.captured_at) ?? 0) + snapshot.trophies,
      );
      if (earliestSnapshot === null || snapshot.captured_at < earliestSnapshot) {
        earliestSnapshot = snapshot.captured_at;
      }
    }
  }
  const chartData = [...trophyPoints.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([capturedAt, value]) => ({ label: formatDate(capturedAt), value }));

  const failedRuns = overview.recentRuns.filter((run) => run.status === 'failed');
  const lastSuccessFinishedAt =
    overview.latestSync?.finished_at ?? overview.latestSync?.started_at ?? null;

  return (
    <>
      <PageHeader
        title="Overview"
        description="Live club and player insights built only from records collected by the sync engine."
      />

      {overview.error === null ? null : (
        <div className="mb-4 rounded-lg border border-warning/40 bg-warning/10 px-4 py-3 text-sm text-warning">
          Some dashboard queries failed: {overview.error}. Existing data is shown where available.
        </div>
      )}

      {overview.staleSync ? (
        <div className="mb-4 flex items-start gap-3 rounded-lg border border-warning/40 bg-warning/10 px-4 py-3 text-sm text-warning">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>
            Sync data may be stale. Check the latest run below or ask an administrator to run a sync.
          </span>
        </div>
      ) : null}

      <section className="dashboard-grid">
        <StatCard
          label="Registered clubs"
          value={formatNumber(overview.clubs)}
          hint="Real clubs validated through the official API"
          icon={Shield}
        />
        <StatCard
          label="Unique players"
          value={formatNumber(overview.players)}
          hint="Distinct player tags in the database"
          icon={UserRound}
        />
        <StatCard
          label="Current memberships"
          value={formatNumber(overview.memberships)}
          hint="Open memberships across all clubs"
          icon={UsersRound}
        />
        <StatCard
          label="Tracked trophies"
          value={formatNumber(overview.trophies.total)}
          hint={overview.trophies.average === null ? 'No trophy values recorded' : `Average ${formatNumber(overview.trophies.average)} per player`}
          icon={Trophy}
        />
      </section>

      <section className="mt-6 grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Latest successful synchronisation</CardTitle>
            <CardDescription>
              Last completed run: <span className="font-medium text-foreground">{formatDateTime(lastSuccessFinishedAt)}</span>
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {overview.latestSync === null ? (
              <p className="muted-text text-sm">No completed sync run has been recorded yet.</p>
            ) : (
              <div className="flex flex-wrap items-center gap-3 text-sm">
                <Badge variant="success">Completed</Badge>
                <span className="text-muted">Scope</span>
                <span className="font-medium">{overview.latestSync.scope}</span>
                <span className="text-muted">Records</span>
                <span className="font-medium">{formatNumber(overview.latestSync.records_processed)}</span>
                {overview.latestSync.last_error === null ? null : (
                  <span className="w-full rounded-lg border border-border bg-surface-muted px-3 py-2 text-xs text-muted">
                    Recovered from: {overview.latestSync.last_error}
                  </span>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Sync health</CardTitle>
            <CardDescription>Recent failures and stale-data checks</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {failedRuns.length === 0 ? (
              <p className="text-success">No failures in the last {overview.recentRuns.length} runs.</p>
            ) : (
              failedRuns.slice(0, 3).map((run) => (
                <div key={run.id} className="rounded-lg border border-danger/30 bg-danger/10 p-2">
                  <p className="font-medium text-danger">{formatDateTime(run.started_at)}</p>
                  <p className="mt-1 text-xs text-muted">{run.error ?? run.last_error ?? 'Unknown error'}</p>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </section>

      <section className="mt-6 grid gap-4 lg:grid-cols-5">
        <Card className="lg:col-span-3">
          <CardHeader>
            <CardTitle>Club comparison</CardTitle>
            <CardDescription>Current trophies and roster sizes from real club records.</CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Club</TableHead>
                  <TableHead>Tag</TableHead>
                  <TableHead className="text-right">Trophies</TableHead>
                  <TableHead className="text-right">Members</TableHead>
                  <TableHead className="text-right">Avg. player</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {clubSummaries.rows.map(({ club, rosterCount, averageMemberTrophies }) => (
                  <TableRow key={club.id}>
                    <TableCell>
                      <Link href={`/dashboard/clubs/${club.id}`} className="font-semibold hover:underline">
                        {club.name}
                      </Link>
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted">{formatTag(club.tag)}</TableCell>
                    <TableCell className="text-right">{formatNumber(club.trophies)}</TableCell>
                    <TableCell className="text-right">{formatNumber(rosterCount)}</TableCell>
                    <TableCell className="text-right">{formatNumber(averageMemberTrophies)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Recent activity</CardTitle>
            <CardDescription>Actual membership events recorded by sync.</CardDescription>
          </CardHeader>
          <CardContent>
            {overview.recentEvents.length === 0 ? (
              <p className="muted-text py-6 text-center text-sm">No membership events recorded yet.</p>
            ) : (
              <EventList events={overview.recentEvents} />
            )}
          </CardContent>
        </Card>
      </section>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Club trophy progression</CardTitle>
          <CardDescription>
            {earliestSnapshot === null
              ? 'No snapshots collected yet.'
              : `Historical collection began ${formatDate(earliestSnapshot)}. Only actual snapshot points are plotted.`}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {chartData.length === 0 ? (
            <p className="muted-text py-10 text-center text-sm">No snapshot history available yet.</p>
          ) : (
            <HistoryChart data={chartData} valueLabel="Club trophies" />
          )}
        </CardContent>
      </Card>
    </>
  );
}
