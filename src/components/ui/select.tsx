import * as React from 'react';
import { cn } from '../../lib/utils';

export type SelectProps = React.SelectHTMLAttributes<HTMLSelectElement>;

/** Native select (tests and keyboard behavior for free), inset styling + caret. */
export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, children, ...props }, ref) => {
    return (
      <select
        ref={ref}
        className={cn(
          'h-9 min-w-0 cursor-pointer appearance-none truncate rounded-lg border border-input bg-background bg-[length:12px] bg-[position:right_10px_center] bg-no-repeat pl-3 pr-8 text-sm text-foreground transition-colors focus-visible:border-accent/60 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-45',
          "bg-[url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12' fill='none' stroke='%23a29a89' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M3 4.5l3 3 3-3'/%3E%3C/svg%3E\")]",
          className,
        )}
        {...props}
      >
        {children}
      </select>
    );
  },
);
Select.displayName = 'Select';
