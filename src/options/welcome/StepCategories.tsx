import * as React from 'react';
import { X } from '@phosphor-icons/react';
import { Button } from '../../components/ui/button';
import { Checkbox } from '../../components/ui/checkbox';
import { Input } from '../../components/ui/input';
import { displayLabel, labelExample } from './categories';

// Step 1 — "What pulls you off track?" (Opal "Choose your biggest
// distractions" pattern: master "all" row, live counter, pre-selected
// defaults so Continue works immediately.)

export interface StepCategoriesProps {
  labels: string[];
  blocked: Set<string>;
  /** Labels added during this wizard run — removable here. */
  addedHere: Set<string>;
  disabled: boolean;
  disabledReason?: string;
  onToggle: (label: string, on: boolean) => void;
  onToggleAll: (on: boolean) => void;
  /** Returns an error message, or null when the label was added. */
  onAdd: (label: string) => string | null;
  onRemove: (label: string) => void;
}

export function StepCategories({
  labels,
  blocked,
  addedHere,
  disabled,
  disabledReason,
  onToggle,
  onToggleAll,
  onAdd,
  onRemove,
}: StepCategoriesProps) {
  const [draft, setDraft] = React.useState('');
  const [addMsg, setAddMsg] = React.useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const masterRef = React.useRef<HTMLInputElement>(null);

  const count = labels.filter((l) => blocked.has(l)).length;
  const all = labels.length > 0 && count === labels.length;
  const some = count > 0 && !all;

  React.useEffect(() => {
    if (masterRef.current) masterRef.current.indeterminate = some;
  }, [some]);

  const add = () => {
    const err = onAdd(draft);
    if (err) {
      setAddMsg({ tone: 'error', text: err });
      return;
    }
    setAddMsg({ tone: 'ok', text: `Added ${displayLabel(draft.trim().toLowerCase())}` });
    setDraft('');
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col divide-y divide-border rounded-xl border border-border bg-card">
        <div className="flex min-h-12 items-center gap-3 pr-4 transition-colors hover:bg-muted">
          <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 self-stretch py-3 pl-4 has-[:disabled]:cursor-not-allowed">
            <span className="relative inline-flex">
              <Checkbox
                ref={masterRef}
                id="welcome-select-all"
                checked={all}
                disabled={disabled}
                onChange={(e) => onToggleAll(e.target.checked)}
              />
              {/* Mixed state: the shared Checkbox only draws a tick, so draw the dash here. */}
              {some && (
                <span
                  aria-hidden
                  className="pointer-events-none absolute left-1/2 top-1/2 h-0.5 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground"
                />
              )}
            </span>
            <span className="text-sm font-medium text-foreground">Block all of these</span>
          </label>
          <span
            id="welcome-selected-count"
            role="status"
            aria-live="polite"
            className="shrink-0 text-[13px] tabular-nums text-muted-foreground"
          >
            {count} selected
          </span>
        </div>

        <ul id="welcome-category-list" aria-label="Categories" className="m-0 flex list-none flex-col divide-y divide-border p-0">
          {labels.map((label) => {
            const example = labelExample(label);
            const id = `welcome-cat-${label.replace(/[^a-z0-9]+/gi, '-')}`;
            return (
              <li key={label} className="flex items-stretch">
                <label
                  htmlFor={id}
                  className="flex min-h-12 min-w-0 flex-1 cursor-pointer items-start gap-3 px-4 py-3 transition-colors hover:bg-muted has-[:disabled]:cursor-not-allowed"
                >
                  <Checkbox
                    id={id}
                    className="mt-0.5"
                    checked={blocked.has(label)}
                    disabled={disabled}
                    onChange={(e) => onToggle(label, e.target.checked)}
                  />
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="text-sm font-medium text-foreground">{displayLabel(label)}</span>
                    {example ? (
                      <span className="text-[13px] leading-snug text-muted-foreground">{example}</span>
                    ) : (
                      <span className="text-[13px] leading-snug text-faint">Your category</span>
                    )}
                  </span>
                </label>
                {addedHere.has(label) && (
                  <div className="flex items-center pr-2">
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Remove ${displayLabel(label)}`}
                      disabled={disabled}
                      onClick={() => onRemove(label)}
                    >
                      <X className="size-3.5" />
                    </Button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </div>

      <div className="flex flex-col gap-2">
        <label htmlFor="welcome-custom-category" className="text-sm font-medium text-foreground">
          Add your own <span className="font-normal text-faint">(optional)</span>
        </label>
        <div className="flex items-center gap-2">
          <Input
            id="welcome-custom-category"
            value={draft}
            placeholder="e.g. cooking and recipes"
            maxLength={60}
            autoComplete="off"
            disabled={disabled}
            aria-describedby="welcome-custom-category-help"
            onChange={(e) => {
              setDraft(e.target.value);
              if (addMsg?.tone === 'error') setAddMsg(null);
            }}
            onKeyDown={(e) => {
              // Enter here adds the category — it must NOT also continue.
              if (e.key === 'Enter') {
                e.preventDefault();
                if (draft.trim()) add();
              }
            }}
          />
          <Button variant="secondary" className="shrink-0" disabled={disabled || !draft.trim()} onClick={add}>
            Add
          </Button>
        </div>
        <p
          id="welcome-custom-category-help"
          role="status"
          aria-live="polite"
          className={addMsg?.tone === 'error' ? 'm-0 text-xs text-destructive-soft' : 'm-0 text-xs text-faint'}
        >
          {disabled && disabledReason
            ? disabledReason
            : (addMsg?.text ?? 'Describe it in a few words. SmartBlocker matches pages by meaning, not keywords.')}
        </p>
      </div>
    </div>
  );
}
