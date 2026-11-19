import Link from 'next/link';
import { Search } from 'lucide-react';
import { PageHeader } from '@/components/dashboard/page-header';
import { Pagination } from '@/components/dashboard/pagination';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input, Select } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { getAccessibleReadClubIds, requirePageSession } from '@/lib/auth/session';
import {
  getClubs,
  getPlayerClubs,
  getPlayers,
  parsePagination,
  parseSearch,
} from '@/lib/data/queries';
import { formatNumber, formatTag } from '@/lib/utils';

export const dynamic = 'force-dynamic';

export default async function PlayersPage({
  searchParams,
}: Readonly<{
  searchParams: Promise<{
    search?: string | string[];
    club?: string | string[];
    page?: string | string[];
    pageSize?: string | string[];
  }>;
}>) {
  const session = await requirePageSession();
  const scope = getAccessibleReadClubIds(session);
  const scopeOptions = scope === null ? {} : { allowedClubIds: [...scope] };
  const clubScopeOptions = scope === null ? {} : { clubIds: [...scope] };
  const params = await searchParams;
  const { page, pageSize } = parsePagination(params);
  const search = parseSearch(params.search);
  const clubParam = Array.isArray(params.club) ? params.club[0] : params.club;
  const clubs = await getClubs({ page: 1, pageSize: 100, ...clubScopeOptions });
  const clubId =
    clubParam !== undefined && clubs.rows.some((club) => club.id === clubParam) ? clubParam : undefined;

  const players = await getPlayers({
    search,
    ...(clubId === undefined ? {} : { clubId }),
    page,
    pageSize,
    ...scopeOptions,
  });
  const playerClubs = await getPlayerClubs(players.rows.map((player) => player.id), scopeOptions);

  return (
    <>
      <PageHeader
        title="Player directory"
        description="Searchable player records collected from registered club rosters."
      />

      <Card className="mb-5">
        <CardContent className="pt-5">
          <form method="get" className="flex flex-wrap items-end gap-3">
            <div className="min-w-56 flex-1">
              <label htmlFor="search" className="muted-text mb-1.5 block text-xs font-semibold uppercase tracking-wider">
                Search players
              </label>
              <div className="relative">
                <Search className="absolute left-3 top-3 h-4 w-4 text-muted" aria-hidden />
                <Input id="search" name="search" defaultValue={search} placeholder="Name or tag" className="pl-9" />
              </div>
            </div>
            <div>
              <label htmlFor="club" className="muted-text mb-1.5 block text-xs font-semibold uppercase tracking-wider">
                Current club
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
            <Button type="submit">Apply filters</Button>
          </form>
        </CardContent>
      </Card>

      {players.error === null ? null : (
        <div className="mb-4 rounded-lg border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger">
          {players.error}
        </div>
      )}

      <Card>
        <CardContent className="pt-5">
          {players.rows.length === 0 ? (
            <p className="muted-text py-10 text-center text-sm">
              No players match these filters. Only synced club members appear here.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Player</TableHead>
                  <TableHead>Tag</TableHead>
                  <TableHead>Current club</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead className="text-right">Trophies</TableHead>
                  <TableHead className="text-right">Highest</TableHead>
                  <TableHead className="text-right">Exp level</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {players.rows.map((player) => {
                  const membership = playerClubs.get(player.id);
                  return (
                    <TableRow key={player.id}>
                      <TableCell>
                        <Link href={`/dashboard/players/${player.id}`} className="font-semibold hover:underline">
                          {player.name}
                        </Link>
                      </TableCell>
                      <TableCell className="font-mono text-xs text-muted">{formatTag(player.tag)}</TableCell>
                      <TableCell>
                        {membership?.club === undefined ? (
                          <Badge variant="neutral">Unavailable</Badge>
                        ) : (
                          <span className="text-sm">{membership.club.name}</span>
                        )}
                      </TableCell>
                      <TableCell>{membership?.role ?? 'Unavailable'}</TableCell>
                      <TableCell className="text-right font-medium">{formatNumber(player.trophies)}</TableCell>
                      <TableCell className="text-right">{formatNumber(player.highest_trophies)}</TableCell>
                      <TableCell className="text-right">{formatNumber(player.exp_level)}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
          <Pagination
            basePath="/dashboard/players"
            page={page}
            pageSize={pageSize}
            count={players.count}
            params={{ search, club: clubId }}
          />
        </CardContent>
      </Card>
    </>
  );
}
