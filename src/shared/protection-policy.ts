// Pure policy for the built-in proof-of-protection fixtures. Kept free of
// browser APIs so the configuration and verdict paths are directly Node-tested.
import { TEST_TITLES } from './config.ts';
import type { ClassifyOutcome, ProtectionCheck } from './messages.ts';
import type { Settings } from './settings.ts';
import { effectiveBlockScore, shouldBlockClassifierVerdict } from './prototypes.ts';

export type ProtectionPolicySettings = Pick<
  Settings,
  'labels' | 'blockedLabels' | 'blockThreshold'
>;

export interface ProtectionFixture {
  id: 'distraction' | 'productive';
  title: string;
  expectedLabel: string;
  expectedBlocked: boolean;
  checkLabel: string;
}

export const PROTECTION_FIXTURES: readonly ProtectionFixture[] = [
  {
    id: 'distraction',
    title: TEST_TITLES[0],
    expectedLabel: 'video games',
    expectedBlocked: true,
    checkLabel: 'Known distraction is blocked',
  },
  {
    id: 'productive',
    title: TEST_TITLES[1],
    expectedLabel: 'programming and software development',
    expectedBlocked: false,
    checkLabel: 'Known productive page is allowed',
  },
];

const percent = (score: number) => `${Math.round(score * 100)}%`;

/** Return an actionable settings diagnostic instead of running a fixture that
 * cannot prove the promised behavior under the user's custom configuration. */
export function protectionConfigurationCheck(
  fixture: ProtectionFixture,
  settings: ProtectionPolicySettings,
): ProtectionCheck | null {
  let detail: string | null = null;
  if (!settings.labels.includes(fixture.expectedLabel)) {
    detail =
      `“${fixture.title}” needs the “${fixture.expectedLabel}” category, but that category isn’t active. ` +
      'Change categories to restore it, or continue without verification.';
  } else if (fixture.expectedBlocked && !settings.blockedLabels.includes(fixture.expectedLabel)) {
    detail =
      `“${fixture.title}” needs “${fixture.expectedLabel}” to be blocked. Your current settings allow that category, ` +
      'so this fixture cannot prove distraction blocking.';
  } else if (!fixture.expectedBlocked && settings.blockedLabels.includes(fixture.expectedLabel)) {
    detail =
      `“${fixture.title}” needs “${fixture.expectedLabel}” to stay unblocked. Your current settings block that category, ` +
      'so this fixture cannot prove productive pages stay open.';
  }
  return detail
    ? { id: fixture.id, status: 'failed', label: fixture.checkLabel, detail }
    : null;
}

/** Assess BOTH semantic correctness and the actual current-policy decision. A
 * plausible label alone never turns a failed block/allow expectation into ready. */
export function assessProtectionVerdict(
  fixture: ProtectionFixture,
  outcome: ClassifyOutcome,
  settings: ProtectionPolicySettings,
): ProtectionCheck {
  const blocked = shouldBlockClassifierVerdict(
    outcome,
    settings.blockedLabels,
    settings.blockThreshold,
  );
  const effectiveScore = effectiveBlockScore(outcome, settings.blockedLabels);
  const base = {
    id: fixture.id,
    label: fixture.checkLabel,
    verdict: {
      label: outcome.label,
      score: outcome.score,
      effectiveScore,
      decision: blocked ? ('block' as const) : ('allow' as const),
      cached: outcome.cached,
    },
  };

  if (outcome.cached) {
    return {
      ...base,
      status: 'error',
      detail: 'The verifier received a cached verdict despite requesting fresh inference. Retry; setup was not completed.',
    };
  }
  if (outcome.label !== fixture.expectedLabel) {
    return {
      ...base,
      status: 'failed',
      detail:
        `Fresh inference classified “${fixture.title}” as “${outcome.label}”, not “${fixture.expectedLabel}”. ` +
        'This unexpected result did not pass verification; review your category customizations or retry.',
    };
  }
  if (blocked !== fixture.expectedBlocked) {
    const thresholdGuidance =
      fixture.expectedBlocked && !blocked && effectiveScore < settings.blockThreshold
        ? ` Its effective confidence (${percent(effectiveScore)}) is below your ${percent(settings.blockThreshold)} block threshold. Lower the threshold or change categories, then retry.`
        : ' Review your categories and block threshold, then retry.';
    return {
      ...base,
      status: 'failed',
      detail:
        `Fresh inference found “${fixture.expectedLabel}”, but current settings ${blocked ? 'block' : 'allow'} the fixture; ` +
        `verification expected ${fixture.expectedBlocked ? 'a block' : 'an allow'}.${thresholdGuidance}`,
    };
  }
  return {
    ...base,
    status: 'passed',
    detail:
      `Fresh inference classified “${fixture.title}” as “${fixture.expectedLabel}” (${percent(outcome.score)} confidence); ` +
      `current settings ${blocked ? 'block' : 'allow'} it.`,
  };
}

/** Missing checks can never accidentally summarize as ready. */
export function summarizeProtectionChecks(
  checks: readonly ProtectionCheck[],
): 'ready' | 'degraded' | 'error' {
  if (checks.some((check) => check.status === 'error')) return 'error';
  const required: ProtectionCheck['id'][] = ['site-access', 'distraction', 'productive'];
  return required.every((id) => checks.some((check) => check.id === id && check.status === 'passed'))
    ? 'ready'
    : 'degraded';
}
