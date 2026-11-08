import { api } from '../shared/api';
import type {
  CompleteOnboardingResponse,
  ProtectionCheck,
  VerifyProtectionResponse,
} from '../shared/messages';
import { getSettings, setSettings, type Settings } from '../shared/settings';
import {
  assessProtectionVerdict,
  PROTECTION_FIXTURES,
  protectionConfigurationCheck,
  summarizeProtectionChecks,
} from '../shared/protection-policy';
import { classify } from './classifier';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type PolicySettings = Pick<Settings, 'labels' | 'blockedLabels' | 'blockThreshold'>;
const policyFingerprint = (settings: PolicySettings) =>
  JSON.stringify([settings.labels, settings.blockedLabels, settings.blockThreshold]);

async function checkSiteAccess(): Promise<ProtectionCheck> {
  try {
    const allSites = await api.permissions.contains({ origins: ['<all_urls>'] });
    return {
      id: 'site-access',
      status: allSites ? 'passed' : 'failed',
      label: 'All-site access',
      detail: allSites
        ? 'The browser confirms SmartBlocker can inspect http(s) pages.'
        : 'SmartBlocker does not have all-site access. Open the extension’s browser permissions, allow access on all sites, then retry.',
    };
  } catch (error) {
    return {
      id: 'site-access',
      status: 'error',
      label: 'All-site access',
      detail: `The browser’s site-access check could not finish: ${errorMessage(error)}. Retry from extension settings.`,
    };
  }
}

async function runProtectionVerification(): Promise<{
  report: VerifyProtectionResponse;
  policyKey: string;
}> {
  const settings = await getSettings();
  const initialPolicyKey = policyFingerprint(settings);
  const checks: ProtectionCheck[] = [await checkSiteAccess()];

  // Sequential by design: a cold model only has to initialize once, and the
  // second result cannot be mistaken for a parallel/aggregate success signal.
  for (const fixture of PROTECTION_FIXTURES) {
    const configurationFailure = protectionConfigurationCheck(fixture, settings);
    if (configurationFailure) {
      checks.push(configurationFailure);
      continue;
    }
    try {
      const outcome = await classify({ title: fixture.title }, true);
      checks.push(assessProtectionVerdict(fixture, outcome, settings));
    } catch (error) {
      checks.push({
        id: fixture.id,
        status: 'error',
        label: fixture.checkLabel,
        detail:
          `Fresh on-device inference could not finish for “${fixture.title}”: ${errorMessage(error)}. ` +
          'Check the model download or browser worker and retry. No settings were changed.',
      });
    }
  }

  // Inference can be slow. Re-read BOTH external inputs afterward so a report
  // cannot combine labels/policy from different configurations or retain an
  // early permission grant that has since been revoked.
  const finalSiteAccess = await checkSiteAccess();
  checks[checks.findIndex((check) => check.id === 'site-access')] = finalSiteAccess;
  const finalPolicyKey = policyFingerprint(await getSettings());
  if (finalPolicyKey !== initialPolicyKey) {
    return {
      report: {
        status: 'error',
        checks,
        error: 'Categories or the block threshold changed during verification. Review the saved settings and retry.',
      },
      policyKey: finalPolicyKey,
    };
  }

  return {
    report: { status: summarizeProtectionChecks(checks), checks },
    policyKey: finalPolicyKey,
  };
}

/** Production inference + policy + host access, without opening test tabs or
 * weakening settings. Navigation enforcement is covered separately by e2e. */
export async function verifyProtection(): Promise<VerifyProtectionResponse> {
  return (await runProtectionVerification()).report;
}

/** Re-prove readiness at commit time; the UI's earlier `ready` is only a
 * preview. This is the sole onboarding path that persists enabled+onboarded. */
export async function completeOnboarding(): Promise<CompleteOnboardingResponse> {
  const { report, policyKey } = await runProtectionVerification();
  if (report.status !== 'ready') return { ...report, saved: false };
  if (policyFingerprint(await getSettings()) !== policyKey) {
    return {
      ...report,
      status: 'error',
      saved: false,
      error: 'Categories or the block threshold changed after verification. Retry the checks.',
    };
  }
  try {
    await setSettings({ enabled: true, onboarded: true });
    return { ...report, saved: true };
  } catch (error) {
    return {
      ...report,
      status: 'error',
      saved: false,
      error: `Protection passed, but onboarding could not be saved: ${errorMessage(error)}.`,
    };
  }
}
