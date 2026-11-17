import type * as React from 'react';
import { cn } from '@/lib/utils';

export function Table({ className, ...props }: React.ComponentProps<'table'>) {
  return (
    <div className="w-full overflow-x-auto">
      <table className={cn('data-table w-full', className)} {...props} />
    </div>
  );
}

export function TableHeader({ className, ...props }: React.ComponentProps<'thead'>) {
  return <thead className={cn('bg-surface-muted/70', className)} {...props} />;
}

export function TableBody({ className, ...props }: React.ComponentProps<'tbody'>) {
  return <tbody className={cn('divide-y divide-border/70', className)} {...props} />;
}

export function TableRow({ className, ...props }: React.ComponentProps<'tr'>) {
  return <tr className={cn('', className)} {...props} />;
}

export function TableHead({ className, ...props }: React.ComponentProps<'th'>) {
  return <th className={cn('', className)} {...props} />;
}

export function TableCell({ className, ...props }: React.ComponentProps<'td'>) {
  return <td className={cn('', className)} {...props} />;
}
