import type { LucideIcon } from 'lucide-react';
import { Card } from '@/components/ui/card';

export function StatCard({
  label,
  value,
  hint,
  icon: Icon,
}: {
  label: string;
  value: string;
  hint: string;
  icon: LucideIcon;
}) {
  return (
    <Card className="p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-muted">{label}</p>
          <p className="mt-2 text-2xl font-bold tracking-tight">{value}</p>
        </div>
        <div className="grid h-9 w-9 place-items-center rounded-lg border border-accent/30 bg-accent/10 text-accent">
          <Icon className="h-4 w-4" aria-hidden />
        </div>
      </div>
      <p className="muted-text mt-3 text-xs">{hint}</p>
    </Card>
  );
}
