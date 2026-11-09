// Entry point for the extension-OWNED block page (see blocked.html header and
// src/background/force-redirect.ts). Reads the verdict params from the query
// string (?reason=&locked=&title=&label=&score=&ms=) and renders the same
// hardened screen as the injected overlay (via blockscreen-ui.ts).
//
// Query-param hardening — this page lives in web_accessible_resources (DNR
// requires it), so a hostile page can iframe or link it with a CRAFTED query
// string. Consequences and the rules that follow:
//   - NO innerHTML / insertAdjacentHTML / document.write anywhere: every
//     param value reaches the DOM through textContent / createTextNode only
//     (handled inside blockscreen-ui.ts).
//   - All values are parsed defensively: enum allowlist for `reason`, finite
//     clamps for numbers, length caps for strings. Junk degrades to the plain
//     force-block variant with safe defaults.
//   - `locked` is parsed for protocol completeness but the page NEVER renders
//     bypass buttons: the only legitimate producer of this URL is force mode
//     (lock.forceBlocking), where bypass is disabled — and since params are
//     attacker-influenced, a forged `locked=0` must mean nothing. Missing or
//     malformed params therefore also fail closed.
//   - The single action (Stay focused → close tab) goes through the SW's
//     existing CLOSE_TAB handler, which closes the sender's own tab only.
import '../styles/globals.css';
import { renderBlockedPage, type BlockedPageReason } from '../background/blockscreen-ui';

const REASONS: ReadonlySet<string> = new Set(['dnf-redirect', 'classifier-unavailable']);
const MAX_TITLE_LENGTH = 300;
const MAX_LABEL_LENGTH = 120;
const MAX_MESSAGE_LENGTH = 160;

function readSpec(): {
  reason: BlockedPageReason;
  title: string;
  label: string;
  score: number;
  ms: number;
  blockMessage: string;
} {
  const p = new URLSearchParams(window.location.search);

  const rawReason = p.get('reason') ?? '';
  const reason: BlockedPageReason = (REASONS.has(rawReason)
    ? rawReason
    : 'dnf-redirect') as BlockedPageReason;

  const title = (p.get('title') ?? '').slice(0, MAX_TITLE_LENGTH);
  const label = (p.get('label') ?? '').slice(0, MAX_LABEL_LENGTH);
  // Plain text only; the renderer uses textContent. Newline/control collapse
  // matches the options-page sanitizer.
  const blockMessage = (p.get('msg') ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_MESSAGE_LENGTH);

  const rawScore = Number(p.get('score'));
  const score = Number.isFinite(rawScore) ? Math.min(1, Math.max(0, rawScore)) : 0;

  const rawMs = Number(p.get('ms'));
  const ms = Number.isFinite(rawMs) ? Math.min(600_000, Math.max(0, Math.round(rawMs))) : 0;

  return { reason, title, label, score, ms, blockMessage };
}

const spec = readSpec();

const rootEl = document.getElementById('root');
if (rootEl) {
  renderBlockedPage(rootEl, spec, {
    onStay: () => {
      // Close THIS tab (the redirect made the hostile document ours). The SW
      // resolves the sender's own tab — no tab id is or should be supplied.
      if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
        void chrome.runtime.sendMessage({ type: 'CLOSE_TAB' });
      } else {
        window.close();
      }
    },
  });
}
