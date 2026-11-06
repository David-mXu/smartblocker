import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-300/60 disabled:pointer-events-none disabled:opacity-45 cursor-pointer select-none active:scale-[0.99]',
  {
    variants: {
      variant: {
        default:
          'bg-zinc-100 text-zinc-950 font-semibold shadow-[0_1px_20px_rgba(255,255,255,0.12)] hover:bg-white',
        secondary:
          'bg-zinc-900/90 text-zinc-100 border border-zinc-800 hover:bg-zinc-800/90 hover:border-zinc-700',
        outline:
          'border border-zinc-700/80 bg-transparent text-zinc-100 hover:bg-zinc-900 hover:border-zinc-500',
        destructive:
          'bg-red-500/15 text-red-200 border border-red-500/35 hover:bg-red-500/25 hover:border-red-400/50',
        emerald:
          'bg-emerald-500 text-zinc-950 font-semibold hover:bg-emerald-400 shadow-[0_0_24px_rgba(16,185,129,0.25)]',
        ghost:
          'bg-transparent text-zinc-400 hover:text-zinc-100 hover:bg-zinc-900/70',
      },
      size: {
        default: 'h-10 px-4 py-2',
        sm: 'h-8 rounded-md px-3 text-xs',
        lg: 'h-12 rounded-xl px-7 text-base',
        icon: 'h-9 w-9',
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
