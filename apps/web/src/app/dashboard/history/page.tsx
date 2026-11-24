import { HistoryChart } from '@/components/charts/history-chart';
import type { HistorySeries } from '@/components/charts/history-chart-data';
import { PageHeader } from '@/components/dashboard/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Select } from '@/components/ui/input';
import { formatDateTime } from '@/lib/utils';
import { RANGES, loadHistoryViewModel, type HistoryParams } from './history-view-model';

export const dynamic = 'force-dynamic';

function hasPoints(series: readonly HistorySeries[]): boolean {
  return series.some((item) => item.points.length > 0);
}

export default async function HistoryPage({
  searchParams,
}: Readonly<{ searchParams: Promise<HistoryParams> }>) {
  const model = await loadHistoryViewModel(await searchParams);

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
              <Select id="range" name="range" defaultValue={model.range.value} className="min-w-48">
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
              <Select id="club" name="club" defaultValue={model.clubId ?? ''} className="min-w-52">
                <option value="">All clubs</option>
                {model.clubs.map((club) => (
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
              <Select id="player" name="player" defaultValue={model.playerId ?? ''} className="min-w-52">
                <option value="">Select a player</option>
                {model.players.map((player) => (
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
        <Badge variant="neutral">{model.range.label}</Badge>
        <Badge variant="neutral">{model.clubSnapshots} club snapshots</Badge>
        <Badge variant="neutral">{model.playerSnapshots} player snapshots</Badge>
        {model.collectionStart === null ? null : (
          <span className="muted-text text-xs">
            Historical collection began {formatDateTime(model.collectionStart)}.
          </span>
        )}
      </div>

      {model.clubSnapshotError === null ? null : (
        <p className="mb-4 rounded-lg border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger">
          Club snapshot query failed: {model.clubSnapshotError}
        </p>
      )}
      {model.playerSnapshotError === null ? null : (
        <p className="mb-4 rounded-lg border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger">
          Player snapshot query failed: {model.playerSnapshotError}
        </p>
      )}

      <section className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Club trophy progression</CardTitle>
            <CardDescription>
              {model.clubId === undefined
                ? 'Each accessible club is plotted from its own stored snapshots; no cross-club totals.'
                : 'Actual snapshots for the selected club.'}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {hasPoints(model.clubTrophySeries) ? (
              <HistoryChart
                series={model.clubTrophySeries}
                valueLabel="Club trophies"
                color="#7c96ff"
              />
            ) : (
              <p className="muted-text py-10 text-center text-sm">No club snapshots in this range.</p>
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
            {hasPoints(model.memberSeries) ? (
              <HistoryChart series={model.memberSeries} valueLabel="Members" color="#34d399" />
            ) : (
              <p className="muted-text py-10 text-center text-sm">No member counts in this range.</p>
            )}
          </CardContent>
        </Card>
      </section>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Player trophy progression</CardTitle>
          <CardDescription>
            {model.playerId === undefined
              ? 'Select a player above to plot their real snapshot history.'
              : `Only stored snapshots for ${model.selectedPlayer?.name ?? 'the selected player'} are plotted.`}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {hasPoints(model.playerTrophySeries) ? (
            <HistoryChart
              series={model.playerTrophySeries}
              valueLabel="Player trophies"
              color="#fbbf24"
            />
          ) : (
            <p className="muted-text py-10 text-center text-sm">
              {model.playerId === undefined
                ? 'No player selected.'
                : 'This player has no snapshots in the selected range.'}
            </p>
          )}
        </CardContent>
      </Card>
    </>
  );
}
