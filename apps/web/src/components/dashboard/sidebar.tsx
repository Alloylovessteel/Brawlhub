'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  BarChart3,
  Clock3,
  LayoutDashboard,
  LogOut,
  Shield,
  Trophy,
  Users,
} from 'lucide-react';
import { cn } from '@/lib/utils';

const NAV_ITEMS = [
  { href: '/dashboard', label: 'Overview', icon: LayoutDashboard },
  { href: '/dashboard/clubs', label: 'Clubs', icon: Shield },
  { href: '/dashboard/players', label: 'Players', icon: Users },
  { href: '/dashboard/leaderboards', label: 'Leaderboards', icon: Trophy },
  { href: '/dashboard/history', label: 'History', icon: Clock3 },
];

export function DashboardSidebar({
  displayName,
  roleLabel,
  canAdmin,
}: {
  displayName: string;
  roleLabel: string;
  canAdmin: boolean;
}) {
  const pathname = usePathname();
  const items = [
    ...NAV_ITEMS,
    ...(canAdmin ? [{ href: '/dashboard/admin', label: 'Admin', icon: BarChart3 }] : []),
  ];

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-border bg-surface-muted/70 px-4 py-6">
      <Link href="/dashboard" className="mb-8 flex items-center gap-3 px-2">
        <span className="grid h-9 w-9 place-items-center rounded-lg border border-accent/40 bg-accent/15 text-sm font-bold text-accent">
          BH
        </span>
        <span>
          <span className="block text-sm font-bold tracking-tight">BrawlHub</span>
          <span className="block text-xs text-muted">Club management</span>
        </span>
      </Link>

      <nav className="flex-1 space-y-1">
        {items.map(({ href, label, icon: Icon }) => {
          const active = href === '/dashboard' ? pathname === href : pathname.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                active
                  ? 'bg-accent/15 text-accent'
                  : 'text-muted hover:bg-surface-hover hover:text-foreground',
              )}
            >
              <Icon className="h-4 w-4" aria-hidden />
              {label}
            </Link>
          );
        })}
      </nav>

      <div className="mt-6 border-t border-border pt-4">
        <div className="px-2">
          <p className="truncate text-sm font-semibold">{displayName}</p>
          <p className="text-xs text-muted">{roleLabel}</p>
        </div>
        <form action="/api/auth/logout" method="post" className="mt-3">
          <button
            type="submit"
            className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm text-muted transition-colors hover:bg-danger/10 hover:text-danger"
          >
            <LogOut className="h-4 w-4" aria-hidden />
            Sign out
          </button>
        </form>
      </div>
    </aside>
  );
}
