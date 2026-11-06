import * as React from 'react';
import { cn } from '../../lib/utils';

export interface SwitchProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label?: string;
}

/**
 * Accessible shadcn/ui Switch backed by a real <input type="checkbox"> so both
 * React state and Playwright DOM `.checked` / `.disabled` queries work natively.
 */
export const Switch = React.forwardRef<HTMLInputElement, SwitchProps>(
  ({ className, checked, disabled, ...props }, ref) => {
    return (
      <label
        className={cn(
          'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors duration-200',
          checked
            ? 'border-emerald-400/50 bg-emerald-500'
            : 'border-zinc-700 bg-zinc-900',
          disabled ? 'cursor-not-allowed opacity-45' : 'cursor-pointer',
          className,
        )}
      >
        <input
          ref={ref}
          type="checkbox"
          checked={checked}
          disabled={disabled}
          className="peer sr-only"
          {...props}
        />
        <span
          className={cn(
            'pointer-events-none block h-4 w-4 rounded-full bg-zinc-950 shadow-sm transition-transform duration-200',
            checked ? 'translate-x-5 bg-zinc-950' : 'translate-x-1 bg-zinc-300',
          )}
        />
      </label>
    );
  },
);
Switch.displayName = 'Switch';
