import Link from 'next/link';
import { HistoryChart } from '@/components/charts/history-chart';
import { ClubBadge } from '@/components/clubs/club-badge';
import { EventList } from '@/components/dashboard/event-list';
import { PageHeader } from '@/components/dashboard/page-header';
import { Pagination } from '@/components/dashboard/pagination';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Input, Select } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  hasClubPermission,
  requirePageClubPermission,
} from '@/lib/auth/session';
import {
  getClubById,
  getClubEvents,
  getClubPrivate,
  getClubSnapshots,
  getCurrentRoster,
  parsePagination,
} from '@/lib/data/queries';
import { formatDateTime, formatNumber, formatTag } from '@/lib/utils';

export const dynamic = 'force-dynamic';

export default async function ClubDashboardPage({
  params,
  searchParams,
}: Readonly<{
  params: Promise<{ clubId: string }>;
  searchParams: Promise<{
    page?: string | string[];
    pageSize?: string | string[];
    saved?: string | string[];
    error?: string | string[];
    staff?: string | string[];
  }>;
}>) {
  const { clubId } = await params;
  const session = await requirePageClubPermission(clubId, 'clubs:read');
  const query = await searchParams;
  const { page, pageSize } = parsePagination(query);

  const [clubResult, roster, events, snapshots, clubPrivate] = await Promise.all([
    getClubById(clubId),
    getCurrentRoster(clubId),
    getClubEvents(clubId, 60),
    getClubSnapshots(clubId),
    getClubPrivate(clubId),
  ]);

  if (clubResult.rows.length === 0) {
    return (
      <EmptyState
        title="Club not found"
        description="This club is not registered or you do not have permission to view it."
      />
    );
  }

  const club = clubResult.rows[0]!;
  const canManage = hasClubPermission(session, club.id, 'clubs:write');
  const canManageStaff = hasClubPermission(session, club.id, 'staff:manage');
  const rosterPage = roster.rows.slice((page - 1) * pageSize, page * pageSize);
  const chartData = snapshots.rows
    .filter((snapshot) => snapshot.trophies !== null)
    .map((snapshot) => ({
      label: formatDateTime(snapshot.captured_at),
      value: snapshot.trophies as number,
    }));

  return (
    <>
      <PageHeader
        title={club.name}
        description={`${formatTag(club.tag)} · Real club data collected by the sync engine.`}
        actions={<Badge variant="neutral">Last updated {formatDateTime(snapshots.rows.at(-1)?.captured_at ?? club.last_synced_at)}</Badge>}
      />

      {query.saved !== undefined && query.saved !== '' ? (
        <p className="mb-4 rounded-lg border border-success/40 bg-success/10 px-4 py-3 text-sm text-success">
          Club settings saved and recorded in the audit log.
        </p>
      ) : null}
      {query.error !== undefined && query.error !== '' ? (
        <p className="mb-4 rounded-lg border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger">
          Club settings could not be saved. Check the values and try again.
        </p>
      ) : null}
      {query.staff === 'success' ? (
        <p className="mb-4 rounded-lg border border-success/40 bg-success/10 px-4 py-3 text-sm text-success">
          Club staff role updated.
        </p>
      ) : null}
      {query.staff === 'error' ? (
        <p className="mb-4 rounded-lg border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger">
          Club staff role could not be updated.
        </p>
      ) : null}

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Card className="p-5 md:col-span-2 xl:col-span-1">
          <div className="flex items-center gap-3">
            <ClubBadge name={club.name} badgeId={club.badge_id} className="h-12 w-12" />
            <div>
              <p className="text-sm font-semibold">{club.name}</p>
              <p className="font-mono text-xs text-muted">{formatTag(club.tag)}</p>
            </div>
          </div>
          <p className="muted-text mt-4 line-clamp-3 text-xs">{club.description ?? 'No API description available.'}</p>
        </Card>
        <Card className="p-5"><p className="muted-text text-xs uppercase">Club trophies</p><p className="mt-2 text-2xl font-bold">{formatNumber(club.trophies)}</p></Card>
        <Card className="p-5"><p className="muted-text text-xs uppercase">Required trophies</p><p className="mt-2 text-2xl font-bold">{formatNumber(club.required_trophies)}</p></Card>
        <Card className="p-5"><p className="muted-text text-xs uppercase">Current members</p><p className="mt-2 text-2xl font-bold">{formatNumber(roster.count)}</p></Card>
      </section>

      {clubPrivate.error === null ? null : (
        <div className="mt-4 rounded-lg border border-warning/40 bg-warning/10 px-4 py-3 text-sm text-warning">
          Private club settings could not be loaded: {clubPrivate.error}
        </div>
      )}

      {canManage ? (
        <Card className="mt-6 border-accent/40">
          <CardHeader>
            <CardTitle>Club management</CardTitle>
            <CardDescription>Visible only to authorised club staff and administrators.</CardDescription>
          </CardHeader>
          <CardContent>
            <form action={`/api/clubs/${club.id}/settings`} method="post" className="grid gap-4 md:grid-cols-3">
              <div>
                <label htmlFor="announcement_channel_id" className="muted-text mb-1.5 block text-xs font-semibold uppercase tracking-wider">Announcement channel ID</label>
                <Input id="announcement_channel_id" name="announcement_channel_id" defaultValue={clubPrivate.rows[0]?.announcement_channel_id ?? ''} />
              </div>
              <div>
                <label htmlFor="verified_role_id" className="muted-text mb-1.5 block text-xs font-semibold uppercase tracking-wider">Verified role ID</label>
                <Input id="verified_role_id" name="verified_role_id" defaultValue={clubPrivate.rows[0]?.verified_role_id ?? ''} />
              </div>
              <div>
                <label htmlFor="notes" className="muted-text mb-1.5 block text-xs font-semibold uppercase tracking-wider">Notes</label>
                <Input id="notes" name="notes" defaultValue={clubPrivate.rows[0]?.notes ?? ''} />
              </div>
              <div className="md:col-span-3">
                <Button type="submit">Save club settings</Button>
              </div>
            </form>
          </CardContent>
        </Card>
      ) : null}

      {canManageStaff ? (
        <Card className="mt-6">
          <CardHeader>
            <CardTitle>Club staff</CardTitle>
            <CardDescription>
              Grant or revoke manual club staff roles. The target user must already have a BrawlHub profile.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form action={`/api/clubs/${club.id}/staff`} method="post" className="grid gap-3 md:grid-cols-3">
              <div>
                <label htmlFor="staff-discord-id" className="muted-text mb-1.5 block text-xs font-semibold uppercase tracking-wider">Discord user ID</label>
                <Input id="staff-discord-id" name="discordUserId" inputMode="numeric" pattern="[0-9]{17,20}" required className="font-mono" />
              </div>
              <div>
                <label htmlFor="staff-role" className="muted-text mb-1.5 block text-xs font-semibold uppercase tracking-wider">Role</label>
                <Select id="staff-role" name="role" className="w-full">
                  <option value="staff">Club Staff</option>
                  <option value="member">Member</option>
                </Select>
              </div>
              <div>
                <label htmlFor="staff-action" className="muted-text mb-1.5 block text-xs font-semibold uppercase tracking-wider">Action</label>
                <Select id="staff-action" name="action" className="w-full">
                  <option value="grant">Grant</option>
                  <option value="revoke">Revoke</option>
                </Select>
              </div>
              <div className="md:col-span-3">
                <Button type="submit">Apply staff role</Button>
              </div>
            </form>
          </CardContent>
        </Card>
      ) : null}

      <section className="mt-6 grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Current roster</CardTitle>
            <CardDescription>Ranked by current trophies.</CardDescription>
          </CardHeader>
          <CardContent>
            {rosterPage.length === 0 ? (
              <p className="muted-text py-8 text-center text-sm">No current members recorded for this club.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>#</TableHead>
                    <TableHead>Player</TableHead>
                    <TableHead>Tag</TableHead>
                    <TableHead>Role</TableHead>
                    <TableHead className="text-right">Trophies</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rosterPage.map((membership, index) => (
                    <TableRow key={membership.id}>
                      <TableCell className="text-muted">{(page - 1) * pageSize + index + 1}</TableCell>
                      <TableCell>
                        {membership.player === undefined ? (
                          'Unrecorded player'
                        ) : (
                          <Link href={`/dashboard/players/${membership.player.id}`} className="font-semibold hover:underline">
                            {membership.player.name}
                          </Link>
                        )}
                      </TableCell>
                      <TableCell className="font-mono text-xs text-muted">{membership.player ? formatTag(membership.player.tag) : '—'}</TableCell>
                      <TableCell>{membership.role ?? 'Unavailable'}</TableCell>
                      <TableCell className="text-right">{formatNumber(membership.player?.trophies)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
            <Pagination basePath={`/dashboard/clubs/${club.id}`} page={page} pageSize={pageSize} count={roster.count} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Membership activity</CardTitle>
            <CardDescription>Real events affecting this club.</CardDescription>
          </CardHeader>
          <CardContent>
            {events.rows.length === 0 ? (
              <p className="muted-text py-8 text-center text-sm">No membership events recorded.</p>
            ) : (
              <EventList events={events.rows.slice(0, 12)} />
            )}
          </CardContent>
        </Card>
      </section>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Trophy progression</CardTitle>
          <CardDescription>
            {chartData.length === 0
              ? 'No snapshots collected yet.'
              : `Collection began ${formatDateTime(snapshots.rows[0]?.captured_at)}. Only actual snapshot points are plotted.`}
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

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Historical club snapshots</CardTitle>
          <CardDescription>Stored payload hashes let identical syncs avoid duplicate history.</CardDescription>
        </CardHeader>
        <CardContent>
          {snapshots.rows.length === 0 ? (
            <p className="muted-text py-8 text-center text-sm">No snapshots recorded.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Captured</TableHead>
                  <TableHead className="text-right">Trophies</TableHead>
                  <TableHead className="text-right">Members</TableHead>
                  <TableHead>Payload hash</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {[...snapshots.rows].reverse().map((snapshot) => (
                  <TableRow key={snapshot.id}>
                    <TableCell>{formatDateTime(snapshot.captured_at)}</TableCell>
                    <TableCell className="text-right">{formatNumber(snapshot.trophies)}</TableCell>
                    <TableCell className="text-right">{formatNumber(snapshot.member_count)}</TableCell>
                    <TableCell className="font-mono text-xs text-muted">{snapshot.payload_hash.slice(0, 16)}…</TableCell>
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
