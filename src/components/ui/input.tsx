import * as React from 'react';
import { cn } from '../../lib/utils';

export type InputProps = React.InputHTMLAttributes<HTMLInputElement>;

/** Inset field: darker than its surface (bg-background on cards). */
export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type = 'text', ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          'flex h-9 w-full min-w-0 rounded-lg border border-input bg-background px-3 text-sm text-foreground placeholder:text-faint transition-colors focus-visible:border-accent/60 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-45',
          className,
        )}
        ref={ref}
        {...props}
      />
    );
  },
);
Input.displayName = 'Input';
