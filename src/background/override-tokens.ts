// One-time nonces binding an OVERRIDE message to a specific injected block
// screen. Without one, any present-or-future context that can send a runtime
// message could allowlist an attacker-controlled title without a block screen
// ever being rendered (red-team 2026-11: the override path is the extension's
// allowlist + classifier-feedback write path, so it authenticates).
//
// Persisted in storage.session so MV3 service-worker restarts (Chrome reaps
// idle SWs ~30s in) don't strand a real user's override click; session storage
// is unreachable from page/content-script contexts and dies with the browser
// session. Entries are ordinary random UUIDs — secrecy is the mechanism, so
// no crypto beyond a CSPRNG is needed.
import { api } from '../shared/api';

const KEY = 'overrideTokens';
/** FIFO cap — nonces mint per injected block screen, which is nav-driven. */
const MAX_TOKENS = 1000;

async function readTokens(): Promise<string[]> {
  try {
    const s = await api.storage.session.get(KEY);
    const v = (s as Record<string, unknown>)[KEY];
    return Array.isArray(v) ? (v as string[]) : [];
  } catch {
    return [];
  }
}

/** Mint a nonce SW-side right before injecting a block screen. */
export async function mintOverrideToken(): Promise<string> {
  const token = crypto.randomUUID();
  const tokens = await readTokens();
  tokens.push(token);
  while (tokens.length > MAX_TOKENS) tokens.shift();
  try {
    await api.storage.session.set({ [KEY]: tokens });
  } catch {
    // session storage unavailable (very old Firefox) — the nonce still
    // validates nothing later, failing the override closed, not the block.
  }
  return token;
}

/** Validate + retire a nonce. One-time use: a consumed token never replays. */
export async function consumeOverrideToken(token: string | undefined): Promise<boolean> {
  if (!token) return false;
  const tokens = await readTokens();
  const i = tokens.indexOf(token);
  if (i < 0) return false;
  tokens.splice(i, 1);
  try {
    await api.storage.session.set({ [KEY]: tokens });
  } catch {
    // Ignore — the consume already succeeded in memory of this flow.
  }
  return true;
}
