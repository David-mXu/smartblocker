import React, { useRef } from 'react';
import { cn } from '../../lib/utils';
import { Input } from '../../components/ui/input';

// Radio chips (same look + arrow-key behaviour as the popup's focus-session
// chips) plus a "Custom" chip that reveals hours + minutes fields.

export interface Preset {
  mins: number;
  label: string;
  name: string;
}

export interface DurationValue {
  /** Selected preset minutes, or 'custom'. */
  choice: number | 'custom';
  customHours: string;
  customMinutes: string;
}

export const MAX_MINUTES = 30 * 24 * 60;

/** Resolved minutes, or an error sentence for the custom fields. */
export function resolveMinutes(v: DurationValue): { minutes: number } | { error: string } {
  if (v.choice !== 'custom') return { minutes: v.choice };
  const h = v.customHours.trim() === '' ? 0 : Number(v.customHours);
  const m = v.customMinutes.trim() === '' ? 0 : Number(v.customMinutes);
  if (!Number.isInteger(h) || !Number.isInteger(m) || h < 0 || m < 0) {
    return { error: 'Use whole numbers of hours and minutes.' };
  }
  const total = h * 60 + m;
  if (total < 1) return { error: 'Enter how long, at least 1 minute.' };
  if (total > MAX_MINUTES) return { error: 'The longest is 30 days (720 hours).' };
  return { minutes: total };
}

export function DurationPicker({
  idPrefix,
  label,
  presets,
  value,
  onChange,
  disabled,
}: {
  idPrefix: string;
  label: string;
  presets: Preset[];
  value: DurationValue;
  onChange: (next: DurationValue) => void;
  disabled?: boolean;
}) {
  const chipRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const options: { key: number | 'custom'; label: string; name: string }[] = [
    ...presets.map((p) => ({ key: p.mins as number | 'custom', label: p.label, name: p.name })),
    { key: 'custom', label: 'Custom', name: 'Custom length' },
  ];

  const select = (key: number | 'custom') => onChange({ ...value, choice: key });

  const onChipKey = (e: React.KeyboardEvent, index: number) => {
    const delta =
      e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!delta) return;
    e.preventDefault();
    const next = (index + delta + options.length) % options.length;
    select(options[next].key);
    chipRefs.current[next]?.focus();
  };

  return (
    <div className="flex flex-col gap-2.5">
      <div
        role="radiogroup"
        aria-label={label}
        className={cn(
          'grid gap-1 rounded-lg border border-border bg-background p-0.5',
          options.length === 4 ? 'grid-cols-4' : 'grid-cols-3',
        )}
      >
        {options.map((o, i) => {
          const checked = o.key === value.choice;
          return (
            <button
              key={String(o.key)}
              ref={(el) => {
                chipRefs.current[i] = el;
              }}
              id={`${idPrefix}-${o.key}`}
              type="button"
              role="radio"
              aria-checked={checked}
              aria-label={o.name}
              tabIndex={checked ? 0 : -1}
              disabled={disabled}
              data-mins={o.key}
              onClick={() => select(o.key)}
              onKeyDown={(e) => onChipKey(e, i)}
              className={cn(
                'h-8 cursor-pointer rounded-md text-[13px] font-medium tabular-nums transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring/70 disabled:cursor-not-allowed disabled:opacity-45',
                checked
                  ? 'bg-secondary text-foreground ring-1 ring-faint/40'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              {o.label}
            </button>
          );
        })}
      </div>
      {value.choice === 'custom' && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-[13px] text-muted-foreground">
          <label className="flex items-center gap-2">
            <Input
              id={`${idPrefix}-hours`}
              type="number"
              inputMode="numeric"
              min={0}
              max={720}
              value={value.customHours}
              disabled={disabled}
              onChange={(e) => onChange({ ...value, customHours: e.target.value })}
              className="h-8 w-[72px] font-mono text-[13px] tabular-nums"
            />
            hours
          </label>
          <label className="flex items-center gap-2">
            <Input
              id={`${idPrefix}-minutes`}
              type="number"
              inputMode="numeric"
              min={0}
              max={59}
              value={value.customMinutes}
              disabled={disabled}
              onChange={(e) => onChange({ ...value, customMinutes: e.target.value })}
              className="h-8 w-[72px] font-mono text-[13px] tabular-nums"
            />
            minutes
          </label>
        </div>
      )}
    </div>
  );
}
