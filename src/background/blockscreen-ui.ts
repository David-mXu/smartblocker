// Shared block-screen UI, imported by the extension-OWNED blocked page
// (src/blocked/blocked.ts) that declarativeNetRequest redirects force-locked
// tabs to (see force-redirect.ts).
//
// IMPORTANT — relationship to blockscreen.ts: the injected overlay in
// blockscreen.ts renders this SAME design, but it is executed via
// chrome.scripting.executeScript({ func }), which SERIALIZES the function
// — that file must stay fully self-contained with no imports, so it cannot
// consume this module. The two are intentional, documented duplicates: any
// visual/copy change must be applied to both (blockscreen.ts keeps 100%
// behavioral identity for non-force blocks and all sub-frame contexts).
//
// Security model differences from the injected overlay (intentional):
// - No shadow root, no re-mount MutationObserver, no media trap: this page
//   IS the top-level extension document — the hostile site's DOM/JS does not
//   exist here. What remains is the design + the locked button posture.
// - Everything caller/spring-controlled reaches the DOM exclusively via
//   textContent/createTextNode — query params are attacker-influenced (a
//   crafted link or iframe can point at this web-accessible page), so this
//   file contains no innerHTML, no insertAdjacentHTML, no document.write.

export type BlockedPageReason = 'dnf-redirect' | 'classifier-unavailable';

export interface BlockedPageSpec {
  reason: BlockedPageReason;
  /** Already length-capped by the caller; rendered via text nodes only. */
  title: string;
  label: string;
  /** 0..1 — shown as the confidence pill on the normal variant only. */
  score: number;
  ms: number;
  /** Optional user note; already bounded/sanitized by the caller. */
  blockMessage?: string;
}

export interface BlockedPageHandlers {
  /** "Stay focused (close tab)" — wired by the page (CLOSE_TAB message). */
  onStay: () => void;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Wordmark: ivory lock tile + "SmartBlocker" (mirrors blockscreen.ts). */
function makeMark(isCompact: boolean): HTMLElement {
  const wrap = document.createElement('div');
  wrap.style.cssText =
    'display:flex;align-items:center;gap:8px;font-size:12px;font-weight:500;color:#7d7768;' +
    'letter-spacing:0.01em;' +
    (isCompact ? 'margin-bottom:10px' : 'margin-bottom:44px');
  const sq = document.createElement('span');
  sq.style.cssText =
    'display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;' +
    'border-radius:5px;background:#efe8d8';
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '12');
  svg.setAttribute('height', '12');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', '#1c1405');
  svg.setAttribute('stroke-width', '2.5');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  const body = document.createElementNS(SVG_NS, 'rect');
  body.setAttribute('x', '5');
  body.setAttribute('y', '11');
  body.setAttribute('width', '14');
  body.setAttribute('height', '10');
  body.setAttribute('rx', '2');
  const shackle = document.createElementNS(SVG_NS, 'path');
  shackle.setAttribute('d', 'M8 11V7a4 4 0 0 1 8 0v4');
  svg.append(body, shackle);
  sq.appendChild(svg);
  wrap.append(sq, document.createTextNode('SmartBlocker'));
  return wrap;
}

/**
 * Render the hardened screen into `root`. Top-level-page variant only (the
 * DNR redirect never targets sub-frames): no sub-frame copy branches.
 * Button posture is the overlay's LOCKED variant — the only legitimate caller
 * of this page is force mode, so override and dismiss buttons are NEVER
 * rendered, regardless of what the query string claims.
 *
 * Visual spec: docs/design-notes.md §5 (Lamplight). No <h1> anywhere — the
 * p2-dnr e2e asserts the extension page renders zero h1s.
 */
