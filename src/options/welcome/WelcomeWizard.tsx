import * as React from 'react';
import { ArrowLeft, LockSimple } from '@phosphor-icons/react';
import { cn } from '../../lib/utils';
import { api, IS_FIREFOX } from '../../shared/api';
import { getLockStatus } from '../../shared/lock';
import { getSettings, setSettings, type Settings } from '../../shared/settings';
import type { CompleteOnboardingResponse, VerifyProtectionResponse } from '../../shared/messages';
import { Button } from '../../components/ui/button';
import { Callout } from '../../components/ui/settings';
import { StepCategories } from './StepCategories';
import { StepReady } from './StepReady';
import { StepSites } from './StepSites';

// First-run welcome wizard, rendered by OptionsApp at options.html#welcome
// (TEAM-SPEC "Welcome wizard"; research: 3 steps, preserve state, extension
// already works if skipped). Contract: the successful finish persists
// `onboarded: true` only after fresh protection checks return `ready`.
// "Set up later" / "Continue without verification" leave setup unfinished so
// the options page keeps its "Finish setup" banner.
//
// Persistence: each step is written with setSettings() on Continue (it THROWS
// while a lock is active — every call is try/caught and the reason shown).
// The current step index is a per-viewer convenience in localStorage so a
// closed tab resumes where it left off; the data itself is already saved.

export interface WelcomeWizardProps {
  onFinish: () => void;
}

const STEPS = [
  { title: 'What pulls you off track?', short: 'Distractions', subtitle: 'Pick what SmartBlocker should block. Your choices stay on this device.' },
  { title: 'What should always stay open?', short: 'Always open', subtitle: 'Sites you rely on for work are never checked. Both parts are optional.' },
  { title: 'Verify your protection', short: 'Ready', subtitle: 'Two fresh on-device checks must pass before setup is complete.' },
] as const;

const STEP_KEY = 'smartblocker.welcomeStep';

function readStoredStep(): number {
  try {
    const n = Number(localStorage.getItem(STEP_KEY));
    return Number.isInteger(n) && n >= 0 && n < STEPS.length ? n : 0;
  } catch {
    return 0;
  }
}

function storeStep(step: number | null) {
  try {
    if (step === null) localStorage.removeItem(STEP_KEY);
    else localStorage.setItem(STEP_KEY, String(step));
  } catch {
    // Storage blocked — resuming is a convenience only.
  }
}

function formatUntil(until: number | null | undefined): string {
  if (!until) return 'Settings are locked by a password lock, so changes can’t be saved until it’s unlocked.';
  const d = new Date(until);
  const sameDay = d.toDateString() === new Date().toDateString();
  const when = sameDay
    ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  return `Settings are locked until ${when}, so changes can’t be saved until then.`;
}

function errorText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return /locked/i.test(msg) ? `Couldn’t save — ${msg.replace(/^SmartBlocker settings are/i, 'settings are')}.` : `Couldn’t save: ${msg}`;
}

type Loaded = Pick<Settings, 'labels' | 'blockedLabels' | 'deletedBuiltinLabels' | 'whitelist' | 'focusGoal'>;

