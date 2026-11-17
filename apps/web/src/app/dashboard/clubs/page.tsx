import Link from 'next/link';
import { Search } from 'lucide-react';
import { ClubBadge } from '@/components/clubs/club-badge';
import { PageHeader } from '@/components/dashboard/page-header';
import { Pagination } from '@/components/dashboard/pagination';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  getClubSnapshots,
  getClubs,
  getCurrentRoster,
  parsePagination,
  parseSearch,
} from '@/lib/data/queries';
import { formatDateTime, formatNumber, formatTag } from '@/lib/utils';

export const dynamic = 'force-dynamic';

export default async function ClubsPage({
  searchParams,
}: Readonly<{
  searchParams: Promise<{ search?: string | string[]; page?: string | string[]; pageSize?: string | string[] }>;
}>) {
  const params = await searchParams;
  const { page, pageSize } = parsePagination(params);
  const search = parseSearch(params.search);
  const clubs = await getClubs({ search, page, pageSize });

  const details = await Promise.all(
    clubs.rows.map(async (club) => {
      const [roster, snapshots] = await Promise.all([
        getCurrentRoster(club.id),
        getClubSnapshots(club.id),
      ]);
      return {
        club,
        rosterCount: roster.count,
        lastUpdated: snapshots.rows.at(-1)?.captured_at ?? club.last_synced_at,
      };
    }),
  );

  return (
    <>
      <PageHeader
        title="Club directory"
        description="All clubs registered through the official Brawl Stars API."
      />

      <Card className="mb-5">
        <CardContent className="pt-5">
          <form method="get" className="flex flex-wrap items-end gap-3">
            <div className="min-w-56 flex-1">
              <label htmlFor="search" className="muted-text mb-1.5 block text-xs font-semibold uppercase tracking-wider">
                Search clubs
              </label>
              <div className="relative">
                <Search className="absolute left-3 top-3 h-4 w-4 text-muted" aria-hidden />
                <Input id="search" name="search" defaultValue={search} placeholder="Name or tag" className="pl-9" />
              </div>
            </div>
            <Button type="submit">Search</Button>
          </form>
        </CardContent>
      </Card>

      {clubs.error === null ? null : (
        <div className="mb-4 rounded-lg border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger">
          {clubs.error}
        </div>
      )}

      <Card>
        <CardContent className="pt-5">
          {details.length === 0 ? (
            <p className="muted-text py-10 text-center text-sm">No clubs match this search.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Club</TableHead>
                  <TableHead>Tag</TableHead>
                  <TableHead className="text-right">Members</TableHead>
                  <TableHead className="text-right">Club trophies</TableHead>
                  <TableHead className="text-right">Required</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Last updated</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {details.map(({ club, rosterCount, lastUpdated }) => (
                  <TableRow key={club.id}>
                    <TableCell>
                      <div className="flex items-center gap-3">
                        <ClubBadge name={club.name} badgeId={club.badge_id} />
                        <Link href={`/dashboard/clubs/${club.id}`} className="font-semibold hover:underline">
                          {club.name}
                        </Link>
                      </div>
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted">{formatTag(club.tag)}</TableCell>
                    <TableCell className="text-right">{formatNumber(rosterCount)}</TableCell>
                    <TableCell className="text-right">{formatNumber(club.trophies)}</TableCell>
                    <TableCell className="text-right">{formatNumber(club.required_trophies)}</TableCell>
                    <TableCell>
                      <Badge variant="neutral">Unavailable</Badge>
                    </TableCell>
                    <TableCell className="text-xs text-muted">{formatDateTime(lastUpdated)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          <Pagination
            basePath="/dashboard/clubs"
            page={page}
            pageSize={pageSize}
            count={clubs.count}
            params={{ search }}
          />
        </CardContent>
      </Card>
    </>
  );
}
