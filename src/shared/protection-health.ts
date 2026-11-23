// Pure protection-health derivation. The dashboard renders this so drift
// (revoked site access, unfinished setup, missing model files, disconnected
// desktop companion) has a visible, honest state instead of looking active.
// Erasable-syntax-only; Node-tested by scripts/protection-health-test.mjs.
//
// "Model cache present" is a PROXY: it proves the model was downloaded to this
// profile's CacheStorage at least once, not that inference currently succeeds.
// It is the only cheap signal available without running a classification.

export type ProtectionHealthKind = 'on' | 'paused' | 'setup' | 'attention' | 'locked';

export type ModelCacheState = 'present' | 'missing' | 'unknown';

export interface ProtectionHealthInput {
  enabled: boolean;
  onboarded: boolean;
  settingsLocked: boolean;
  /** Forced blocking (Frozen Turkey / schedule window) runs with enabled=false. */
  forceBlocking: boolean;
  /** `<all_urls>` permission, or null when the API could not be queried. */
  hasAllUrls: boolean | null;
  modelCache: ModelCacheState;
  /** Companion snapshot state, or null when the bridge never reported. */
  companionState: 'not-installed' | 'connecting' | 'connected' | 'disconnected' | null;
}

export interface ProtectionHealth {
  kind: ProtectionHealthKind;
  title: string;
  detail: string;
  /** Hash route to the surface that fixes it, or null when it needs no action. */
  fixHref: string | null;
  fixLabel: string | null;
}

export function deriveProtectionHealth(input: ProtectionHealthInput): ProtectionHealth {
  const active = input.enabled || input.forceBlocking;

  // Site access is the hard prerequisite: without it nothing can be read.
  if (input.hasAllUrls === false) {
    return {
      kind: 'attention',
      title: 'Site access was revoked',
      detail:
        'The browser removed access to your sites, so pages cannot be checked or blocked. Re-run the setup check to restore it.',
      fixHref: '#welcome',
      fixLabel: 'Re-check setup',
    };
  }

  if (!input.onboarded) {
    return {
      kind: 'setup',
      title: 'Setup isn’t finished',
      detail:
        'Blocking starts only after onboarding completes. Finish the short setup to turn it on.',
      fixHref: '#welcome',
      fixLabel: 'Finish setup',
    };
  }

  if (active && input.modelCache === 'missing') {
    return {
      kind: 'attention',
      title: 'Classifier files are missing',
      detail:
        'This profile has no cached model, so checks cannot run and pages may pass unchecked. Connect to the network once and run a test classification.',
      fixHref: '#advanced',
      fixLabel: 'Check the classifier',
    };
  }

  // Companion drift matters even while locked: "locked" would otherwise imply
  // OS-level enforcement that is not actually connected.
  if (input.companionState === 'disconnected') {
    return {
      kind: 'attention',
      title: 'Desktop companion isn’t connected',
      detail:
        'Hard OS-level enforcement is off. This browser still enforces blocking on its own.',
      fixHref: '#companion',
      fixLabel: 'Open companion',
    };
  }

  if (!input.enabled && !input.forceBlocking) {
    return {
      kind: 'paused',
      title: 'Blocking is off',
      detail:
        'SmartBlocker is not checking pages until you turn it back on.',
      fixHref: '#blocking',
      fixLabel: 'Turn it on',
    };
  }

  if (input.settingsLocked || input.forceBlocking) {
    return {
      kind: 'locked',
      title: 'Protection is on and locked',
      detail:
        'A lock is active, so blocking and its settings can’t be changed until it ends.',
      fixHref: null,
      fixLabel: null,
    };
  }

  return {
    kind: 'on',
    title: 'Protection is on',
    detail:
      'Every http(s) page is checked on-device; your allowed sites and embeds you revealed are skipped.',
    fixHref: null,
    fixLabel: null,
  };
}

/** Badge tone for the dashboard's tone vocabulary. */
export function protectionHealthTone(kind: ProtectionHealthKind): 'success' | 'warning' | 'commit' | 'default' {
  switch (kind) {
    case 'on':
      return 'success';
    case 'locked':
      return 'commit';
    case 'paused':
      return 'warning';
    case 'setup':
    case 'attention':
      return 'warning';
    default:
      return 'default';
  }
}
