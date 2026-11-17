import { cn } from '@/lib/utils';

export function ClubBadge({
  name,
  badgeId,
  className,
}: {
  name: string;
  badgeId: number | null;
  className?: string;
}) {
  const initials = name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0] ?? '')
    .join('')
    .toUpperCase();

  return (
    <div
      className={cn(
        'grid h-11 w-11 shrink-0 place-items-center rounded-xl border border-accent/30 bg-accent/10 text-sm font-bold text-accent',
        className,
      )}
      title={badgeId === null ? 'Badge unavailable' : `Badge ID ${badgeId}`}
    >
      {initials || '?'}
    </div>
  );
}