export function renderBlockedPage(
  root: HTMLElement,
  spec: BlockedPageSpec,
  handlers: BlockedPageHandlers,
): void {
  const isCompact = window.innerHeight < 420;
  const failClosed = spec.reason === 'classifier-unavailable';

  // --- Root container: full-bleed, faint lamp glow, centered column.
  const host = document.createElement('div');
  host.id = 'smartblocker-blocked';
  host.setAttribute('data-smartblocker-context', 'top');
  host.setAttribute('data-smartblocker-reason', spec.reason);
  host.style.cssText =
    'position:fixed;inset:0;' +
    'display:flex;flex-direction:column;align-items:center;' +
    'background:radial-gradient(ellipse 70% 50% at 50% -10%, ' +
    (failClosed ? 'rgba(232,163,61,0.16)' : 'rgba(232,163,61,0.08)') +
    ', rgba(232,163,61,0) 70%), #0e0c09;' +
    'color:#f4efe4;' +
    (isCompact
      ? 'justify-content:flex-start;overflow-y:auto;overflow-x:hidden;padding:10px 12px;'
      : 'justify-content:center;padding:32px;') +
    'font-family:Geist,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;' +
    'box-sizing:border-box;text-align:center;-webkit-font-smoothing:antialiased';

  const column = document.createElement('div');
  column.style.cssText =
    (isCompact ? 'max-width:420px;margin:auto;' : 'max-width:520px;') +
    'width:100%;display:flex;flex-direction:column;align-items:center;box-sizing:border-box';

  // --- Eyebrow ---
  const niceLabel = spec.label ? spec.label.charAt(0).toUpperCase() + spec.label.slice(1) : '';
  const eyebrow = document.createElement('div');
  eyebrow.style.cssText =
    (isCompact ? 'font-size:11px;margin-bottom:4px;' : 'font-size:13px;margin-bottom:14px;') +
    'font-weight:500;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' +
    (failClosed ? 'color:#f2cd8b' : 'color:#a29a89');
  eyebrow.textContent = failClosed
    ? 'Classifier unavailable — fail-closed'
    : /^(?:blocked|title) rule/i.test(spec.label)
      ? niceLabel
      : 'Blocked · ' + niceLabel;

  // --- Headline (a div, never an h1) ---
  const headline = document.createElement('div');
  headline.style.cssText =
    (isCompact ? 'font-size:17px;margin-bottom:4px;' : 'font-size:34px;margin-bottom:14px;') +
    'font-weight:600;line-height:1.1;letter-spacing:-0.03em;color:#f4efe4;text-wrap:balance';
  headline.textContent = failClosed ? 'Can’t verify this page.' : 'This one can wait.';

  const parts: HTMLElement[] = [makeMark(isCompact), eyebrow, headline];

  // --- Fail-closed body copy ---
  if (failClosed) {
    const body = document.createElement('div');
    body.style.cssText =
      (isCompact
        ? 'font-size:12px;max-height:6.2em;overflow:hidden;line-height:1.45;margin-bottom:6px;'
        : 'font-size:15px;line-height:1.55;margin-bottom:12px;') +
      'font-weight:400;color:#a29a89;max-width:460px;word-break:break-word;text-wrap:pretty';
    body.appendChild(
      document.createTextNode(
        'A lock is active and the on-device classifier could not run, so Smart Blocker is ' +
          'failing closed instead of letting this through unchecked. It keeps retrying ' +
          'automatically — if the model recovers, the block updates on its own.',
      ),
    );
    parts.push(body);
  }

  // --- Page title (attacker-influenced: text nodes only) ---
  const pageTitle = document.createElement('div');
  pageTitle.style.cssText = failClosed
    ? (isCompact ? 'font-size:11px;margin-bottom:10px;' : 'font-size:13px;margin-bottom:32px;') +
      'font-weight:400;color:#7d7768;max-width:460px;word-break:break-word;line-height:1.4'
    : (isCompact ? 'font-size:12px;margin-bottom:10px;' : 'font-size:15px;margin-bottom:36px;') +
      'display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;' +
      'font-weight:400;line-height:1.5;color:#a29a89;max-width:440px;word-break:break-word';
  if (spec.title) {
    pageTitle.append(
      document.createTextNode('“'),
      document.createTextNode(spec.title),
      document.createTextNode('”'),
    );
  }
  parts.push(pageTitle);

  // --- Optional user note (attacker-influenced query param: text node only) ---
  const message = (spec.blockMessage ?? '').replace(/\s+/g, ' ').trim().slice(0, 160);
  if (message) {
    const note = document.createElement('div');
    note.id = 'smartblocker-block-message';
    note.style.cssText =
      (isCompact ? 'font-size:12px;margin-bottom:10px;' : 'font-size:14px;margin-bottom:28px;') +
      'font-weight:500;line-height:1.5;color:#e8d9b8;max-width:440px;word-break:break-word';
    note.textContent = message;
    parts.push(note);
  }

  // --- Threshold Meter (normal variant only — fail-closed shows no fake
  // confidence). The redirect URL carries no threshold, so no tick here.
  if (!failClosed) {
    const scorePct = Math.max(0, Math.min(100, Math.round(spec.score * 100)));
    const meter = document.createElement('div');
    meter.style.cssText =
      (isCompact ? 'max-width:260px;gap:6px;margin-bottom:10px;' : 'max-width:340px;gap:8px;margin-bottom:28px;') +
      'width:100%;display:flex;flex-direction:column';
    const row = document.createElement('div');
    row.style.cssText =
      'display:flex;justify-content:space-between;align-items:baseline;font-size:12px;font-variant-numeric:tabular-nums';
    const conf = document.createElement('span');
    conf.style.cssText = 'color:#f4efe4;font-weight:500';
    conf.textContent = scorePct + '% confidence';
    row.appendChild(conf);
    const track = document.createElement('div');
    track.style.cssText = 'position:relative;height:8px;width:100%';
    const base = document.createElement('div');
    base.style.cssText =
      'position:absolute;left:0;right:0;top:3px;height:2px;border-radius:2px;background:#2e2718';
    const fill = document.createElement('div');
    fill.style.cssText =
      'position:absolute;left:0;top:3px;height:2px;border-radius:2px;background:#f4efe4;width:' + scorePct + '%';
    track.append(base, fill);
    meter.append(row, track);
    parts.push(meter);
  }

  // --- Locked note (amber = commitment) + the single primary action.
  const lockNote = document.createElement('div');
  lockNote.style.cssText =
    (isCompact ? 'font-size:11px;padding:6px 10px;' : 'font-size:13px;padding:10px 14px;') +
    'font-weight:500;color:#f2cd8b;background:rgba(232,163,61,0.10);' +
    'border:1px solid rgba(232,163,61,0.30);border-radius:8px;margin-bottom:4px';
  lockNote.textContent = 'Smart Blocker is locked — bypass is disabled';

  // Locked posture = lock note + "Stay focused" ONLY. No override, no
  // dismiss — even though this page is trusted extension UI, its only
  // legitimate producer is force mode, where bypass is disabled.
  const btnStay = document.createElement('button');
  btnStay.style.cssText =
    'box-sizing:border-box;margin:0;width:100%;font-family:inherit;line-height:1.3;height:auto;' +
    'min-height:min-content;white-space:normal;word-break:break-word;text-transform:none;' +
    'letter-spacing:normal;cursor:pointer;transition:background-color .15s;' +
    (isCompact ? 'padding:7px 12px;font-size:12px;border-radius:8px;' : 'padding:11px 18px;font-size:14px;border-radius:8px;') +
    'background:#efe8d8;color:#1c1405;border:1px solid #efe8d8;font-weight:600;';
  btnStay.textContent = 'Stay focused (close tab)';
  btnStay.addEventListener('mouseenter', () => {
    btnStay.style.background = '#f4efe4';
  });
  btnStay.addEventListener('mouseleave', () => {
    btnStay.style.background = '#efe8d8';
  });
  btnStay.addEventListener('click', (e) => {
    // Consistency with the injected overlay: synthetic events never act.
    if (!e.isTrusted) return;
    handlers.onStay();
  });

  const btnRow = document.createElement('div');
  btnRow.style.cssText =
    'display:flex;flex-direction:column;width:100%;' +
    (isCompact ? 'gap:6px;max-width:300px;' : 'gap:8px;max-width:340px;');
  btnRow.append(lockNote, btnStay);
  parts.push(btnRow);

  // --- Latency meta (normal variant only) ---
  if (!failClosed && spec.ms > 0) {
    const meta = document.createElement('div');
    meta.style.cssText =
      (isCompact ? 'font-size:10px;margin-top:8px;' : 'font-size:12px;margin-top:24px;') +
      'color:#7d7768;font-variant-numeric:tabular-nums';
    meta.textContent = 'Checked on-device in ' + Math.round(spec.ms) + 'ms';
    parts.push(meta);
  }

  column.append(...parts);
  host.appendChild(column);
  root.replaceChildren(host);
}
