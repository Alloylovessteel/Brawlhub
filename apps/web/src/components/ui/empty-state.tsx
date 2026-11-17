import type { ReactNode } from 'react';
import { Inbox } from 'lucide-react';
import { Card } from '@/components/ui/card';

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <Card className="flex flex-col items-center justify-center gap-3 px-6 py-14 text-center">
      <div className="grid h-11 w-11 place-items-center rounded-full border border-border bg-surface-muted text-muted">
        <Inbox className="h-5 w-5" aria-hidden />
      </div>
      <div className="space-y-1">
        <h3 className="font-semibold">{title}</h3>
        <p className="muted-text mx-auto max-w-md">{description}</p>
      </div>
      {action}
    </Card>
  );
}
