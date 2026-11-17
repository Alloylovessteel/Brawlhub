import Link from 'next/link';
import { ArrowRightLeft, LogIn, LogOut } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { formatDateTime } from '@/lib/utils';
import type { MembershipEventRow } from '@/lib/data/types';

const EVENT_STYLE = {
  join: { icon: LogIn, variant: 'success' as const, label: 'Join' },
  leave: { icon: LogOut, variant: 'danger' as const, label: 'Leave' },
  transfer: { icon: ArrowRightLeft, variant: 'warning' as const, label: 'Transfer' },
};

export function EventList({ events }: { events: MembershipEventRow[] }) {
  return (
    <ul className="divide-y divide-border/70">
      {events.map((event) => {
        const style = EVENT_STYLE[event.event_type];
        const Icon = style.icon;
        return (
          <li key={event.id} className="flex items-start gap-3 py-3">
            <div className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-border bg-surface-muted text-muted">
              <Icon className="h-4 w-4" aria-hidden />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={style.variant}>{style.label}</Badge>
                {event.player === undefined ? (
                  <span className="text-sm">Unknown player</span>
                ) : (
                  <Link
                    href={`/dashboard/players/${event.player.id}`}
                    className="text-sm font-semibold hover:underline"
                  >
                    {event.player.name}
                  </Link>
                )}
              </div>
              <p className="muted-text mt-1 text-xs">
                {event.event_type === 'join' ? (
                  <>Joined {event.to_club?.name ?? 'an unrecorded club'}</>
                ) : event.event_type === 'leave' ? (
                  <>Left {event.from_club?.name ?? 'an unrecorded club'}</>
                ) : (
                  <>
                    {event.from_club?.name ?? 'an unrecorded club'} →{' '}
                    {event.to_club?.name ?? 'an unrecorded club'}
                  </>
                )}
              </p>
            </div>
            <time className="shrink-0 text-xs text-muted" dateTime={event.detected_at}>
              {formatDateTime(event.detected_at)}
            </time>
          </li>
        );
      })}
    </ul>
  );
}
