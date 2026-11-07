import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/utils';

// Status only — never decoration (docs/design-notes.md §4). `dot` adds a
// live-status dot in the variant's hue.
const badgeVariants = cva(
  'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full text-xs font-medium tabular-nums',
  {
    variants: {
      variant: {
        default: 'text-muted-foreground',
        success: 'text-success-soft',
        commit: 'text-accent-soft',
        warning: 'text-warning-soft',
        destructive: 'text-destructive-soft',
        outline: 'border border-border px-2 py-0.5 text-muted-foreground',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

const dotColor: Record<string, string> = {
  default: 'bg-faint',
  success: 'bg-success',
  commit: 'bg-accent',
  warning: 'bg-warning',
  destructive: 'bg-destructive',
  outline: 'bg-faint',
};

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {
  dot?: boolean;
}

export function Badge({ className, variant, dot, children, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ variant }), className)} {...props}>
      {dot && <span aria-hidden className={cn('size-1.5 rounded-full', dotColor[variant ?? 'default'])} />}
      {children}
    </span>
  );
}
