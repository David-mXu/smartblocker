import * as React from 'react';
import { cn } from '../../lib/utils';

export type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement>;

/** Inset multi-line field; mono because every use is a list of domains/keywords. */
export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, ...props }, ref) => {
    return (
      <textarea
        className={cn(
          'flex min-h-[120px] w-full resize-y rounded-lg border border-input bg-background px-3 py-2.5 font-mono text-[13px] leading-6 text-foreground placeholder:text-faint transition-colors focus-visible:border-accent/60 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-45',
          className,
        )}
        ref={ref}
        {...props}
      />
    );
  },
);
Textarea.displayName = 'Textarea';
