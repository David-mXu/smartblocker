// Browser-side store for named profiles. The pure policy/validation core is
// profiles.ts; this module owns storage.local, the live cache, and the
// settings-lock guard every profile mutation goes through.
import { api } from './api';
import type { ProfilesState, ProfileMutationOptions, ProfileOpCode, ProfilePolicy } from './profiles';
import {
  PROFILES_STORAGE_KEY,
  activateProfile,
  adoptActiveAppBlocklist,
  createProfile,
  deleteProfile,
  duplicateProfile,
  renameProfile,
  sanitizeProfilesState,
  setProfilePolicy,
} from './profiles';
import { normalizeAppBlocklist } from './apps';
import { getLockStatus } from './lock';

export class ProfileOperationError extends Error {
  readonly code: ProfileOpCode;
  constructor(code: ProfileOpCode, message: string) {
    super(message);
    this.name = 'ProfileOperationError';
    this.code = code;
  }
}

let cache: ProfilesState | null = null;

api.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[PROFILES_STORAGE_KEY]) cache = null;
});

export async function getProfilesState(): Promise<ProfilesState> {
  if (cache) return cache;
  const stored = await api.storage.local.get(PROFILES_STORAGE_KEY);
  cache = sanitizeProfilesState(stored[PROFILES_STORAGE_KEY], Date.now());
  return cache;
}

/** Settings.ts updates settings + profiles in one storage transaction; prime
 *  this cache so the same context never reads the pre-write value. */
export function primeProfilesState(next: ProfilesState): void {
  cache = next;
}

async function writeProfilesState(next: ProfilesState): Promise<ProfilesState> {
  cache = next;
  await api.storage.local.set({ [PROFILES_STORAGE_KEY]: next });
  return next;
}

async function mutationOptions(now = Date.now()): Promise<ProfileMutationOptions> {
  const status = await getLockStatus(now);
  return { now, locked: status.settingsLocked };
}

export interface NewNamedProfile {
  name: string;
  policy: ProfilePolicy;
  appBlocklist?: readonly string[];
  appBlocklistUpdatedAt?: number;
  now?: number;
  id?: string;
}

export async function createNamedProfile(input: NewNamedProfile) {
  const state = await getProfilesState();
  const options = await mutationOptions(input.now);
  const result = createProfile(state, {
    ...options,
    id: input.id,
    name: input.name,
    policy: input.policy,
    appBlocklist: input.appBlocklist,
    appBlocklistUpdatedAt: input.appBlocklistUpdatedAt,
  });
  if (!result.ok) throw new ProfileOperationError(result.code, result.error);
  await writeProfilesState(result.state);
  return result.profile!;
}

export async function duplicateNamedProfile(id: string) {
  const state = await getProfilesState();
  const options = await mutationOptions();
  const result = duplicateProfile(state, id, options);
  if (!result.ok) throw new ProfileOperationError(result.code, result.error);
  await writeProfilesState(result.state);
  return result.profile!;
}

export async function renameNamedProfile(id: string, name: string) {
  const state = await getProfilesState();
  const options = await mutationOptions();
  const result = renameProfile(state, id, name, options);
  if (!result.ok) throw new ProfileOperationError(result.code, result.error);
  await writeProfilesState(result.state);
  return result.profile!;
}

export async function deleteNamedProfile(id: string) {
  const state = await getProfilesState();
  const options = await mutationOptions();
  const result = deleteProfile(state, id, options);
  if (!result.ok) throw new ProfileOperationError(result.code, result.error);
  await writeProfilesState(result.state);
}

/** null = Default. Refused while settings are locked (profiles.ts). */
export async function activateNamedProfile(id: string | null): Promise<void> {
  const state = await getProfilesState();
  const options = await mutationOptions();
  const result = activateProfile(state, id, options);
  if (!result.ok) throw new ProfileOperationError(result.code, result.error);
  if (result.state !== state) await writeProfilesState(result.state);
}

/** Update the active profile's scoped policy from a settings write. Returns
 *  the new state so settings.ts can commit both keys transactionally. */
export function updateActiveProfilePolicy(
  state: ProfilesState,
  id: string,
  policy: ProfilePolicy,
  now: number,
): ProfilesState {
  return setProfilePolicy(state, id, policy, now);
}

/** Companion-owned app list → active profile association. No settings-lock
 *  guard: the daemon is the authority for its own list, and adoption only
 *  records that external state. */
export async function adoptActiveAppBlocklistFromCompanion(
  apps: readonly string[],
  updatedAt: number,
): Promise<boolean> {
  const state = await getProfilesState();
  const next = adoptActiveAppBlocklist(state, apps, updatedAt);
  if (next === state) return false;
  await writeProfilesState(next);
  return true;
}

/** Explicit local association edit. Locked = additions only, matching the
 *  companion's own strictening-only rule. */
export async function setActiveAppBlocklist(apps: readonly string[]): Promise<void> {
  const state = await getProfilesState();
  const normalized = normalizeAppBlocklist(apps);
  const status = await getLockStatus();
  if (status.settingsLocked) {
    const current = state.activeProfileId === null
      ? state.defaultAppBlocklist
      : (state.profiles.find((profile) => profile.id === state.activeProfileId)?.appBlocklist ?? []);
    const keptAll = current.every((entry) => normalized.includes(entry));
    if (!keptAll) {
      throw new ProfileOperationError(
        'locked',
        'Locked: desktop apps can be added but not removed until the lock ends.',
      );
    }
  }
  const next = adoptActiveAppBlocklist(state, normalized, Date.now());
  if (next !== state) await writeProfilesState(next);
}
