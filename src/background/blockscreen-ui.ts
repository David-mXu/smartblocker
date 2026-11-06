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
}

export interface BlockedPageHandlers {
  /** "Stay focused (close tab)" — wired by the page (CLOSE_TAB message). */
  onStay: () => void;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

function makeShieldIcon(size: number): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', '#f87171');
  svg.setAttribute('stroke-width', '1.75');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  const path1 = document.createElementNS(SVG_NS, 'path');
  path1.setAttribute('d', 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z');
  const path2 = document.createElementNS(SVG_NS, 'path');
  path2.setAttribute('d', 'M9.5 9.5l5 5M14.5 9.5l-5 5');
  svg.append(path1, path2);
  return svg;
}

function makeWarningIcon(size: number): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', '#fbbf24');
  svg.setAttribute('stroke-width', '1.75');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  const p1 = document.createElementNS(SVG_NS, 'path');
  p1.setAttribute(
    'd',
    'M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z',
  );
  const p2 = document.createElementNS(SVG_NS, 'path');
  p2.setAttribute('d', 'M12 9v4M12 17h.01');
  svg.append(p1, p2);
  return svg;
}

/**
 * Render the hardened screen into `root`. Top-level-page variant only (the
 * DNR redirect never targets sub-frames): no sub-frame copy branches.
 * Button posture is the overlay's LOCKED variant — the only legitimate caller
 * of this page is force mode, so override and dismiss buttons are NEVER
 * rendered, regardless of what the query string claims.
 */
