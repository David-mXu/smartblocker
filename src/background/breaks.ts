import { cancelBreak, getLockStatus, startBreak } from '../shared/lock';
import { getSettings } from '../shared/settings';
import { generateBreakText, verifyBreakText, type BreakMode } from '../shared/breaks';
import type { LockStatus } from '../shared/lock-math';

interface Challenge {
  text: string;
  createdAt: number;
}

const CHALLENGE_TTL_MS = 15 * 60_000;
let challenge: Challenge | null = null;

export async function requestBreakChallenge(): Promise<string> {
  const settings = await getSettings();
  if (settings.breakMode !== 'random-text') throw new Error('Random-text breaks are not enabled.');
  if (!(await getLockStatus()).settingsLocked) throw new Error('A break requires an active lock.');
  challenge = { text: generateBreakText(settings.breakTextLength), createdAt: Date.now() };
  return challenge.text;
}

/** The only message-side route to a break transition. Proof verification is
 *  deliberately completed before startBreak, so typos perform zero writes. */
export async function startConfiguredBreak(mode: BreakMode, text = ''): Promise<LockStatus> {
  const settings = await getSettings();
  if (mode === 'off' || mode !== settings.breakMode) {
    throw new Error('This break mode is not enabled.');
  }

  let delayMs = 0;
  if (mode === 'delay') {
    delayMs = settings.breakDelayMinutes * 60_000;
  } else {
    if (
      !challenge ||
      Date.now() - challenge.createdAt > CHALLENGE_TTL_MS ||
      !verifyBreakText(challenge.text, text)
    ) {
      throw new Error('The text does not match. Check it and try again.');
    }
  }

  const status = await startBreak(delayMs, settings.breakDurationMinutes * 60_000);
  challenge = null;
  return status;
}

export async function cancelConfiguredBreak(): Promise<LockStatus> {
  challenge = null;
  return cancelBreak();
}
