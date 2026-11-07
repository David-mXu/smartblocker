import * as React from 'react';
import { cn } from '../../lib/utils';

// Options-page layout primitives (docs/design-notes.md §4–5). The page is ONE
// surface: Section (heading) → Group (the only container) → Row. Never nest
// groups or wrap rows in cards.

export interface SettingsSectionProps extends Omit<React.HTMLAttributes<HTMLElement>, 'title'> {
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Right-aligned header slot for live status (counts, state badges). */
  aside?: React.ReactNode;
}

export function SettingsSection({ title, description, aside, className, children, ...props }: SettingsSectionProps) {
  return (
    <section className={cn('scroll-mt-20 flex flex-col gap-3', className)} {...props}>
      <header className="flex items-end justify-between gap-4 px-1">
        <div className="flex flex-col gap-0.5">
          <h2 className="m-0 text-base font-semibold tracking-tight text-foreground">{title}</h2>
          {description && <p className="m-0 text-[13px] text-muted-foreground">{description}</p>}
        </div>
        {aside && <div className="shrink-0 pb-0.5">{aside}</div>}
      </header>
      {children}
    </section>
  );
}

export function SettingsGroup({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('flex flex-col divide-y divide-border rounded-xl border border-border bg-card', className)}
      {...props}
    />
  );
}

export interface SettingRowProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
  label: React.ReactNode;
  description?: React.ReactNode;
  /** id of the control the label names (renders a <label htmlFor>). */
  htmlFor?: string;
  /** Control rendered on the right rail (inline rows) or below (stacked rows). */
  control?: React.ReactNode;
  /** Full-width content under the label (textareas, lists, editors). */
  stacked?: boolean;
}

export function SettingRow({
  label,
  description,
  htmlFor,
  control,
  stacked,
  className,
  children,
  ...props
}: SettingRowProps) {
  const Label = htmlFor ? 'label' : 'div';
  const text = (
    <div className="flex min-w-0 flex-col gap-0.5">
      <Label
        {...(htmlFor ? { htmlFor } : {})}
        className="text-sm font-medium text-foreground"
      >
        {label}
      </Label>
      {description && <div className="text-[13px] leading-snug text-muted-foreground">{description}</div>}
    </div>
  );
  if (stacked) {
    return (
      <div className={cn('flex flex-col gap-3 px-4 py-3.5', className)} {...props}>
        <div className="flex items-start justify-between gap-4">
          {text}
          {control && <div className="shrink-0">{control}</div>}
        </div>
        {children}
      </div>
    );
  }
  return (
    <div
      className={cn(
        'flex flex-col gap-3 px-4 py-3.5 min-[520px]:flex-row min-[520px]:items-center min-[520px]:justify-between min-[520px]:gap-6',
        className,
      )}
      {...props}
    >
      {text}
      {control && <div className="flex shrink-0 items-center gap-2">{control}</div>}
      {children}
    </div>
  );
}

/** Callout inside a group or section. Tint recipe: bg-<hue>/10 border-<hue>/30 text-<hue>-soft. */
export function Callout({
  tone = 'commit',
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { tone?: 'commit' | 'warning' | 'destructive' | 'neutral' }) {
  const tones = {
    commit: 'border-accent/30 bg-accent/10 text-accent-soft',
    warning: 'border-warning/30 bg-warning/10 text-warning-soft',
    destructive: 'border-destructive/30 bg-destructive/10 text-destructive-soft',
    neutral: 'border-border bg-muted text-muted-foreground',
  } as const;
  return <div className={cn('rounded-lg border px-3.5 py-3 text-[13px] leading-snug', tones[tone], className)} {...props} />;
}
