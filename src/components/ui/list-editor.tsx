import * as React from 'react';
import { MagnifyingGlass, X } from '@phosphor-icons/react';
import { cn } from '../../lib/utils';
import { mergeEntries, splitEntries } from '../../shared/domains';
import { Button } from './button';
import { Input } from './input';
import { Textarea } from './textarea';

// Add-field + removable-rows list editor (docs/design-notes.md §4).
// Used for "Always allow" (domains) and "Always block" (keywords) on the
// options Sites page and in the welcome wizard.
//
// Save semantics (web-ux-research: never mix autosave + Save in one form):
// adding/removing a row calls onChange immediately (the caller persists);
// "Edit as text" is the one explicit-save mode — Save list / Cancel.

export interface ListEditorProps {
  /** Root element id (e.g. "whitelist"). Input gets `${id}-input`. */
  id: string;
  items: string[];
  onChange: (next: string[]) => void;
  /** 'domain' normalizes pasted URLs to hosts; 'keyword' keeps substrings. */
  mode: 'domain' | 'keyword';
  /** Accessible name of the add field, e.g. "Add an allowed site". */
  inputLabel: string;
  placeholder?: string;
  addLabel?: string;
  /** Shown when the list is empty. */
  emptyText?: string;
  disabled?: boolean;
  /** Reason shown when disabled (e.g. "Locked until 3:40 PM"). */
  disabledReason?: string;
  className?: string;
}

const SEARCH_AT = 8;

export function ListEditor({
  id,
  items,
  onChange,
  mode,
  inputLabel,
  placeholder,
  addLabel = 'Add',
  emptyText = 'Nothing here yet.',
  disabled,
  disabledReason,
  className,
}: ListEditorProps) {
  const [draft, setDraft] = React.useState('');
  const [query, setQuery] = React.useState('');
  const [message, setMessage] = React.useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [textMode, setTextMode] = React.useState(false);
  const [textDraft, setTextDraft] = React.useState('');

  const add = (raw: string) => {
    const inputs = splitEntries(raw, mode);
    if (inputs.length === 0) return;
    const r = mergeEntries(items, inputs, mode);
    if (r.added.length) onChange(r.items);
    if (r.invalid.length) {
      setMessage({ tone: 'error', text: r.invalid[0].error });
      // Keep only the invalid text so the user can fix it.
      setDraft(r.invalid.map((i) => i.input).join(', '));
      return;
    }
    setDraft('');
    if (r.added.length === 1) setMessage({ tone: 'ok', text: `Added ${r.added[0]}` });
    else if (r.added.length > 1) setMessage({ tone: 'ok', text: `Added ${r.added.length} entries` });
    else if (r.duplicates.length) setMessage({ tone: 'ok', text: `${r.duplicates[0]} is already listed` });
  };

  const remove = (item: string) => {
    onChange(items.filter((i) => i !== item));
    setMessage({ tone: 'ok', text: `Removed ${item}` });
  };

  const openTextMode = () => {
    setTextDraft(items.join('\n'));
    setTextMode(true);
    setMessage(null);
  };

  const saveText = () => {
    const r = mergeEntries([], splitEntries(textDraft, mode), mode);
    onChange(r.items);
    setTextMode(false);
    setMessage(
      r.invalid.length
        ? { tone: 'error', text: `Saved ${r.items.length}; skipped ${r.invalid.length} invalid (${r.invalid[0].input})` }
        : { tone: 'ok', text: `Saved ${r.items.length} entries` },
    );
  };

  const q = query.trim().toLowerCase();
  const visible = q ? items.filter((i) => i.toLowerCase().includes(q)) : items;

  return (
    <div id={id} className={cn('flex flex-col gap-2.5', className)}>
      {textMode ? (
        <>
          <Textarea
            id={`${id}-text`}
            aria-label={`${inputLabel} — one per line`}
            value={textDraft}
            onChange={(e) => setTextDraft(e.target.value)}
            disabled={disabled}
            rows={Math.min(14, Math.max(6, items.length + 1))}
            spellCheck={false}
          />
          <div className="flex items-center justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setTextMode(false)}>
              Cancel
            </Button>
            <Button variant="secondary" size="sm" onClick={saveText} disabled={disabled}>
              Save list
            </Button>
          </div>
        </>
      ) : (
        <>
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              add(draft);
            }}
          >
            <Input
              id={`${id}-input`}
              aria-label={inputLabel}
              value={draft}
              placeholder={placeholder}
              disabled={disabled}
              spellCheck={false}
              autoComplete="off"
              className="font-mono text-[13px]"
              onChange={(e) => {
                setDraft(e.target.value);
                if (message?.tone === 'error') setMessage(null);
              }}
              onPaste={(e) => {
                const text = e.clipboardData.getData('text');
                if (splitEntries(text, mode).length > 1) {
                  e.preventDefault();
                  add(text);
                }
              }}
            />
            <Button type="submit" variant="secondary" disabled={disabled || !draft.trim()} className="shrink-0">
              {addLabel}
            </Button>
          </form>

          {items.length > SEARCH_AT && (
            <div className="relative">
              <MagnifyingGlass
                aria-hidden
                className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-faint"
              />
              <Input
                type="search"
                aria-label={`Search ${inputLabel.toLowerCase()}`}
                placeholder={`Search ${items.length} entries`}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="h-8 pl-8 text-[13px]"
              />
            </div>
          )}

          {items.length === 0 ? (
            <p className="m-0 rounded-lg border border-dashed border-border px-3 py-3 text-[13px] text-faint">
              {emptyText}
            </p>
          ) : (
            <ul
              aria-label={inputLabel.replace(/^Add (an? )?/i, '')}
              className="m-0 flex max-h-[264px] list-none flex-col divide-y divide-border overflow-y-auto rounded-lg border border-border bg-background p-0"
            >
              {visible.map((item) => (
                <li key={item} className="list-row flex items-center justify-between gap-3 py-1 pl-3 pr-1">
                  <span className="min-w-0 truncate font-mono text-[13px] text-foreground">{item}</span>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="list-remove size-7"
                    aria-label={`Remove ${item}`}
                    title={disabled ? disabledReason : `Remove ${item}`}
                    disabled={disabled}
                    onClick={() => remove(item)}
                  >
                    <X className="size-3.5" />
                  </Button>
                </li>
              ))}
              {visible.length === 0 && (
                <li className="px-3 py-2.5 text-[13px] text-faint">No entries match “{query}”.</li>
              )}
            </ul>
          )}
        </>
      )}

      <div className="flex min-h-5 items-center justify-between gap-3">
        <p
          role="status"
          aria-live="polite"
          className={cn('m-0 text-xs', message?.tone === 'error' ? 'text-destructive-soft' : 'text-faint')}
        >
          {disabled && disabledReason ? disabledReason : (message?.text ?? '')}
        </p>
        {!textMode && (
          <Button variant="ghost" size="xs" onClick={openTextMode} disabled={disabled} className="shrink-0">
            Edit as text
          </Button>
        )}
      </div>
    </div>
  );
}