export function WelcomeWizard({ onFinish }: WelcomeWizardProps) {
  const [step, setStep] = React.useState(readStoredStep);
  const [loaded, setLoaded] = React.useState<Loaded | null>(null);
  const [labels, setLabels] = React.useState<string[]>([]);
  // Display order, fixed at load: recommended (pre-checked) first, then the
  // rest; rows never jump while toggling. `labels` keeps the stored order.
  const [order, setOrder] = React.useState<string[]>([]);
  const [blocked, setBlocked] = React.useState<Set<string>>(new Set());
  const [deletedBuiltins, setDeletedBuiltins] = React.useState<Set<string>>(new Set());
  const [addedHere, setAddedHere] = React.useState<Set<string>>(new Set());
  const [focusGoal, setFocusGoal] = React.useState('');
  const [whitelist, setWhitelist] = React.useState<string[]>([]);
  const [lockReason, setLockReason] = React.useState<string | null>(null);
  const [incognitoAllowed, setIncognitoAllowed] = React.useState<boolean | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [completing, setCompleting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [verificationStatus, setVerificationStatus] = React.useState<
    'checking' | VerifyProtectionResponse['status']
  >('checking');
  const [verificationReport, setVerificationReport] = React.useState<VerifyProtectionResponse | null>(null);
  const [verificationError, setVerificationError] = React.useState<string | null>(null);
  const headingRef = React.useRef<HTMLHeadingElement>(null);
  const firstRender = React.useRef(true);
  const verificationGeneration = React.useRef(0);
  const stepRef = React.useRef(step);
  const completingRef = React.useRef(completing);
  const verificationStatusRef = React.useRef(verificationStatus);
  stepRef.current = step;
  completingRef.current = completing;
  verificationStatusRef.current = verificationStatus;

  // ── Load ────────────────────────────────────────────────────────────────
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      const s = await getSettings();
      if (cancelled) return;
      setLoaded(s);
      const pre = new Set(s.blockedLabels.filter((l) => s.labels.includes(l)));
      setLabels(s.labels);
      setOrder([...s.labels.filter((l) => pre.has(l)), ...s.labels.filter((l) => !pre.has(l))]);
      setBlocked(pre);
      setDeletedBuiltins(new Set(s.deletedBuiltinLabels));
      setFocusGoal(s.focusGoal);
      setWhitelist(s.whitelist);
      try {
        const lock = await getLockStatus();
        if (!cancelled && lock.settingsLocked) {
          setLockReason(formatUntil(lock.until) + (lock.forceBlocking ? ' Blocking stays on in the meantime.' : ''));
        }
      } catch {
        // Lock state unreadable — setSettings will still refuse and we show that.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const checkIncognito = React.useCallback(async () => {
    try {
      if (typeof api.extension?.isAllowedIncognitoAccess !== 'function') return setIncognitoAllowed(null);
      setIncognitoAllowed(Boolean(await api.extension.isAllowedIncognitoAccess()));
    } catch {
      setIncognitoAllowed(null);
    }
  }, []);

  // Re-check when the user comes back from the extensions page.
  React.useEffect(() => {
    void checkIncognito();
    const onVisible = () => {
      if (document.visibilityState === 'visible') void checkIncognito();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, [checkIncognito]);

  const runProtectionVerification = React.useCallback(async () => {
    const generation = ++verificationGeneration.current;
    setVerificationStatus('checking');
    setVerificationReport(null);
    setVerificationError(null);
    try {
      const report: VerifyProtectionResponse = await api.runtime.sendMessage({ type: 'VERIFY_PROTECTION' });
      if (!report || !['ready', 'degraded', 'error'].includes(report.status)) {
        throw new Error(report?.error || 'the background worker returned an invalid report');
      }
      if (generation !== verificationGeneration.current || stepRef.current !== STEPS.length - 1) return;
      setVerificationReport(report);
      setVerificationStatus(report.status);
      setVerificationError(report.error ?? null);
    } catch (e) {
      if (generation !== verificationGeneration.current || stepRef.current !== STEPS.length - 1) return;
      const message = e instanceof Error ? e.message : String(e);
      setVerificationReport(null);
      setVerificationStatus('error');
      setVerificationError(`Protection verification could not finish: ${message}. Retry, or continue without verification.`);
    }
  }, []);

  React.useEffect(() => {
    if (step === STEPS.length - 1 && loaded && lockReason === null) void runProtectionVerification();
    return () => {
      // Invalidate any slower run when leaving the step (or unmounting), so a
      // stale `ready` can never overwrite a newer configuration check.
      verificationGeneration.current += 1;
    };
  }, [step, loaded, lockReason, runProtectionVerification]);

  // A second options tab can change the policy after this preview passed.
  // Invalidate immediately, then coalesce autosave bursts into one fresh run.
  // Returning focus covers browser permission changes not written to storage.
  React.useEffect(() => {
    let retryTimer: number | undefined;
    const policyOf = (value: unknown) => {
      const settings = value as Partial<Settings> | undefined;
      return JSON.stringify([settings?.labels, settings?.blockedLabels, settings?.blockThreshold]);
    };
    const invalidatePolicyPreview = () => {
      if (stepRef.current !== STEPS.length - 1 || completingRef.current) return;
      verificationGeneration.current += 1;
      setVerificationStatus('checking');
      setVerificationReport(null);
      setVerificationError(null);
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      retryTimer = window.setTimeout(() => void runProtectionVerification(), 100);
    };
    const onStorageChanged: Parameters<typeof api.storage.onChanged.addListener>[0] = (changes, area) => {
      if (
        area === 'local' &&
        changes.settings &&
        policyOf(changes.settings.oldValue) !== policyOf(changes.settings.newValue)
      ) {
        invalidatePolicyPreview();
      }
    };
    const recheckExternalState = () => {
      if (
        stepRef.current === STEPS.length - 1 &&
        !completingRef.current &&
        verificationStatusRef.current !== 'checking' &&
        document.visibilityState === 'visible'
      ) {
        void runProtectionVerification();
      }
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') recheckExternalState();
    };
    api.storage.onChanged.addListener(onStorageChanged);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', recheckExternalState);
    return () => {
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      api.storage.onChanged.removeListener(onStorageChanged);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', recheckExternalState);
    };
  }, [runProtectionVerification]);

  // ── Step changes: persist index, move focus to the heading ───────────────
  React.useEffect(() => {
    storeStep(step);
    setError(null);
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    window.scrollTo({ top: 0 });
    headingRef.current?.focus();
  }, [step]);

  // Focus the heading once data has rendered on first load too.
  React.useEffect(() => {
    if (loaded) headingRef.current?.focus();
  }, [loaded]);

  // ── Step 1 handlers ─────────────────────────────────────────────────────
  const toggle = (label: string, on: boolean) => {
    setBlocked((prev) => {
      const next = new Set(prev);
      if (on) next.add(label);
      else next.delete(label);
      return next;
    });
  };
  const toggleAll = (on: boolean) => setBlocked(on ? new Set(labels) : new Set());
  const addCategory = (raw: string): string | null => {
    const label = raw.trim().replace(/\s+/g, ' ').toLowerCase();
    if (!label) return 'Type a category first.';
    if (label.length < 3) return 'Use at least 3 characters.';
    if (labels.includes(label)) return 'That category is already in the list.';
    setLabels((prev) => [...prev, label]);
    setOrder((prev) => [...prev, label]);
    setBlocked((prev) => new Set(prev).add(label));
    setAddedHere((prev) => new Set(prev).add(label));
    setDeletedBuiltins((prev) => {
      const next = new Set(prev);
      next.delete(label);
      return next;
    });
    return null;
  };
  const removeAdded = (label: string) => {
    setLabels((prev) => prev.filter((l) => l !== label));
    setOrder((prev) => prev.filter((l) => l !== label));
    setBlocked((prev) => {
      const next = new Set(prev);
      next.delete(label);
      return next;
    });
    setAddedHere((prev) => {
      const next = new Set(prev);
      next.delete(label);
      return next;
    });
  };

  // ── Step 2: allow-list rows autosave (ListEditor contract) ──────────────
  const changeWhitelist = async (next: string[]) => {
    setWhitelist(next);
    try {
      await setSettings({ whitelist: next });
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
  };

  const blockedList = labels.filter((l) => blocked.has(l));
  const locked = lockReason !== null;

  const save = async (patch: Partial<Settings>): Promise<boolean> => {
    setSaving(true);
    try {
      await setSettings(patch);
      setError(null);
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const goNext = async () => {
    if (saving || completing || !loaded) return;
    if (step === 0) {
      if (blockedList.length === 0) return;
      // While locked nothing can be saved; let the user look around anyway.
      if (!locked && !(await save({ labels, blockedLabels: blockedList, deletedBuiltinLabels: [...deletedBuiltins] }))) return;
      setStep(1);
    } else if (step === 1) {
      if (!locked && !(await save({ focusGoal: focusGoal.trim(), whitelist }))) return;
      setStep(2);
    } else {
      // Locked: nothing can be saved, so leave setup unfinished (the options
      // page keeps its "Finish setup" banner) instead of dead-ending here.
      if (locked) return setUpLater();
      // The preview must be ready, but the background independently verifies
      // again at commit time so stale UI evidence cannot complete onboarding.
      if (verificationStatus !== 'ready') return;
      const generation = ++verificationGeneration.current;
      setCompleting(true);
      setVerificationStatus('checking');
      setVerificationReport(null);
      setVerificationError(null);
      try {
        const report: CompleteOnboardingResponse = await api.runtime.sendMessage({ type: 'COMPLETE_ONBOARDING' });
        if (!report || !['ready', 'degraded', 'error'].includes(report.status) || typeof report.saved !== 'boolean') {
          throw new Error(report?.error || 'the background worker returned an invalid completion report');
        }
        if (generation !== verificationGeneration.current || stepRef.current !== STEPS.length - 1) return;
        if (report.status === 'ready' && report.saved) {
          storeStep(null);
          onFinish();
          return;
        }
        setVerificationReport(report);
        setVerificationStatus(report.status === 'ready' ? 'error' : report.status);
        setVerificationError(report.error ?? 'Protection was not verified, so onboarding was not completed.');
      } catch (e) {
        if (generation === verificationGeneration.current && stepRef.current === STEPS.length - 1) {
          const message = e instanceof Error ? e.message : String(e);
          setVerificationStatus('error');
          setVerificationError(`Onboarding could not finish: ${message}. No completed setup was saved.`);
        }
      } finally {
        setCompleting(false);
      }
    }
  };

  const goBack = () => {
    if (!completing && step > 0) setStep(step - 1);
  };

  const setUpLater = () => {
    if (completing) return;
    verificationGeneration.current += 1;
    storeStep(null);
    onFinish();
  };

  // Enter = Continue from any single-line field or checkbox, except where the
  // field owns Enter itself (add-category handles + preventDefaults; the
  // ListEditor's add form is marked data-enter-local).
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'Enter' || e.defaultPrevented || e.nativeEvent.isComposing) return;
    const t = e.target as HTMLElement;
    if (t.closest('[data-enter-local]')) return;
    if (t.tagName !== 'INPUT') return;
    const type = (t as HTMLInputElement).type;
    if (type !== 'text' && type !== 'checkbox' && type !== 'search') return;
    e.preventDefault();
    void goNext();
  };

  const meta = STEPS[step];
  const canContinue =
    loaded !== null &&
    !saving &&
    !completing &&
    (step !== 0 || blockedList.length > 0) &&
    (step !== STEPS.length - 1 || locked || verificationStatus === 'ready');
  const finalActionLabel = locked
    ? 'Go to settings'
    : completing
      ? 'Verifying & starting…'
      : verificationStatus === 'checking'
        ? 'Checking protection…'
        : verificationStatus === 'ready'
          ? 'Start blocking'
          : 'Verification required';
  const openExtensionSettings = IS_FIREFOX
    ? null
    : () => {
        void api.tabs.create({ url: `chrome://extensions/?id=${api.runtime.id}` }).catch(() => undefined);
      };

  return (
    <div id="welcome-wizard" className="flex min-h-dvh flex-col bg-background text-foreground">
      <header className="mx-auto flex h-14 w-full max-w-[560px] items-center justify-between gap-4 px-4">
        <div className="flex items-center gap-3">
          <span className="flex size-6 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <LockSimple aria-hidden weight="bold" className="size-3.5" />
          </span>
          <span className="text-sm font-semibold tracking-tight">SmartBlocker</span>
        </div>
        {step < STEPS.length - 1 && (
          <Button id="welcome-later" variant="ghost" size="xs" onClick={setUpLater}>
            Set up later
          </Button>
        )}
      </header>

      <main className="mx-auto flex w-full max-w-[560px] flex-1 flex-col gap-8 px-4 pt-6 pb-10" onKeyDown={onKeyDown}>
        {/* Step indicator: named steps, current highlighted (NN/g wizards). */}
        <nav aria-label="Setup progress" className="flex flex-col gap-2">
          <p className="m-0 text-xs tabular-nums text-muted-foreground">
            Step {step + 1} of {STEPS.length}
          </p>
          <ol className="m-0 grid list-none grid-cols-3 gap-1.5 p-0">
            {STEPS.map((s, i) => (
              <li
                key={s.short}
                aria-current={i === step ? 'step' : undefined}
                className="flex flex-col gap-1.5"
              >
                <span aria-hidden className={cn('h-0.5 rounded-full', i <= step ? 'bg-primary' : 'bg-border')} />
                <span className={cn('text-xs', i === step ? 'font-medium text-foreground' : 'text-faint')}>
                  {s.short}
                  {i < step && <span className="sr-only"> (done)</span>}
                </span>
              </li>
            ))}
          </ol>
        </nav>

        <div className="flex flex-col gap-2">
          <h1
            ref={headingRef}
            tabIndex={-1}
            id="welcome-heading"
            className="m-0 text-[25px] font-semibold leading-tight tracking-tight text-foreground outline-none"
          >
            {meta.title}
          </h1>
          <p className="m-0 text-sm text-muted-foreground">{meta.subtitle}</p>
        </div>

        {locked && (
          <Callout id="welcome-locked" tone="commit" className="flex items-start gap-2.5">
            <LockSimple aria-hidden weight="bold" className="mt-0.5 size-4 shrink-0" />
            <span>{lockReason}</span>
          </Callout>
        )}

        {loaded === null ? (
          <div aria-busy="true" className="min-h-[320px]" />
        ) : step === 0 ? (
          <StepCategories
            labels={order}
            blocked={blocked}
            addedHere={addedHere}
            disabled={locked}
            disabledReason={lockReason ?? undefined}
            onToggle={toggle}
            onToggleAll={toggleAll}
            onAdd={addCategory}
            onRemove={removeAdded}
          />
        ) : step === 1 ? (
          <StepSites
            focusGoal={focusGoal}
            whitelist={whitelist}
            disabled={locked}
            disabledReason={lockReason ?? undefined}
            onFocusGoal={setFocusGoal}
            onWhitelist={(next) => void changeWhitelist(next)}
          />
        ) : (
          <StepReady
            blockedLabels={order.filter((l) => blocked.has(l))}
            allowedCount={whitelist.length}
            focusGoal={focusGoal}
            incognitoAllowed={incognitoAllowed}
            isFirefox={IS_FIREFOX}
            onEditStep={(nextStep) => {
              if (!completing) setStep(nextStep);
            }}
            onOpenExtensionSettings={openExtensionSettings}
            onRecheckIncognito={() => void checkIncognito()}
            verificationStatus={verificationStatus}
            verificationReport={verificationReport}
            verificationError={verificationError}
            completionPending={completing}
            onRetryVerification={() => void runProtectionVerification()}
            onContinueUnverified={setUpLater}
          />
        )}
      </main>

      <footer className="sticky bottom-0 border-t border-border bg-background">
        <div className="mx-auto flex w-full max-w-[560px] flex-col gap-2 px-4 py-3">
          <p
            id="welcome-msg"
            role="status"
            aria-live="polite"
            className={cn('m-0 text-xs empty:hidden', error ? 'text-destructive-soft' : 'text-faint')}
          >
            {error ?? (step === 0 && loaded && blockedList.length === 0 ? 'Pick at least one category to continue.' : '')}
          </p>
          <div className="flex items-center justify-between gap-3">
            <Button
              id="welcome-back"
              variant="ghost"
              onClick={goBack}
              disabled={completing}
              className={cn(step === 0 && 'invisible')}
              aria-hidden={step === 0 || undefined}
              tabIndex={step === 0 ? -1 : undefined}
            >
              <ArrowLeft aria-hidden className="size-4" />
              Back
            </Button>
            <Button
              id={step === STEPS.length - 1 ? 'welcome-start' : 'welcome-continue'}
              size="lg"
              disabled={!canContinue}
              onClick={() => void goNext()}
            >
              {step < STEPS.length - 1 ? 'Continue' : finalActionLabel}
            </Button>
          </div>
        </div>
      </footer>
    </div>
  );
}
