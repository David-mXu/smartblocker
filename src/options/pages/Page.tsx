import * as React from 'react';
import { LockSimple } from '@phosphor-icons/react';
import { cn } from '../../lib/utils';

// One options page = a page heading (focus target on route change) followed
// by SettingsSections. The heading carries id="page-heading" so the shell can
// move focus to it after a hash change.

export interface PageProps {
  title: string;
  description?: React.ReactNode;
  children: React.ReactNode;
}

export function Page({ title, description, children }: PageProps) {
  return (
    <div className="flex flex-col gap-10">
      <header className="flex flex-col gap-1 px-1">
        <h1
          id="page-heading"
          tabIndex={-1}
          className="m-0 text-xl font-semibold tracking-tight text-foreground outline-none"
        >
          {title}
        </h1>
        {description && <p className="m-0 max-w-[60ch] text-[13px] text-muted-foreground">{description}</p>}
      </header>
      {children}
    </div>
  );
}

/** Inline "why is this disabled" line shown once per locked group. */
export function LockedNote({
  reason,
  className,
  id,
}: {
  reason: string;
  className?: string;
  id?: string;
}) {
  if (!reason) return null;
  return (
    <p id={id} className={cn('m-0 flex items-center gap-1.5 text-xs text-accent-soft', className)}>
      <LockSimple weight="fill" aria-hidden className="size-3.5 shrink-0 text-accent" />
      {reason}
    </p>
  );
}
