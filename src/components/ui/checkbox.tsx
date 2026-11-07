import * as React from 'react';
import { cn } from '../../lib/utils';

export type CheckboxProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'>;

/** Real native checkbox (tests read `.checked`), restyled: ivory when checked. */
export const Checkbox = React.forwardRef<HTMLInputElement, CheckboxProps>(
  ({ className, ...props }, ref) => (
    <span className={cn('relative inline-flex size-4 shrink-0', className)}>
      <input
        ref={ref}
        type="checkbox"
        className="peer size-4 cursor-pointer appearance-none rounded-[4px] border border-faint/60 bg-background transition-colors checked:border-primary checked:bg-primary disabled:cursor-not-allowed disabled:opacity-45"
        {...props}
      />
      <svg
        aria-hidden
        viewBox="0 0 16 16"
        className="pointer-events-none absolute inset-0 size-4 text-primary-foreground opacity-0 peer-checked:opacity-100"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M4 8.5l2.5 2.5L12 5.5" />
      </svg>
    </span>
  ),
);
Checkbox.displayName = 'Checkbox';
