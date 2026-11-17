import Link from 'next/link';
import type { ReactNode } from 'react';
import { DashboardSidebar } from '@/components/dashboard/sidebar';
import { isGlobalAdmin, requirePageSession } from '@/lib/auth/session';
import type { Role } from '@brawlhub/shared';

export const dynamic = 'force-dynamic';

const ROLE_RANK: Record<Role, number> = { owner: 3, admin: 2, staff: 1, member: 0 };
const ROLE_LABEL: Record<Role, string> = {
  owner: 'Owner',
  admin: 'Administrator',
  staff: 'Club Staff',
  member: 'Member',
};

export default async function DashboardLayout({ children }: Readonly<{ children: ReactNode }>) {
  const session = await requirePageSession();
  const role =
    session.globalRole ?? [...session.clubRoles.values()].sort((a, b) => ROLE_RANK[b] - ROLE_RANK[a])[0] ?? 'member';
  const displayName = session.profile?.username ?? session.user.email ?? 'BrawlHub member';
  const canAdmin = isGlobalAdmin(session);

  return (
    <div className="flex min-h-screen">
      <div className="hidden md:flex">
        <DashboardSidebar displayName={displayName} roleLabel={ROLE_LABEL[role]} canAdmin={canAdmin} />
      </div>

      <div className="min-w-0 flex-1">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-surface-muted/60 px-4 py-3 md:px-8">
          <div className="flex items-center gap-2 md:hidden">
            <Link href="/dashboard" className="font-bold">
              BrawlHub
            </Link>
            <span className="text-xs text-muted">/ {ROLE_LABEL[role]}</span>
          </div>
          <div className="hidden text-sm text-muted md:block">
            Signed in as <span className="font-medium text-foreground">{displayName}</span>
          </div>
          <nav className="flex gap-3 text-xs text-muted md:hidden">
            <Link href="/dashboard/clubs">Clubs</Link>
            <Link href="/dashboard/players">Players</Link>
            <Link href="/dashboard/leaderboards">Rankings</Link>
            {canAdmin ? <Link href="/dashboard/admin">Admin</Link> : null}
          </nav>
        </header>

        <main className="mx-auto w-full max-w-[1500px] px-4 py-6 md:px-8 md:py-8">{children}</main>
      </div>
    </div>
  );
}
