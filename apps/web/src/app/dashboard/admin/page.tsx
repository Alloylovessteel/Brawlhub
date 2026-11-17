import { HistoryChart } from '@/components/charts/history-chart';
import { PageHeader } from '@/components/dashboard/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input, Select } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  hasGlobalPermission,
  requirePageGlobalPermission,
} from '@/lib/auth/session';
import {
  getAdminProfiles,
  getAuditLogs,
  getClubs,
  getGuildSettings,
  getSyncRuns,
  getUserRoles,
} from '@/lib/data/queries';
import { formatDateTime, formatNumber, formatTag } from '@/lib/utils';

export const dynamic = 'force-dynamic';

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function formatDetails(value: unknown): string {
  if (value === null || value === undefined) return '—';
  try {
    return JSON.stringify(value);
  } catch {
    return 'Unavailable';
  }
}

export default async function AdminPage({
  searchParams,
}: Readonly<{
  searchParams: Promise<{
    sync?: string | string[];
    role?: string | string[];
    settings?: string | string[];
    tab?: string | string[];
  }>;
}>) {
  const session = await requirePageGlobalPermission('sync:run');
  const params = await searchParams;
  const canAudit = hasGlobalPermission(session, 'audit:read');
  const canManageGlobalRoles = session.globalRole === 'owner';
  const canManageRoles = hasGlobalPermission(session, 'staff:manage');

  const [clubs, syncRuns, guildSettings, profiles, roleRows] = await Promise.all([
    getClubs({ page: 1, pageSize: 100 }),
    getSyncRuns(20),
    getGuildSettings(),
    getAdminProfiles(),
    getUserRoles(),
  ]);
  const auditLogs = canAudit ? await getAuditLogs(50) : null;

  const profileById = new Map(profiles.rows.map((profile) => [profile.id, profile]));
  const clubById = new Map(clubs.rows.map((club) => [club.id, club]));
  const syncChart = [...syncRuns.rows]
    .reverse()
    .map((run) => ({
      label: formatDateTime(run.started_at),
      value: run.records_processed,
    }));

  return (
    <>
      <PageHeader
        title="Administration"
        description="Owner and administrator tools. Every action is checked server-side and written to the audit log."
      />

      {firstValue(params.sync) !== undefined ? (
        <p
          className={`mb-4 rounded-lg border px-4 py-3 text-sm ${firstValue(params.sync) === 'success' ? 'border-success/40 bg-success/10 text-success' : 'border-danger/40 bg-danger/10 text-danger'}`}
        >
          {firstValue(params.sync) === 'success'
            ? 'Synchronisation completed. Existing locks and deduplication were preserved.'
            : 'Synchronisation failed or was already running. Check recent sync runs below.'}
        </p>
      ) : null}
      {firstValue(params.role) !== undefined ? (
        <p
          className={`mb-4 rounded-lg border px-4 py-3 text-sm ${firstValue(params.role) === 'success' ? 'border-success/40 bg-success/10 text-success' : 'border-danger/40 bg-danger/10 text-danger'}`}
        >
          {firstValue(params.role) === 'success' ? 'Role assignment updated.' : 'Role assignment could not be updated.'}
        </p>
      ) : null}
      {firstValue(params.settings) !== undefined ? (
        <p
          className={`mb-4 rounded-lg border px-4 py-3 text-sm ${firstValue(params.settings) === 'success' ? 'border-success/40 bg-success/10 text-success' : 'border-danger/40 bg-danger/10 text-danger'}`}
        >
          {firstValue(params.settings) === 'success' ? 'Guild settings saved.' : 'Guild settings could not be saved.'}
        </p>
      ) : null}

      <div className="mb-5 flex flex-wrap gap-2 text-sm">
        <a href="#sync" className="rounded-lg border border-border bg-surface px-3 py-1.5 hover:bg-surface-hover">Sync</a>
        {canManageRoles ? (
          <a href="#roles" className="rounded-lg border border-border bg-surface px-3 py-1.5 hover:bg-surface-hover">Roles</a>
        ) : null}
        {canAudit ? (
          <a href="#audit" className="rounded-lg border border-border bg-surface px-3 py-1.5 hover:bg-surface-hover">Audit log</a>
        ) : null}
        <a href="#settings" className="rounded-lg border border-border bg-surface px-3 py-1.5 hover:bg-surface-hover">Guild settings</a>
      </div>

      <section id="sync" className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-1">
          <CardHeader>
            <CardTitle>Run synchronisation</CardTitle>
            <CardDescription>
              Starts the existing Phase 2 sync engine with all current safeguards. Rate limited to three requests per minute.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form action="/api/admin/sync" method="post">
              <Button type="submit" className="w-full">Run sync now</Button>
            </form>
            <p className="muted-text mt-3 text-xs">
              Discord announcements remain controlled by the existing channel configuration.
            </p>
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Records processed by recent runs</CardTitle>
            <CardDescription>Values come from actual sync run records.</CardDescription>
          </CardHeader>
          <CardContent>
            {syncChart.length === 0 ? (
              <p className="muted-text py-10 text-center text-sm">No sync runs recorded.</p>
            ) : (
              <HistoryChart data={syncChart} valueLabel="Records processed" color="#7c96ff" />
            )}
          </CardContent>
        </Card>
      </section>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Recent sync runs</CardTitle>
        </CardHeader>
        <CardContent>
          {syncRuns.rows.length === 0 ? (
            <p className="muted-text py-6 text-center text-sm">No sync runs recorded.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Started</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Scope</TableHead>
                  <TableHead className="text-right">Records</TableHead>
                  <TableHead>Error</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {syncRuns.rows.map((run) => (
                  <TableRow key={run.id}>
                    <TableCell>{formatDateTime(run.started_at)}</TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          run.status === 'completed' ? 'success' : run.status === 'failed' ? 'danger' : 'warning'
                        }
                      >
                        {run.status}
                      </Badge>
                    </TableCell>
                    <TableCell>{run.scope}</TableCell>
                    <TableCell className="text-right">{formatNumber(run.records_processed)}</TableCell>
                    <TableCell className="max-w-xs truncate text-xs text-muted">
                      {run.error ?? run.last_error ?? '—'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {canManageRoles ? (
        <section id="roles" className="mt-6 grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Manual role assignment</CardTitle>
              <CardDescription>
                Manual grants persist across Discord role refreshes. Server-side rules prevent privilege escalation.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form action="/api/admin/roles" method="post" className="grid gap-3 md:grid-cols-2">
                <div>
                  <label htmlFor="role-action" className="muted-text mb-1.5 block text-xs font-semibold uppercase tracking-wider">Action</label>
                  <Select id="role-action" name="action" className="w-full">
                    <option value="grant">Grant</option>
                    <option value="revoke">Revoke</option>
                  </Select>
                </div>
                <div>
                  <label htmlFor="role-scope" className="muted-text mb-1.5 block text-xs font-semibold uppercase tracking-wider">Scope</label>
                  <Select id="role-scope" name="scope" className="w-full">
                    {canManageGlobalRoles ? <option value="global">Global</option> : null}
                    <option value="club">Club</option>
                  </Select>
                </div>
                <div className="md:col-span-2">
                  <label htmlFor="discordUserId" className="muted-text mb-1.5 block text-xs font-semibold uppercase tracking-wider">Discord user ID</label>
                  <Input id="discordUserId" name="discordUserId" inputMode="numeric" pattern="[0-9]{17,20}" required className="font-mono" />
                </div>
                <div>
                  <label htmlFor="role-club" className="muted-text mb-1.5 block text-xs font-semibold uppercase tracking-wider">Club (club scope)</label>
                  <Select id="role-club" name="clubId" className="w-full">
                    <option value="">None</option>
                    {clubs.rows.map((club) => (
                      <option key={club.id} value={club.id}>{club.name}</option>
                    ))}
                  </Select>
                </div>
                <div>
                  <label htmlFor="role-role" className="muted-text mb-1.5 block text-xs font-semibold uppercase tracking-wider">Role</label>
                  <Select id="role-role" name="role" className="w-full">
                    {canManageGlobalRoles ? <option value="owner">Server Owner</option> : null}
                    {canManageGlobalRoles ? <option value="admin">Server Administrator</option> : null}
                    <option value="owner">Club President</option>
                    <option value="staff">Club Staff</option>
                    <option value="member">Member</option>
                  </Select>
                </div>
                <div className="md:col-span-2">
                  <Button type="submit">Apply role</Button>
                </div>
              </form>
              {!canManageGlobalRoles ? (
                <p className="muted-text mt-3 text-xs">Administrators can manage club roles only. Global roles require the Server Owner.</p>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Current role assignments</CardTitle>
              <CardDescription>Latest 100 stored grants from both Discord and manual administration.</CardDescription>
            </CardHeader>
            <CardContent>
              {roleRows.rows.length === 0 ? (
                <p className="muted-text py-6 text-center text-sm">No roles assigned yet.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>User</TableHead>
                      <TableHead>Scope</TableHead>
                      <TableHead>Role</TableHead>
                      <TableHead>Source</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {roleRows.rows.map((row) => {
                      const profile = profileById.get(row.user_id);
                      return (
                        <TableRow key={row.id}>
                          <TableCell>
                            <p className="text-sm font-medium">{profile?.username ?? 'Unknown user'}</p>
                            <p className="font-mono text-xs text-muted">{profile?.discord_user_id ?? row.user_id}</p>
                          </TableCell>
                          <TableCell>
                            {row.scope === 'global'
                              ? 'Global'
                              : (clubById.get(row.club_id ?? '')?.name ?? 'Unknown club')}
                          </TableCell>
                          <TableCell>{row.role}</TableCell>
                          <TableCell>
                            <Badge variant={row.source === 'manual' ? 'warning' : 'neutral'}>{row.source}</Badge>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </section>
      ) : null}

      {canAudit ? (
        <section id="audit" className="mt-6">
          <Card>
            <CardHeader>
              <CardTitle>Audit log</CardTitle>
              <CardDescription>Owner-only record of administrative actions.</CardDescription>
            </CardHeader>
            <CardContent>
              {auditLogs === null || auditLogs.rows.length === 0 ? (
                <p className="muted-text py-6 text-center text-sm">No audit events recorded.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>When</TableHead>
                      <TableHead>Action</TableHead>
                      <TableHead>Target</TableHead>
                      <TableHead>Details</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {auditLogs.rows.map((log) => (
                      <TableRow key={log.id}>
                        <TableCell>{formatDateTime(log.created_at)}</TableCell>
                        <TableCell className="font-mono text-xs">{log.action}</TableCell>
                        <TableCell>{log.target_id ?? '—'}</TableCell>
                        <TableCell className="max-w-sm truncate font-mono text-xs text-muted">
                          {formatDetails(log.details)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </section>
      ) : null}

      <section id="settings" className="mt-6 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Guild settings</CardTitle>
            <CardDescription>Shared Discord server configuration for notifications and verification.</CardDescription>
          </CardHeader>
          <CardContent>
            {guildSettings.rows.length === 0 ? (
              <p className="muted-text mb-4 text-sm">No guild settings stored yet.</p>
            ) : (
              <div className="mb-4 space-y-2">
                {guildSettings.rows.map((setting) => (
                  <div key={setting.guild_id} className="rounded-lg border border-border bg-surface-muted px-3 py-2 text-sm">
                    <p className="font-mono text-xs">{setting.guild_id}</p>
                    <p className="muted-text text-xs">
                      Primary club: {clubById.get(setting.primary_club_id ?? '')?.name ?? 'None'} · Updated {formatDateTime(setting.updated_at)}
                    </p>
                  </div>
                ))}
              </div>
            )}
            <form action="/api/admin/guild-settings" method="post" className="grid gap-3 md:grid-cols-2">
              <div className="md:col-span-2">
                <label htmlFor="guildId" className="muted-text mb-1.5 block text-xs font-semibold uppercase tracking-wider">Guild ID</label>
                <Input id="guildId" name="guildId" defaultValue={guildSettings.rows[0]?.guild_id ?? process.env.DISCORD_GUILD_ID ?? ''} required inputMode="numeric" pattern="[0-9]{17,20}" className="font-mono" />
              </div>
              <div className="md:col-span-2">
                <label htmlFor="primaryClubId" className="muted-text mb-1.5 block text-xs font-semibold uppercase tracking-wider">Primary club</label>
                <Select id="primaryClubId" name="primaryClubId" defaultValue={guildSettings.rows[0]?.primary_club_id ?? ''} className="w-full">
                  <option value="">None</option>
                  {clubs.rows.map((club) => (
                    <option key={club.id} value={club.id}>{club.name} ({formatTag(club.tag)})</option>
                  ))}
                </Select>
              </div>
              <div>
                <label htmlFor="announcementChannelId" className="muted-text mb-1.5 block text-xs font-semibold uppercase tracking-wider">Announcement channel ID</label>
                <Input id="announcementChannelId" name="announcementChannelId" defaultValue={guildSettings.rows[0]?.announcement_channel_id ?? ''} inputMode="numeric" pattern="[0-9]{17,20}" className="font-mono" />
              </div>
              <div>
                <label htmlFor="verifiedRoleId" className="muted-text mb-1.5 block text-xs font-semibold uppercase tracking-wider">Verified role ID</label>
                <Input id="verifiedRoleId" name="verifiedRoleId" defaultValue={guildSettings.rows[0]?.verified_role_id ?? ''} inputMode="numeric" pattern="[0-9]{17,20}" className="font-mono" />
              </div>
              <div className="md:col-span-2">
                <Button type="submit">Save guild settings</Button>
              </div>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Registered clubs</CardTitle>
            <CardDescription>Clubs available for club-scoped role management.</CardDescription>
          </CardHeader>
          <CardContent>
            {clubs.rows.length === 0 ? (
              <p className="muted-text py-6 text-center text-sm">No clubs registered.</p>
            ) : (
              <ul className="space-y-2">
                {clubs.rows.map((club) => (
                  <li key={club.id} className="flex items-center justify-between rounded-lg border border-border bg-surface-muted px-3 py-2 text-sm">
                    <span className="font-medium">{club.name}</span>
                    <span className="font-mono text-xs text-muted">{formatTag(club.tag)}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </section>
    </>
  );
}