export function renderBlockedPage(
  root: HTMLElement,
  spec: BlockedPageSpec,
  handlers: BlockedPageHandlers,
): void {
  const isCompact = window.innerHeight < 420;
  const failClosed = spec.reason === 'classifier-unavailable';

  // --- Root container (mirrors the overlay host's look, minus the fixed-
  // positioning !important armor, which exists to fight page CSS — the
  // hostile page's DOM is not present here).
  const host = document.createElement('div');
  host.id = 'smartblocker-blocked';
  host.setAttribute('data-smartblocker-context', 'top');
  host.setAttribute('data-smartblocker-reason', spec.reason);
  host.style.cssText =
    'position:fixed;inset:0;' +
    'display:flex;flex-direction:column;align-items:center;' +
    'background:radial-gradient(circle at 50% 0%, ' +
    (failClosed ? 'rgba(217,119,6,0.18)' : 'rgba(220,38,38,0.12)') +
    ', rgba(7,7,9,0.98) 62%), #070709;' +
    'color:#fafafa;' +
    (isCompact
      ? 'justify-content:flex-start;overflow-y:auto;overflow-x:hidden;padding:10px 12px;'
      : 'justify-content:center;padding:32px;') +
    'font-family:Geist,Outfit,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;' +
    'box-sizing:border-box;text-align:center;-webkit-font-smoothing:antialiased';

  // --- Card ---
  const card = document.createElement('div');
  card.style.cssText =
    (isCompact
      ? 'max-width:420px;width:100%;gap:8px;padding:14px 16px;border-radius:14px;margin:auto;'
      : 'max-width:540px;width:100%;gap:18px;padding:42px 36px;border-radius:24px;') +
    'display:flex;flex-direction:column;align-items:center;' +
    'background:rgba(13,13,18,0.94);box-shadow:0 32px 90px rgba(0,0,0,0.85);backdrop-filter:blur(24px);box-sizing:border-box;' +
    (failClosed ? 'border:1px solid rgba(251,191,36,0.28)' : 'border:1px solid rgba(255,255,255,0.09)');

  // --- Icon / badge ---
  const badge = document.createElement('div');
  badge.style.cssText =
    (isCompact ? 'width:32px;height:32px;border-radius:10px;' : 'width:52px;height:52px;border-radius:16px;') +
    (failClosed
      ? 'background:rgba(251,191,36,0.12);border:1px solid rgba(251,191,36,0.4);'
      : 'background:rgba(239,68,68,0.12);border:1px solid rgba(239,68,68,0.32);') +
    'display:flex;align-items:center;justify-content:center;flex-shrink:0';
  badge.appendChild(failClosed ? makeWarningIcon(isCompact ? 18 : 24) : makeShieldIcon(isCompact ? 18 : 24));

  // --- Category / status pill ---
  const pill = document.createElement('div');
  pill.style.cssText =
    'display:inline-flex;align-items:center;gap:6px;' +
    (failClosed
      ? 'background:rgba(251,191,36,0.12);border:1px solid rgba(251,191,36,0.42);color:#fcd34d;'
      : 'background:rgba(239,68,68,0.12);border:1px solid rgba(239,68,68,0.35);color:#fca5a5;') +
    (isCompact ? 'border-radius:999px;padding:3px 10px;font-size:10px;' : 'border-radius:999px;padding:5px 14px;font-size:12px;') +
    'font-weight:600;letter-spacing:0.03em;text-transform:uppercase';
  pill.textContent = failClosed
    ? 'Classifier unavailable — fail-closed'
    : spec.label + ' — ' + Math.round(spec.score * 100) + '% confidence';

  // --- Headline ---
  const headline = document.createElement('div');
  headline.style.cssText =
    (isCompact ? 'font-size:15px;' : 'font-size:28px;') +
    'font-weight:600;line-height:1.15;letter-spacing:-0.025em;color:#fafafa;margin-top:2px';
  headline.textContent = failClosed
    ? 'Smart Blocker can’t verify this page'
    : 'Smart Blocker intercepted this page';

  const parts: HTMLElement[] = [badge, pill, headline];

  // --- Fail-closed body copy ---
  if (failClosed) {
    const body = document.createElement('div');
    body.style.cssText =
      (isCompact
        ? 'font-size:12px;max-height:6.2em;overflow:hidden;line-height:1.45;'
        : 'font-size:14px;line-height:1.6;') +
      'font-weight:400;color:#a1a1aa;max-width:460px;word-break:break-word';
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
  pageTitle.style.cssText =
    failClosed
      ? (isCompact ? 'font-size:11px;' : 'font-size:13px;') +
        'font-weight:400;color:#71717a;max-width:460px;word-break:break-word;line-height:1.4'
      : (isCompact
          ? 'font-size:12px;max-height:2.8em;overflow:hidden;line-height:1.35;'
          : 'font-size:15px;line-height:1.55;') +
        'font-weight:400;color:#a1a1aa;max-width:460px;word-break:break-word';
  if (spec.title) {
    pageTitle.append(
      document.createTextNode('“'),
      document.createTextNode(spec.title),
      document.createTextNode('”'),
    );
  }
  parts.push(pageTitle);

  // --- Latency meta (normal variant only — mirroring the injected screens,
  // the fail-closed variant shows no fake confidence/meta) ---
  if (!failClosed && spec.ms > 0) {
    const meta = document.createElement('div');
    meta.style.cssText =
      (isCompact ? 'font-size:10px;' : 'font-size:11px;') +
      'font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;' +
      'color:#71717a;letter-spacing:0.04em;text-transform:uppercase';
    meta.textContent = 'Local ONNX verdict in ' + Math.round(spec.ms) + 'ms';
    parts.push(meta);
  }

  // --- Locked note ---
  const lockNote = document.createElement('div');
  lockNote.style.cssText =
    (isCompact ? 'font-size:11px;padding:6px 10px;' : 'font-size:12px;padding:10px 14px;') +
    'font-weight:500;letter-spacing:0.01em;border-radius:10px;' +
    (failClosed
      ? 'color:#fcd34d;background:rgba(251,191,36,0.1);border:1px solid rgba(251,191,36,0.3);'
      : 'color:#fca5a5;background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.28);');
  lockNote.textContent = 'Smart Blocker is locked — bypass is disabled';

  // --- Button row: locked posture = lock note + "Stay focused" ONLY. No
  // override, no dismiss — even though this page is trusted extension UI, its
  // only legitimate producer is force mode, where bypass is disabled.
  const btnStay = document.createElement('button');
  btnStay.style.cssText =
    'box-sizing:border-box;margin:0;' +
    (isCompact ? 'padding:7px 12px;font-size:12px;border-radius:8px;' : 'padding:12px 20px;font-size:14px;border-radius:10px;') +
    'cursor:pointer;background:rgba(24,24,32,0.9);color:#e4e4e7;' +
    'border:1px solid rgba(255,255,255,0.14);font-weight:500;' +
    'font-family:inherit;transition:border-color .15s,background .15s;line-height:1.3;height:auto;min-height:min-content;' +
    'width:100%;white-space:normal;word-break:break-word;text-transform:none;letter-spacing:normal;';
  btnStay.textContent = 'Stay focused (close tab)';
  btnStay.addEventListener('mouseenter', () => {
    btnStay.style.background = 'rgba(39,39,48,0.95)';
    btnStay.style.borderColor = 'rgba(255,255,255,0.28)';
  });
  btnStay.addEventListener('mouseleave', () => {
    btnStay.style.background = 'rgba(24,24,32,0.9)';
    btnStay.style.borderColor = 'rgba(255,255,255,0.14)';
  });
  btnStay.addEventListener('click', (e) => {
    // Consistency with the injected overlay: synthetic events never act.
    if (!e.isTrusted) return;
    handlers.onStay();
  });

  const btnRow = document.createElement('div');
  btnRow.style.cssText =
    'display:flex;flex-direction:column;' +
    (isCompact ? 'gap:6px;margin-top:4px;max-width:320px;' : 'gap:10px;margin-top:10px;max-width:380px;') +
    'width:100%';
  btnRow.append(lockNote, btnStay);

  parts.push(btnRow);
  card.append(...parts);
  host.appendChild(card);
  root.replaceChildren(host);
}
