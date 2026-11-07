import type { ReactNode } from 'react';
import { CheckCircle, PushPin } from '@phosphor-icons/react';
import { Button } from '../../components/ui/button';
import { Callout } from '../../components/ui/settings';
import { displayLabel } from './categories';

// Step 3 — "You're all set": summary of the choices (lands on a real state,
// not a promise), how it works in three lines, the incognito blind spot, and
// the pin hint. The primary "Start blocking" lives in the wizard footer.

export interface StepReadyProps {
  blockedLabels: string[];
  allowedCount: number;
  focusGoal: string;
  /** null = unknown (API unavailable); hide the callout. */
  incognitoAllowed: boolean | null;
  isFirefox: boolean;
  onEditStep: (step: number) => void;
  onOpenExtensionSettings: (() => void) | null;
  onRecheckIncognito: () => void;
}

function SummaryRow({ label, value, onEdit, editLabel }: { label: string; value: ReactNode; onEdit: () => void; editLabel: string }) {
  return (
    <div className="flex items-start justify-between gap-4 px-4 py-3">
      <div className="flex min-w-0 flex-col gap-0.5">
        <dt className="text-[13px] text-muted-foreground">{label}</dt>
        <dd className="m-0 text-sm font-medium text-foreground">{value}</dd>
      </div>
      <Button variant="ghost" size="xs" className="shrink-0" aria-label={editLabel} onClick={onEdit}>
        Change
      </Button>
    </div>
  );
}

export function StepReady({
  blockedLabels,
  allowedCount,
  focusGoal,
  incognitoAllowed,
  isFirefox,
  onEditStep,
  onOpenExtensionSettings,
  onRecheckIncognito,
}: StepReadyProps) {
  const names = blockedLabels.map(displayLabel);
  const shown = names.slice(0, 3).join(', ');
  const more = names.length > 3 ? ` and ${names.length - 3} more` : '';
  const goal = focusGoal.trim();

  return (
    <div className="flex flex-col gap-8">
      <dl id="welcome-summary" className="m-0 flex flex-col divide-y divide-border rounded-xl border border-border bg-card">
        <SummaryRow
          label={`Blocking ${blockedLabels.length} ${blockedLabels.length === 1 ? 'category' : 'categories'}`}
          value={
            <span className="font-normal text-foreground">
              {shown}
              {more}
            </span>
          }
          editLabel="Change blocked categories"
          onEdit={() => onEditStep(0)}
        />
        <SummaryRow
          label="Always allowed"
          value={
            <span className="tabular-nums">
              {allowedCount} {allowedCount === 1 ? 'site' : 'sites'}
            </span>
          }
          editLabel="Change allowed sites"
          onEdit={() => onEditStep(1)}
        />
        <SummaryRow
          label="Focus goal"
          value={goal ? <span className="break-words">{goal}</span> : <span className="font-normal text-faint">Not set</span>}
          editLabel="Change focus goal"
          onEdit={() => onEditStep(1)}
        />
      </dl>

      <section aria-labelledby="welcome-how" className="flex flex-col gap-3">
        <h2 id="welcome-how" className="m-0 text-base font-semibold tracking-tight text-foreground">
          How it works
        </h2>
        <ol className="m-0 flex list-none flex-col gap-3 p-0">
          {[
            'SmartBlocker reads each page’s title and checks it on this device. Nothing is sent anywhere.',
            'If a page matches what you block, it’s paused behind a quiet screen. “Stay focused” closes the tab.',
            'The toolbar button shows why a page was or wasn’t blocked, and lets you fix a wrong call.',
          ].map((text, i) => (
            <li key={i} className="flex items-start gap-3 text-sm text-muted-foreground">
              <span
                aria-hidden
                className="mt-px flex size-5 shrink-0 items-center justify-center rounded-full border border-border text-[11px] font-medium tabular-nums text-foreground"
              >
                {i + 1}
              </span>
              <span>{text}</span>
            </li>
          ))}
        </ol>
      </section>

      <div className="flex flex-col gap-3">
        {incognitoAllowed === false && (
          <Callout id="welcome-incognito" tone="warning" className="flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <p className="m-0 font-medium">Private windows aren’t covered yet</p>
              <p className="m-0 text-muted-foreground">
                {isFirefox ? (
                  <>
                    Open <span className="text-foreground">Add-ons and themes</span> → SmartBlocker, then set{' '}
                    <span className="text-foreground">Run in Private Windows</span> to Allow.
                  </>
                ) : (
                  <>
                    Open <span className="text-foreground">Extensions</span> → SmartBlocker →{' '}
                    <span className="text-foreground">Details</span>, then turn on{' '}
                    <span className="text-foreground">Allow in Incognito</span>.
                  </>
                )}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {onOpenExtensionSettings && (
                <Button variant="outline" size="sm" onClick={onOpenExtensionSettings}>
                  Open extension settings
                </Button>
              )}
              <Button variant="ghost" size="sm" onClick={onRecheckIncognito}>
                Check again
              </Button>
            </div>
          </Callout>
        )}
        {incognitoAllowed === true && (
          <p className="m-0 flex items-center gap-2 px-1 text-[13px] text-muted-foreground">
            <CheckCircle aria-hidden weight="fill" className="size-4 text-success" />
            Private windows are covered too.
          </p>
        )}
        <Callout tone="neutral" className="flex items-start gap-3">
          <PushPin aria-hidden className="mt-0.5 size-4 shrink-0 text-foreground" />
          <p className="m-0">
            <span className="font-medium text-foreground">Pin SmartBlocker to your toolbar.</span> Click the
            puzzle-piece icon next to the address bar, then the pin beside SmartBlocker.
          </p>
        </Callout>
      </div>
    </div>
  );
}
