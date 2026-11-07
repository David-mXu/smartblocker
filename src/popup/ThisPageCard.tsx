import React, { useEffect, useRef, useState } from 'react';
import { LockSimple } from '@phosphor-icons/react';
import { Button } from '../components/ui/button';
import { Select } from '../components/ui/select';
import { cn } from '../lib/utils';
import { sentenceCase, type PageView } from './popup-model';

interface Props {
  /** null while the first load is still in flight (reserved-height placeholder). */
  view: PageView | null;
  locked: boolean;
  lockedReason: string;
  /** Categories offered by "Should've been blocked" (the blocked ones). */
  reportLabels: string[];
  onTurnOn: () => void;
  onAllowSite: () => void;
  onRemoveAllowed: () => void;
  onReport: (label: string) => Promise<boolean>;
}

const DOT: Record<PageView['tone'], string> = {
  allowed: 'bg-success',
  blocked: 'bg-destructive',
  neutral: 'bg-faint',
};

/**
 * The popup's focal element: what SmartBlocker decided about the active tab,
 * in one sentence, plus the action that fixes it if it's wrong.
 *
 * Height is reserved (min-h) and the "Should've been blocked" flow swaps the
 * action row IN PLACE (category select + Report + Cancel) instead of
 * expanding below it, so nothing in the popup moves.
 */
export function ThisPageCard({
  view,
  locked,
  lockedReason,
  reportLabels,
  onTurnOn,
  onAllowSite,
  onRemoveAllowed,
  onReport,
}: Props) {
  const [reporting, setReporting] = useState(false);
  const [reportLabel, setReportLabel] = useState(reportLabels[0] ?? '');
  const selectRef = useRef<HTMLSelectElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);

  useEffect(() => {
    setReportLabel((prev) => (reportLabels.includes(prev) ? prev : (reportLabels[0] ?? '')));
  }, [reportLabels]);

  // A different verdict (tab changed, page re-checked, lock started) ends the report flow.
  const viewKey = view ? `${view.where}|${view.headline}|${view.detail}|${locked}` : '';
  useEffect(() => setReporting(false), [viewKey]);

  useEffect(() => {
    if (reporting) selectRef.current?.focus();
    else if (returnFocus.current) {
      returnFocus.current = false;
      triggerRef.current?.focus();
    }
  }, [reporting]);

  const closeReport = () => {
    returnFocus.current = true;
    setReporting(false);
  };

  const hasActions =
    !!view && (view.paused || view.allowedBy.length > 0 || view.canReport || view.canAllowSite);

  const removeLabel =
    view && view.allowedBy.length === 1 && view.allowedBy[0] !== view.where
      ? `Remove ${view.allowedBy[0]} from allowed`
      : 'Remove from allowed';

  const lockTitle = locked ? lockedReason : undefined;

  let actions: React.ReactNode = null;
  if (view && hasActions) {
    if (reporting) {
      actions = (
        <>
          <Select
            id="report-category"
            ref={selectRef}
            aria-label="What is this page?"
            value={reportLabel}
            onChange={(e) => setReportLabel(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && closeReport()}
            className="h-8 min-w-0 flex-1 text-[13px]"
          >
            {reportLabels.map((label) => (
              <option key={label} value={label}>
                {sentenceCase(label)}
              </option>
            ))}
          </Select>
          <Button
            id="report-fn"
            variant="secondary"
            size="sm"
            className="shrink-0"
            onClick={() => {
              void onReport(reportLabel).then((ok) => ok && closeReport());
            }}
          >
            Report
          </Button>
          <Button variant="ghost" size="sm" className="shrink-0 px-2.5" onClick={closeReport}>
            Cancel
          </Button>
        </>
      );
    } else if (view.paused) {
      actions = (
        <Button id="turn-on-blocking" size="sm" onClick={onTurnOn} disabled={locked} title={lockTitle}>
          Turn blocking on
        </Button>
      );
    } else if (view.allowedBy.length > 0) {
      actions = (
        <Button
          id="remove-allowed-site"
          variant="outline"
          size="sm"
          onClick={onRemoveAllowed}
          disabled={locked}
          title={lockTitle}
        >
          {removeLabel}
        </Button>
      );
    } else {
      actions = (
        <>
          {view.canReport && (
            <Button
              id="should-have-blocked"
              ref={triggerRef}
              variant="outline"
              size="xs"
              onClick={() => setReporting(true)}
              disabled={locked || reportLabels.length === 0}
              title={lockTitle}
            >
              Should’ve been blocked
            </Button>
          )}
          {view.canAllowSite && (
            <Button
              id="always-allow-site"
              variant="outline"
              size="xs"
              onClick={onAllowSite}
              disabled={locked}
              title={lockTitle}
            >
              Always allow this site
            </Button>
          )}
        </>
      );
    }
  }

  return (
    <section
      aria-labelledby="this-page-heading"
      aria-busy={view === null}
      className="flex min-h-[140px] flex-col rounded-xl border border-border bg-card p-4"
    >
      <p className="m-0 flex min-w-0 items-baseline gap-1.5 text-xs text-faint">
        <span id="this-page-heading" className="shrink-0">
          This page
        </span>
        {view?.where && (
          <>
            <span aria-hidden>·</span>
            <span
              id="page-host"
              className={cn('truncate text-muted-foreground', /[.:]/.test(view.where) && 'font-mono')}
            >
              {view.where}
            </span>
          </>
        )}
      </p>

      {view === null ? (
        <p className="m-0 mt-2 text-[13px] text-muted-foreground">Checking this page…</p>
      ) : (
        <div id="page-verdict" className="mt-2 flex flex-col gap-1">
          <p className="m-0 flex items-center gap-2 text-base font-semibold tracking-tight">
            <span aria-hidden className={cn('size-2 shrink-0 rounded-full', DOT[view.tone])} />
            {view.headline}
          </p>
          <p className="m-0 text-[13px] text-muted-foreground">
            {reporting ? 'Pick what it is — SmartBlocker will learn from it.' : view.detail}
          </p>
        </div>
      )}

      {actions && <div className="mt-auto flex items-center gap-2 pt-3">{actions}</div>}

      {locked && hasActions && (
        <p className="m-0 mt-2 flex items-center gap-1.5 text-xs text-faint">
          <LockSimple weight="fill" className="size-3 text-accent" aria-hidden />
          {lockedReason}.
        </p>
      )}
    </section>
  );
}
