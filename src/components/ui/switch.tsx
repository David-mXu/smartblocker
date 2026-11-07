import * as React from 'react';
import { cn } from '../../lib/utils';

export type SwitchProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'>;

/**
 * Switch backed by a real <input type="checkbox"> so React state and
 * Playwright `.checked` / `.disabled` queries work natively. On = ivory track
 * (neutral — amber is reserved for commitment), off = secondary.
 */
export const Switch = React.forwardRef<HTMLInputElement, SwitchProps>(
  ({ className, checked, disabled, ...props }, ref) => {
    return (
      <label
        className={cn(
          'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors duration-150 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring/70',
          checked ? 'border-primary bg-primary' : 'border-border bg-secondary',
          disabled ? 'cursor-not-allowed opacity-45' : 'cursor-pointer',
          className,
        )}
      >
        <input
          ref={ref}
          type="checkbox"
          role="switch"
          checked={checked}
          disabled={disabled}
          className="peer sr-only"
          {...props}
        />
        <span
          aria-hidden
          className={cn(
            'pointer-events-none block size-3.5 rounded-full transition-transform duration-150 ease-out',
            checked ? 'translate-x-[18px] bg-primary-foreground' : 'translate-x-[2px] bg-muted-foreground',
          )}
        />
      </label>
    );
  },
);
Switch.displayName = 'Switch';
