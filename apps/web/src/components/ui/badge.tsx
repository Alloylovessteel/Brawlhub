import type * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold',
  {
    variants: {
      variant: {
        default: 'border-accent/40 bg-accent/15 text-accent',
        neutral: 'border-border bg-surface-hover text-muted',
        success: 'border-success/40 bg-success/15 text-success',
        warning: 'border-warning/40 bg-warning/15 text-warning',
        danger: 'border-danger/40 bg-danger/15 text-danger',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
