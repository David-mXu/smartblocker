// Background RPC boundary for explicit-release lock gates. Options and popup
// pages request transitions; only this service-worker module mints/challenges,
// verifies proofs, or completes an elapsed delay.
import { generateRandomText, verifyRandomText } from '../shared/breaks';
import {
  cancelDelayUnlock,
  completeDelayUnlock,
  getLockState,
  releaseRandomTextLock,
  startDelayUnlock,
} from '../shared/lock';
import { armedRandomTextLength } from '../shared/lock-math';
import type { LockStatus } from '../shared/lock-math';

const RANDOM_CHALLENGE_TTL_MS = 15 * 60_000;

interface RandomTextChallenge {
  id: string;
  text: string;
  length: number;
  armStamp: number;
  expiresAt: number;
}

let challenge: RandomTextChallenge | null = null;

function nowMs(): number {
  const now = Date.now();
  if (!Number.isFinite(now) || now <= 0) throw new Error('The system clock is unavailable.');
  return now;
}

export async function startDelayUnlockRpc(): Promise<LockStatus> {
  return startDelayUnlock();
}

export async function cancelDelayUnlockRpc(): Promise<LockStatus> {
  return cancelDelayUnlock();
}

export async function completeDelayUnlockRpc(): Promise<LockStatus> {
  return completeDelayUnlock();
}

/** Called by wall-clock boundaries and service-worker startup. Not-due is a
 *  quiet no-op, so stale alarms neither write nor report a false failure. */
export async function completeReadyDelayUnlock(): Promise<LockStatus | null> {
  const state = await getLockState();
  const delayUntil = state.delayUntil;
  if (
    typeof delayUntil !== 'number' ||
    !Number.isFinite(delayUntil) ||
    delayUntil <= 0 ||
    nowMs() < delayUntil
  ) {
    return null;
  }
  return completeDelayUnlock();
}

export async function requestRandomTextUnlockChallenge(): Promise<{ id: string; text: string }> {
  const state = await getLockState();
  const length = armedRandomTextLength(state);
  if (length === null) throw new Error('A random-text lock is not armed.');

  // Assignment has no intervening await: the latest completed request is the
  // only accepted challenge, and each id is cryptographically unpredictable.
  challenge = {
    id: crypto.randomUUID(),
    text: generateRandomText(length),
    length,
    armStamp: state.randomTextUpdatedAt ?? 0,
    expiresAt: nowMs() + RANDOM_CHALLENGE_TTL_MS,
  };
  return { id: challenge.id, text: challenge.text };
}

/** Consume a matching challenge synchronously before the first await. Even a
 *  typo is one-shot; concurrent/replayed messages can never both reach the
 *  release transition. Every rejection before release performs zero writes. */
export async function attemptRandomTextUnlock(challengeId: string, proof: string): Promise<LockStatus> {
  const candidate = challenge;
  if (!candidate || candidate.id !== challengeId) {
    throw new Error('This unlock text is no longer valid. Request a fresh one.');
  }
  challenge = null;

  if (nowMs() >= candidate.expiresAt) {
    throw new Error('This unlock text expired. Request a fresh one.');
  }
  const state = await getLockState();
  if (
    armedRandomTextLength(state) !== candidate.length ||
    (state.randomTextUpdatedAt ?? 0) !== candidate.armStamp
  ) {
    throw new Error('This unlock text belongs to an older lock. Request a fresh one.');
  }
  if (!verifyRandomText(candidate.text, proof)) {
    throw new Error('The text does not match. Request a fresh text and try again.');
  }
  return releaseRandomTextLock(candidate.armStamp);
}
