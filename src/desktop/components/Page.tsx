import * as React from 'react';
import { CaretRight, LockSimple } from '@phosphor-icons/react';
import { cn } from '../../lib/utils';

// Same page anatomy as the options page (src/options/pages/Page.tsx): a
// heading that takes focus on navigation, then sections of grouped rows.

export function Page({
  title,
  description,
  aside,
  children,
}: {
  title: string;
  description?: React.ReactNode;
  aside?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-9">
      <header className="flex items-start justify-between gap-4 px-1">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h1
            id="page-heading"
            tabIndex={-1}
            className="m-0 text-xl font-semibold tracking-tight text-foreground outline-none"
          >
            {title}
          </h1>
          {description && <p className="m-0 max-w-[62ch] text-[13px] text-muted-foreground">{description}</p>}
        </div>
        {aside && <div className="shrink-0 pt-1">{aside}</div>}
      </header>
      {children}
    </div>
  );
}

/** Inline "why is this disabled" line shown once per locked group. */
export function LockedNote({ children, className }: { children: React.ReactNode; className?: string }) {
  if (!children) return null;
  return (
    <p className={cn('m-0 flex items-center gap-1.5 text-xs text-accent-soft', className)}>
      <LockSimple weight="fill" aria-hidden className="size-3.5 shrink-0 text-accent" />
      <span className="tabular-nums">{children}</span>
    </p>
  );
}

/** A group row that navigates (Home summary). Same padding as SettingRow. */
export function LinkRow({
  href,
  label,
  description,
  leading,
}: {
  href: string;
  label: React.ReactNode;
  description?: React.ReactNode;
  leading?: React.ReactNode;
}) {
  return (
    <a
      href={href}
      className="group flex items-center gap-3 px-4 py-3.5 text-foreground no-underline transition-colors duration-150 first:rounded-t-xl last:rounded-b-xl hover:bg-muted/60 focus-visible:-outline-offset-2"
    >
      {leading && <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground">{leading}</span>}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-sm font-medium">{label}</span>
        {description && <span className="truncate text-[13px] text-muted-foreground">{description}</span>}
      </span>
      <CaretRight
        aria-hidden
        className="size-4 shrink-0 text-faint transition-colors group-hover:text-muted-foreground"
      />
    </a>
  );
}

/** Small status line under a form (role=status / alert). */
export function FormMessage({
  message,
  id,
  className,
}: {
  message: { tone: 'ok' | 'error'; text: string } | null;
  id?: string;
  className?: string;
}) {
  if (!message) return null;
  return (
    <p
      id={id}
      role={message.tone === 'error' ? 'alert' : 'status'}
      aria-live="polite"
      className={cn(
        'm-0 text-xs',
        message.tone === 'error' ? 'text-destructive-soft' : 'text-muted-foreground',
        className,
      )}
    >
      {message.text}
    </p>
  );
}

export type Message = { tone: 'ok' | 'error'; text: string } | null;
