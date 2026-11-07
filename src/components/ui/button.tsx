import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/utils';

// Lamplight button (docs/design-notes.md §4). Depth is borders-only: no
// shadows or glows. `default` is THE primary action of a view (one per view);
// `commit` (amber) is reserved for starting/confirming a commitment.
const buttonVariants = cva(
  'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-lg text-sm font-medium select-none cursor-pointer transition-[background-color,border-color,color,transform] duration-150 ease-out active:scale-[0.98] disabled:pointer-events-none disabled:opacity-45 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary/90',
        secondary:
          'border border-border bg-secondary text-secondary-foreground hover:bg-muted hover:border-faint/50',
        outline:
          'border border-border bg-transparent text-foreground hover:bg-muted hover:border-faint/50',
        ghost: 'bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground',
        commit: 'bg-accent text-accent-foreground hover:bg-accent/90',
        destructive:
          'border border-destructive/35 bg-destructive/10 text-destructive-soft hover:bg-destructive/20',
      },
      size: {
        default: 'h-9 px-4',
        sm: 'h-8 rounded-md px-3 text-[13px]',
        xs: 'h-7 rounded-md px-2.5 text-xs',
        lg: 'h-11 px-6 text-[15px]',
        icon: 'size-8 rounded-md',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, type = 'button', ...props }, ref) => {
    return (
      <button
        type={type}
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  },
);
Button.displayName = 'Button';
