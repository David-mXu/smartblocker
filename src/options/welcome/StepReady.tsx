import type { ReactNode } from 'react';
import { ArrowClockwise, CheckCircle, CircleNotch, PushPin, WarningCircle } from '@phosphor-icons/react';
import type { VerifyProtectionResponse } from '../../shared/messages';
import { Button } from '../../components/ui/button';
import { Callout } from '../../components/ui/settings';
import { displayLabel } from './categories';

// Step 3 — "Verify your protection": fresh inference/access diagnostics gate
// completion, followed by the settings summary, how it works, incognito blind
// spot, and pin hint. The primary "Start blocking" lives in the wizard footer.

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
  verificationStatus: 'checking' | VerifyProtectionResponse['status'];
  verificationReport: VerifyProtectionResponse | null;
  verificationError: string | null;
  completionPending: boolean;
  onRetryVerification: () => void;
  onContinueUnverified: () => void;
}

function SummaryRow({ label, value, onEdit, editLabel, disabled = false }: { label: string; value: ReactNode; onEdit: () => void; editLabel: string; disabled?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-4 px-4 py-3">
      <div className="flex min-w-0 flex-col gap-0.5">
        <dt className="text-[13px] text-muted-foreground">{label}</dt>
        <dd className="m-0 text-sm font-medium text-foreground">{value}</dd>
      </div>
      <Button variant="ghost" size="xs" className="shrink-0" aria-label={editLabel} disabled={disabled} onClick={onEdit}>
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
  verificationStatus,
  verificationReport,
  verificationError,
  completionPending,
  onRetryVerification,
  onContinueUnverified,
}: StepReadyProps) {
  const names = blockedLabels.map(displayLabel);
  const shown = names.slice(0, 3).join(', ');
  const more = names.length > 3 ? ` and ${names.length - 3} more` : '';
  const goal = focusGoal.trim();
  const verificationHeading = completionPending
    ? 'Finishing verified setup…'
    : {
        checking: 'Checking protection…',
        ready: 'Protection verified',
        degraded: 'Protection needs attention',
        error: 'Protection check couldn’t finish',
      }[verificationStatus];
  const verificationSummary = completionPending
    ? 'The background is confirming fresh protection checks before saving. Please keep this step open.'
    : {
        checking: 'Running fresh inference for one distraction and one productive title. No test tabs are opened.',
        ready: 'Fresh inference, both block/allow decisions, and all-site access passed for this browser profile.',
        degraded: 'SmartBlocker is not marking setup complete. Review the specific check below, then retry.',
        error: 'SmartBlocker could not prove protection. No successful verification was saved.',
      }[verificationStatus];

  return (
    <div className="flex flex-col gap-8">
      <section aria-labelledby="welcome-verification-heading" aria-busy={verificationStatus === 'checking'}>
        <Callout
          id="welcome-verification"
          data-state={verificationStatus}
          tone={verificationStatus === 'ready' ? 'commit' : verificationStatus === 'degraded' ? 'warning' : verificationStatus === 'error' ? 'destructive' : 'neutral'}
          className="flex flex-col gap-3"
        >
          <div className="flex items-start gap-2.5">
            {verificationStatus === 'checking' ? (
              <CircleNotch aria-hidden className="mt-0.5 size-4 shrink-0 animate-spin" />
            ) : verificationStatus === 'ready' ? (
              <CheckCircle aria-hidden weight="fill" className="mt-0.5 size-4 shrink-0 text-success" />
            ) : (
              <WarningCircle aria-hidden weight="fill" className="mt-0.5 size-4 shrink-0" />
            )}
            <div className="flex flex-col gap-1" role="status" aria-live="polite">
              <h2 id="welcome-verification-heading" className="m-0 text-sm font-semibold text-foreground">
                {verificationHeading}
              </h2>
              <p className="m-0 text-muted-foreground">{verificationSummary}</p>
            </div>
          </div>

          {verificationStatus === 'checking' && !verificationReport && (
            <ul className="m-0 flex list-none flex-col gap-2 p-0 pl-6 text-muted-foreground">
              <li>Confirm all-site browser access</li>
              <li>Block “Elden Ring Boss Fight”</li>
              <li>Allow “React Router Tutorial”</li>
            </ul>
          )}

          {verificationReport && verificationReport.checks.length > 0 && (
            <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
              {verificationReport.checks.map((check) => (
                <li
                  key={check.id}
                  id={`protection-check-${check.id}`}
                  data-status={check.status}
                  className="flex items-start gap-2"
                >
                  {check.status === 'passed' ? (
                    <CheckCircle aria-hidden weight="fill" className="mt-0.5 size-4 shrink-0 text-success" />
                  ) : (
                    <WarningCircle aria-hidden className="mt-0.5 size-4 shrink-0" />
                  )}
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="font-medium text-foreground">{check.label}</span>
                    <span className="break-words text-muted-foreground">{check.detail}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}

          {verificationError && <p className="m-0 break-words">{verificationError}</p>}

          {verificationStatus !== 'ready' && (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                id="welcome-retry-verification"
                variant="outline"
                size="sm"
                disabled={verificationStatus === 'checking'}
                onClick={onRetryVerification}
              >
                <ArrowClockwise aria-hidden className="size-4" />
                Retry checks
              </Button>
              {verificationReport?.checks.some((check) => check.id === 'site-access' && check.status !== 'passed') &&
                onOpenExtensionSettings && (
                  <Button variant="outline" size="sm" onClick={onOpenExtensionSettings}>
                    Open extension settings
                  </Button>
                )}
              {verificationStatus === 'degraded' && (
                <Button variant="ghost" size="sm" onClick={() => onEditStep(0)}>
                  Change categories
                </Button>
              )}
              <Button id="welcome-continue-unverified" variant="ghost" size="sm" disabled={completionPending} onClick={onContinueUnverified}>
                Continue without verification
              </Button>
            </div>
          )}
          {verificationStatus !== 'ready' && (
            <p className="m-0 text-xs text-muted-foreground">
              Continuing leaves setup unfinished; no verified-protection status is saved.
            </p>
          )}
        </Callout>
      </section>

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
          disabled={completionPending}
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
          disabled={completionPending}
        />
        <SummaryRow
          label="Focus goal"
          value={goal ? <span className="break-words">{goal}</span> : <span className="font-normal text-faint">Not set</span>}
          editLabel="Change focus goal"
          onEdit={() => onEditStep(1)}
          disabled={completionPending}
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
