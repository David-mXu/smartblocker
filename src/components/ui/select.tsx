import * as React from 'react';
import { cn } from '../../lib/utils';

export type SelectProps = React.SelectHTMLAttributes<HTMLSelectElement>;

export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, children, ...props }, ref) => {
    return (
      <select
        ref={ref}
        className={cn(
          'flex h-10 rounded-lg border border-zinc-800 bg-[#121218] pl-3 pr-7 py-2 text-sm text-zinc-100 truncate transition-colors focus-visible:outline-none focus-visible:border-zinc-500 disabled:cursor-not-allowed disabled:opacity-45 cursor-pointer',
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
