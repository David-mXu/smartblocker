// Injected into the page via scripting.executeScript({ func }), which
// SERIALIZES the function — it must be fully self-contained (no imports,
// no closures over module scope). Runs in the page's isolated content-script
// world where chrome.runtime.sendMessage IS available.
//
// Security model (red-team 2026-11 — the page itself is the adversary):
// - The overlay host lives in an OPEN shadow root: page document.querySelector
//   and page CSS cannot reach the buttons inside (open, not closed, so the
//   Playwright e2e can still pierce it; hostile reach-through is defeated by
//   the next two layers instead).
// - Every button ignores events with isTrusted === false, so synthetic
//   clicks from page JS (host.shadowRoot is visible to the page in open
//   mode) never fire the handlers.
// - OVERRIDE carries a one-time nonce minted SW-side at injection and
//   validated SW-side — even a relayed/forged message can't allowlist.
// - The host's own declarations are all !important (inline !important beats
//   author !important, so site CSS can no longer hide/move it) and a
//   MutationObserver re-appends the host as a direct <html> child if the
//   page removes/re-parents it. Removal does NOT detach the media trap.
export function showBlockScreen(
  label: string,
  score: number,
  title: string,
  ms: number,
  locked: boolean,
  nonce: string,
  /** User's block threshold (0..1) — draws the meter tick. Optional so older
   *  callers / re-ensure paths keep working without it. */
  threshold?: number,
): void {
  // Re-injection on the same document (SPA nav, sub-frame re-ensure): retire
  // the previous instance's observer + listeners through the isolated-world
  // global before removing its host, or both instances fight re-appending
  // their own hosts. (Isolated-world globals persist across executeScript
  // calls within one document and are invisible to the page.)
  const w = window as unknown as { __smartblockerCleanup?: () => void };
  if (typeof w.__smartblockerCleanup === 'function') {
    try {
      w.__smartblockerCleanup();
    } catch {
      // ignore
    }
    w.__smartblockerCleanup = undefined;
  }
  document.getElementById('smartblocker-overlay')?.remove();
  document.getElementById('smartblocker-curtain')?.remove();

  // Detect embedded sub-frame context (or compact player frame) so layout and
  // actions adapt cleanly without clipping buttons or closing the host tab.
  let isSubFrame = false;
  try {
    isSubFrame = window !== window.top;
  } catch {
    isSubFrame = true;
  }
  const isCompact = isSubFrame || window.innerHeight < 420;

  // True only on a legitimate user action — flips all listeners inert and is
  // the ONLY path that removes the host without the observer putting it back.
  let dismissed = false;

  // Pause any currently playing video/audio immediately and trap autoplay
  // while the block screen remains mounted.
  const pauseMedia = (root: ParentNode = document, destroy = false) => {
    root.querySelectorAll('video, audio').forEach((el) => {
      try {
        const m = el as HTMLMediaElement;
        m.pause();
        m.muted = true;
        if (destroy) {
          m.removeAttribute('src');
          m.src = '';
          m.srcObject = null;
          m.load();
        }
      } catch {
        // ignore
      }
    });
    if (isSubFrame) {
      try {
        window.postMessage('{"event":"command","func":"pauseVideo","args":""}', '*');
        if (destroy) {
          window.postMessage('{"event":"command","func":"stopVideo","args":""}', '*');
        }
      } catch {
        // ignore
      }
    }
  };
  pauseMedia(document, false);
  const onMediaPlay = (e: Event) => {
    if (dismissed) {
      document.removeEventListener('play', onMediaPlay, true);
      document.removeEventListener('playing', onMediaPlay, true);
      return;
    }
    e.stopImmediatePropagation();
    const target = e.target as HTMLMediaElement | null;
    if (target && typeof target.pause === 'function') {
      try {
        target.pause();
        target.muted = true;
      } catch {
        // ignore
      }
    }
  };
  document.addEventListener('play', onMediaPlay, true);
  document.addEventListener('playing', onMediaPlay, true);

  // ── Lamplight block screen (docs/design-notes.md §5) ──────────────────────
  // Inline styles only: host pages have no extension CSS. Hexes mirror
  // src/styles/tokens.css. Full-bleed, no card; "Stay focused" is primary.
  const svgNs = 'http://www.w3.org/2000/svg';
  const createMark = () => {
    const wrap = document.createElement('div');
    wrap.style.cssText =
      'display:flex;align-items:center;gap:8px;font-size:12px;font-weight:500;color:#7d7768;' +
      'letter-spacing:0.01em;margin-bottom:44px';
    const sq = document.createElement('span');
    sq.style.cssText =
      'display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;' +
      'border-radius:5px;background:#efe8d8';
    const svg = document.createElementNS(svgNs, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '12');
    svg.setAttribute('height', '12');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', '#1c1405');
    svg.setAttribute('stroke-width', '2.5');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    const body = document.createElementNS(svgNs, 'rect');
    body.setAttribute('x', '5');
    body.setAttribute('y', '11');
    body.setAttribute('width', '14');
    body.setAttribute('height', '10');
    body.setAttribute('rx', '2');
    const shackle = document.createElementNS(svgNs, 'path');
    shackle.setAttribute('d', 'M8 11V7a4 4 0 0 1 8 0v4');
    svg.append(body, shackle);
    sq.appendChild(svg);
    wrap.append(sq, document.createTextNode('SmartBlocker'));
    return wrap;
  };

  // --- Root overlay host (page can target this element by id, so EVERY
  // declaration is !important — inline !important outranks author !important).
  const host = document.createElement('div');
  host.id = 'smartblocker-overlay';
  host.setAttribute('data-smartblocker-context', isSubFrame ? 'subframe' : 'top');
  host.style.cssText =
    'position:fixed !important;inset:0 !important;z-index:2147483647 !important;' +
    'display:flex !important;flex-direction:column !important;align-items:center !important;' +
    'visibility:visible !important;opacity:1 !important;pointer-events:auto !important;' +
    'transform:none !important;filter:none !important;clip-path:none !important;' +
    'width:auto !important;height:auto !important;margin:0 !important;' +
    'background:radial-gradient(ellipse 70% 50% at 50% -10%, rgba(232,163,61,0.08), rgba(232,163,61,0) 70%), #0e0c09 !important;' +
    'color:#f4efe4 !important;' +
    (isCompact
      ? 'justify-content:flex-start !important;overflow-y:auto !important;overflow-x:hidden !important;padding:10px 12px !important;'
      : 'justify-content:center !important;padding:32px !important;') +
    'font-family:Geist,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;' +
    'box-sizing:border-box !important;text-align:center !important;-webkit-font-smoothing:antialiased';
  // Open shadow root: page document.querySelector/CSS stops at this boundary.
  const shadow = host.attachShadow({ mode: 'open' });

  // --- Centered column (no card: the pause IS the page) ---
  const card = document.createElement('div');
  card.style.cssText =
    (isCompact ? 'max-width:420px;margin:auto;' : 'max-width:520px;') +
    'width:100%;display:flex;flex-direction:column;align-items:center;box-sizing:border-box';

  // --- Eyebrow: what was matched ---
  const niceLabel = label ? label.charAt(0).toUpperCase() + label.slice(1) : '';
  const pill = document.createElement('div');
  pill.style.cssText =
    (isCompact ? 'font-size:11px;margin-bottom:4px;' : 'font-size:13px;margin-bottom:14px;') +
    'font-weight:500;color:#a29a89;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
  pill.textContent = /^blocked rule/i.test(label) ? niceLabel : 'Blocked · ' + niceLabel;

  // --- Headline ---
  const headline = document.createElement('div');
  headline.style.cssText =
    (isCompact ? 'font-size:17px;margin-bottom:4px;' : 'font-size:34px;margin-bottom:14px;') +
    'font-weight:600;line-height:1.1;letter-spacing:-0.03em;color:#f4efe4;text-wrap:balance';
  headline.textContent = isSubFrame ? 'This embed can wait.' : 'This one can wait.';

  // --- Page title (attacker-influenced: text nodes only) ---
  const pageTitle = document.createElement('div');
  pageTitle.style.cssText =
    (isCompact ? 'font-size:12px;margin-bottom:10px;' : 'font-size:15px;margin-bottom:36px;') +
    'display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;' +
    'font-weight:400;line-height:1.5;color:#a29a89;max-width:440px;word-break:break-word';
  const titleLabel = document.createTextNode('“');
  const titleText = document.createTextNode(title);
  const titleEnd = document.createTextNode('”');
  pageTitle.append(titleLabel, titleText, titleEnd);

  // --- Threshold Meter (signature): score fill + amber tick at threshold ---
  const scorePct = Math.max(0, Math.min(100, Math.round(score * 100)));
  const hasThreshold = typeof threshold === 'number' && threshold > 0 && threshold < 1;
  const meter = document.createElement('div');
  meter.style.cssText =
    (isCompact ? 'max-width:260px;gap:6px;margin-bottom:10px;' : 'max-width:340px;gap:8px;margin-bottom:28px;') +
    'width:100%;display:flex;flex-direction:column';
  const meterRow = document.createElement('div');
  meterRow.style.cssText =
    'display:flex;justify-content:space-between;align-items:baseline;font-size:12px;font-variant-numeric:tabular-nums';
  const conf = document.createElement('span');
  conf.style.cssText = 'color:#f4efe4;font-weight:500';
  conf.textContent = scorePct + '% confidence';
  meterRow.appendChild(conf);
  const track = document.createElement('div');
  track.style.cssText = 'position:relative;height:8px;width:100%';
  const trackBase = document.createElement('div');
  trackBase.style.cssText =
    'position:absolute;left:0;right:0;top:3px;height:2px;border-radius:2px;background:#2e2718';
  const trackFill = document.createElement('div');
  trackFill.style.cssText =
    'position:absolute;left:0;top:3px;height:2px;border-radius:2px;background:#f4efe4;width:' + scorePct + '%';
  track.append(trackBase, trackFill);
  if (hasThreshold) {
    const tPct = Math.round((threshold as number) * 100);
    const th = document.createElement('span');
    th.style.cssText = 'color:#7d7768';
    th.textContent = 'blocks at ' + tPct + '%';
    meterRow.appendChild(th);
    const tick = document.createElement('div');
    tick.style.cssText =
      'position:absolute;top:-2px;width:2px;height:12px;margin-left:-1px;border-radius:1px;' +
      'background:#e8a33d;box-shadow:0 0 0 2px #0e0c09;left:' + tPct + '%';
    track.appendChild(tick);
  }
  meter.append(meterRow, track);

  // --- Latency meta (only when a real classification ran) ---
  const meta = document.createElement('div');
  meta.style.cssText =
    (isCompact ? 'font-size:10px;margin-top:8px;' : 'font-size:12px;margin-top:24px;') +
    'color:#7d7768;font-variant-numeric:tabular-nums';
  meta.textContent = 'Checked on-device in ' + Math.round(ms) + 'ms';

  // --- Button row ---
  const btnRow = document.createElement('div');
  btnRow.style.cssText =
    'display:flex;flex-direction:column;width:100%;' +
    (isCompact ? 'gap:6px;max-width:300px;' : 'gap:8px;max-width:340px;');

  // Locked mode (timer/password/frozen/schedule lock active): no bypass —
  // the override and dismiss buttons are never attached, only "close tab" / "hide embed".
  // Amber = commitment (never red: a lock is a promise, not a punishment).
  const lockNote = document.createElement('div');
  lockNote.style.cssText =
    (isCompact ? 'font-size:11px;padding:6px 10px;' : 'font-size:13px;padding:10px 14px;') +
    'font-weight:500;color:#f2cd8b;background:rgba(232,163,61,0.10);' +
    'border:1px solid rgba(232,163,61,0.30);border-radius:8px;margin-bottom:4px';
  lockNote.textContent = 'Smart Blocker is locked — bypass is disabled';

  const btnBase =
    'box-sizing:border-box;margin:0;width:100%;font-family:inherit;line-height:1.3;height:auto;' +
    'min-height:min-content;white-space:normal;word-break:break-word;text-transform:none;' +
    'letter-spacing:normal;cursor:pointer;transition:background-color .15s,border-color .15s,color .15s;' +
    (isCompact ? 'padding:7px 12px;font-size:12px;border-radius:8px;' : 'padding:11px 18px;font-size:14px;border-radius:8px;');

  // Re-mount observer: if the page removes the host or re-parents it into a
  // wrapper (to hide it behind transforms/overflow), put it straight back as
  // a direct <html> child — where hiding it would require hiding the whole
  // page. Guarded so our own re-append doesn't loop, and inert after a
  // legitimate dismissal.
  const remount = new MutationObserver(() => {
    if (dismissed || typeof chrome === 'undefined' || !chrome.runtime?.id) {
      remount.disconnect();
      return;
    }
    try {
      if (host.parentNode !== document.documentElement) {
        document.documentElement.appendChild(host);
        pauseMedia(document, false);
      }
    } catch {
      // document going away — nothing left to protect
    }
  });
  remount.observe(document.documentElement, { childList: true, subtree: true });

  const teardown = () => {
    dismissed = true;
    remount.disconnect();
    document.removeEventListener('play', onMediaPlay, true);
    document.removeEventListener('playing', onMediaPlay, true);
  };
  // Lets the NEXT injected instance retire this one cleanly (see header).
  w.__smartblockerCleanup = () => {
    teardown();
    host.remove();
  };

  const unmuteAll = () => {
    document.querySelectorAll('video, audio').forEach((el) => {
      try {
        (el as HTMLMediaElement).muted = false;
      } catch {
        // ignore
      }
    });
  };

  // SECONDARY: send override correction, then dismiss.
  const btnOverride = document.createElement('button');
  btnOverride.style.cssText =
    btnBase + 'background:transparent;color:#f4efe4;border:1px solid rgba(244,239,228,0.16);font-weight:500;';
  btnOverride.textContent = 'This is actually productive — let me through';
  btnOverride.addEventListener('mouseenter', () => {
    btnOverride.style.background = 'rgba(244,239,228,0.06)';
    btnOverride.style.borderColor = 'rgba(244,239,228,0.28)';
  });
  btnOverride.addEventListener('mouseleave', () => {
    btnOverride.style.background = 'transparent';
    btnOverride.style.borderColor = 'rgba(244,239,228,0.16)';
  });
  btnOverride.addEventListener('click', (e) => {
    // Synthetic clicks dispatched by the blocked PAGE are not user decisions.
    if (!e.isTrusted) return;
    if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
      chrome.runtime.sendMessage({ type: 'OVERRIDE', title, label, score, nonce });
    }
    teardown();
    unmuteAll();
    host.remove();
  });

  // PRIMARY (ivory): close the tab outright on top-level pages, or permanently
  // kill the embedded player inside sub-frames without destroying the host tab.
  const btnStay = document.createElement('button');
  btnStay.style.cssText =
    btnBase + 'background:#efe8d8;color:#1c1405;border:1px solid #efe8d8;font-weight:600;';
  btnStay.textContent = isSubFrame ? 'Stay focused (disable embed)' : 'Stay focused (close tab)';
  btnStay.addEventListener('mouseenter', () => {
    btnStay.style.background = '#f4efe4';
  });
  btnStay.addEventListener('mouseleave', () => {
    btnStay.style.background = '#efe8d8';
  });
  btnStay.addEventListener('click', (e) => {
    if (!e.isTrusted) return;
    if (isSubFrame) {
      pauseMedia(document, true);
      btnRow.remove();
      meter.remove();
      headline.textContent = 'Embedded media disabled';
      return;
    }
    if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
      chrome.runtime.sendMessage({ type: 'CLOSE_TAB' });
    }
  });

  // TERTIARY: dismiss only — no correction recorded, no tab action.
  const btnDismiss = document.createElement('button');
  btnDismiss.style.cssText =
    btnBase + 'background:transparent;color:#7d7768;border:1px solid transparent;font-weight:400;';
  btnDismiss.textContent = 'Dismiss';
  btnDismiss.addEventListener('mouseenter', () => {
    btnDismiss.style.color = '#a29a89';
  });
  btnDismiss.addEventListener('mouseleave', () => {
    btnDismiss.style.color = '#7d7768';
  });
  btnDismiss.addEventListener('click', (e) => {
    if (!e.isTrusted) return;
    teardown();
    unmuteAll();
    host.remove();
  });

  if (locked) {
    btnRow.append(lockNote, btnStay);
  } else {
    btnRow.append(btnStay, btnOverride, btnDismiss);
  }
  if (!isSubFrame) card.appendChild(createMark());
  card.append(pill, headline, pageTitle, meter, btnRow);
  if (ms > 0) card.appendChild(meta);
  shadow.appendChild(card);
  document.documentElement.appendChild(host);
}

/**
 * Self-contained pre-classification curtain injected on high-risk / mixed hosts
 * or deterministic blocklist hits while classification is in flight.
 * Pauses active media, hides the page with a dark curtain to prevent visual/audio
 * flash, and automatically fails open after `timeoutMs` so a slow/aborted check
 * never leaves a tab stuck blank.
 */
export function applyPreBlockCurtain(timeoutMs: number): void {
  if (document.getElementById('smartblocker-overlay')) return;
  document.getElementById('smartblocker-curtain')?.remove();

  const curtain = document.createElement('div');
  curtain.id = 'smartblocker-curtain';
  curtain.style.cssText =
    'position:fixed !important;inset:0 !important;z-index:2147483646 !important;' +
    'visibility:visible !important;opacity:1 !important;transform:none !important;' +
    'background:#0e0c09 !important;pointer-events:none !important;transition:opacity .12s ease';

  const pauseAll = () => {
    document.querySelectorAll('video, audio').forEach((el) => {
      try {
        (el as HTMLMediaElement).pause();
      } catch {
        // ignore
      }
    });
  };
  pauseAll();

  const onPlay = (e: Event) => {
    if (!document.getElementById('smartblocker-curtain')) {
      document.removeEventListener('play', onPlay, true);
      document.removeEventListener('playing', onPlay, true);
      return;
    }
    const target = e.target as HTMLMediaElement | null;
    if (target && typeof target.pause === 'function') {
      try {
        target.pause();
      } catch {
        // ignore
      }
    }
  };
  document.addEventListener('play', onPlay, true);
  document.addEventListener('playing', onPlay, true);

  if (document.documentElement) {
    document.documentElement.appendChild(curtain);
  }

  setTimeout(() => {
    document.removeEventListener('play', onPlay, true);
    document.removeEventListener('playing', onPlay, true);
    document.getElementById('smartblocker-curtain')?.remove();
  }, timeoutMs);
}

/** Self-contained cleanup to remove the pre-classification curtain on allow. */
export function clearPreBlockCurtain(): void {
  document.getElementById('smartblocker-curtain')?.remove();
}

/** Self-contained cleanup for ANY mounted SmartBlocker overlay (normal block
 *  screen or classifier-unavailable screen). Runs the injected instance's own
 *  teardown (re-mount observer + media trap) before removing the host. */
export function clearBlockScreen(): void {
  const w = window as unknown as { __smartblockerCleanup?: () => void };
  if (typeof w.__smartblockerCleanup === 'function') {
    try {
      w.__smartblockerCleanup();
    } catch {
      // ignore
    }
    w.__smartblockerCleanup = undefined;
  }
  document.getElementById('smartblocker-overlay')?.remove();
}

/**
 * FAIL-CLOSED screen (red-team P1 #13): shown ONLY while a hard lock
 * (Frozen Turkey / schedule window / password lock) is active and the
 * on-device classifier cannot run (offscreen document dead, model load
 * failure, classify timeout). The page is blocked BECAUSE the verdict is
 * unavailable — not because of a category match — so this is deliberately
 * louder and communicates zero confidence, and it offers no override or
 * dismiss path even though renderers of showBlockScreen may be unlocked on
 * other pages: fail-closed exists precisely to prevent silent allows.
 * The SW retries classification with exponential backoff underneath; a
 * successful retry swaps this screen for a normal verdict (or removes it).
 *
 * Same hardening as showBlockScreen: every declaration !important, open
 * shadow root (page CSS/querySelector stops at the boundary), isTrusted-gated
 * buttons, MutationObserver re-mount, media pause trap, cleanup global.
 */
export function showClassifierUnavailableScreen(title: string): void {
  const w = window as unknown as { __smartblockerCleanup?: () => void };
  if (typeof w.__smartblockerCleanup === 'function') {
    try {
      w.__smartblockerCleanup();
    } catch {
      // ignore
    }
    w.__smartblockerCleanup = undefined;
  }
  document.getElementById('smartblocker-overlay')?.remove();
  document.getElementById('smartblocker-curtain')?.remove();

  let isSubFrame = false;
  try {
    isSubFrame = window !== window.top;
  } catch {
    isSubFrame = true;
  }
  const isCompact = isSubFrame || window.innerHeight < 420;

  let dismissed = false;

  const pauseMedia = (root: ParentNode = document) => {
    root.querySelectorAll('video, audio').forEach((el) => {
      try {
        const m = el as HTMLMediaElement;
        m.pause();
        m.muted = true;
      } catch {
        // ignore
      }
    });
    if (isSubFrame) {
      try {
        window.postMessage('{"event":"command","func":"pauseVideo","args":""}', '*');
      } catch {
        // ignore
      }
    }
  };
  pauseMedia(document);
  const onMediaPlay = (e: Event) => {
    if (dismissed) {
      document.removeEventListener('play', onMediaPlay, true);
      document.removeEventListener('playing', onMediaPlay, true);
      return;
    }
    e.stopImmediatePropagation();
    const target = e.target as HTMLMediaElement | null;
    if (target && typeof target.pause === 'function') {
      try {
        target.pause();
        target.muted = true;
      } catch {
        // ignore
      }
    }
  };
  document.addEventListener('play', onMediaPlay, true);
  document.addEventListener('playing', onMediaPlay, true);

  // Lamplight fail-closed variant (docs/design-notes.md §5): same full-bleed
  // column as showBlockScreen, amber instead of a verdict, NO score/meter.
  const svgNs = 'http://www.w3.org/2000/svg';
  const createMark = () => {
    const wrap = document.createElement('div');
    wrap.style.cssText =
      'display:flex;align-items:center;gap:8px;font-size:12px;font-weight:500;color:#7d7768;' +
      'letter-spacing:0.01em;margin-bottom:44px';
    const sq = document.createElement('span');
    sq.style.cssText =
      'display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;' +
      'border-radius:5px;background:#efe8d8';
    const svg = document.createElementNS(svgNs, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '12');
    svg.setAttribute('height', '12');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', '#1c1405');
    svg.setAttribute('stroke-width', '2.5');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    const body = document.createElementNS(svgNs, 'rect');
    body.setAttribute('x', '5');
    body.setAttribute('y', '11');
    body.setAttribute('width', '14');
    body.setAttribute('height', '10');
    body.setAttribute('rx', '2');
    const shackle = document.createElementNS(svgNs, 'path');
    shackle.setAttribute('d', 'M8 11V7a4 4 0 0 1 8 0v4');
    svg.append(body, shackle);
    sq.appendChild(svg);
    wrap.append(sq, document.createTextNode('SmartBlocker'));
    return wrap;
  };

  const host = document.createElement('div');
  host.id = 'smartblocker-overlay';
  host.setAttribute('data-smartblocker-context', isSubFrame ? 'subframe' : 'top');
  host.setAttribute('data-smartblocker-reason', 'classifier-unavailable');
  // Amber glow (vs the near-neutral normal screen) so an unavailable-classifier
  // block is instantly distinguishable — in screenshots, logs, and tests.
  host.style.cssText =
    'position:fixed !important;inset:0 !important;z-index:2147483647 !important;' +
    'display:flex !important;flex-direction:column !important;align-items:center !important;' +
    'visibility:visible !important;opacity:1 !important;pointer-events:auto !important;' +
    'transform:none !important;filter:none !important;clip-path:none !important;' +
    'width:auto !important;height:auto !important;margin:0 !important;' +
    'background:radial-gradient(ellipse 70% 50% at 50% -10%, rgba(232,163,61,0.16), rgba(232,163,61,0) 70%), #0e0c09 !important;' +
    'color:#f4efe4 !important;' +
    (isCompact
      ? 'justify-content:flex-start !important;overflow-y:auto !important;overflow-x:hidden !important;padding:10px 12px !important;'
      : 'justify-content:center !important;padding:32px !important;') +
    'font-family:Geist,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;' +
    'box-sizing:border-box !important;text-align:center !important;-webkit-font-smoothing:antialiased';
  const shadow = host.attachShadow({ mode: 'open' });

  const card = document.createElement('div');
  card.style.cssText =
    (isCompact ? 'max-width:420px;margin:auto;' : 'max-width:520px;') +
    'width:100%;display:flex;flex-direction:column;align-items:center;box-sizing:border-box';

  const pill = document.createElement('div');
  pill.style.cssText =
    (isCompact ? 'font-size:11px;margin-bottom:4px;' : 'font-size:13px;margin-bottom:14px;') +
    'font-weight:500;color:#f2cd8b';
  pill.textContent = 'Classifier unavailable — fail-closed';

  const headline = document.createElement('div');
  headline.style.cssText =
    (isCompact ? 'font-size:17px;margin-bottom:4px;' : 'font-size:34px;margin-bottom:14px;') +
    'font-weight:600;line-height:1.1;letter-spacing:-0.03em;color:#f4efe4;text-wrap:balance';
  headline.textContent = isSubFrame ? 'Can’t verify this embed.' : 'Can’t verify this page.';

  const body = document.createElement('div');
  body.style.cssText =
    (isCompact
      ? 'font-size:12px;max-height:6.2em;overflow:hidden;line-height:1.45;margin-bottom:6px;'
      : 'font-size:15px;line-height:1.55;margin-bottom:12px;') +
    'font-weight:400;color:#a29a89;max-width:460px;word-break:break-word;text-wrap:pretty';
  const bodyText = document.createTextNode(
    'A lock is active and the on-device classifier could not run, so Smart Blocker is ' +
      'failing closed instead of letting this through unchecked. It keeps retrying ' +
      'automatically — if the model recovers, this screen updates on its own.',
  );
  body.appendChild(bodyText);

  const pageTitle = document.createElement('div');
  pageTitle.style.cssText =
    (isCompact ? 'font-size:11px;margin-bottom:10px;' : 'font-size:13px;margin-bottom:32px;') +
    'font-weight:400;color:#7d7768;max-width:460px;word-break:break-word;line-height:1.4';
  if (title) {
    const titleLabel = document.createTextNode('“');
    const titleText = document.createTextNode(title);
    const titleEnd = document.createTextNode('”');
    pageTitle.append(titleLabel, titleText, titleEnd);
  }

  const note = document.createElement('div');
  note.style.cssText =
    (isCompact ? 'font-size:11px;padding:6px 10px;' : 'font-size:13px;padding:10px 14px;') +
    'font-weight:500;color:#f2cd8b;background:rgba(232,163,61,0.10);' +
    'border:1px solid rgba(232,163,61,0.30);border-radius:8px;margin-bottom:4px';
  note.textContent = 'Smart Blocker is locked — bypass is disabled';

  const remount = new MutationObserver(() => {
    if (dismissed || typeof chrome === 'undefined' || !chrome.runtime?.id) {
      remount.disconnect();
      return;
    }
    try {
      if (host.parentNode !== document.documentElement) {
        document.documentElement.appendChild(host);
        pauseMedia(document);
      }
    } catch {
      // document going away — nothing left to protect
    }
  });
  remount.observe(document.documentElement, { childList: true, subtree: true });

  const teardown = () => {
    dismissed = true;
    remount.disconnect();
    document.removeEventListener('play', onMediaPlay, true);
    document.removeEventListener('playing', onMediaPlay, true);
  };
  w.__smartblockerCleanup = () => {
    teardown();
    host.remove();
  };

  const btnStay = document.createElement('button');
  btnStay.style.cssText =
    'box-sizing:border-box;margin:0;width:100%;font-family:inherit;line-height:1.3;height:auto;' +
    'min-height:min-content;white-space:normal;word-break:break-word;text-transform:none;' +
    'letter-spacing:normal;cursor:pointer;transition:background-color .15s;' +
    (isCompact ? 'padding:7px 12px;font-size:12px;border-radius:8px;' : 'padding:11px 18px;font-size:14px;border-radius:8px;') +
    'background:#efe8d8;color:#1c1405;border:1px solid #efe8d8;font-weight:600;';
  btnStay.textContent = isSubFrame ? 'Stay focused (disable embed)' : 'Stay focused (close tab)';
  btnStay.addEventListener('mouseenter', () => {
    btnStay.style.background = '#f4efe4';
  });
  btnStay.addEventListener('mouseleave', () => {
    btnStay.style.background = '#efe8d8';
  });
  btnStay.addEventListener('click', (e) => {
    if (!e.isTrusted) return;
    if (isSubFrame) {
      e.stopImmediatePropagation();
      // Permanently kill the embedded player (mirrors showBlockScreen).
      document.querySelectorAll('video, audio').forEach((el) => {
        try {
          const m = el as HTMLMediaElement;
          m.removeAttribute('src');
          m.src = '';
          m.srcObject = null;
          m.load();
        } catch {
          // ignore
        }
      });
      try {
        window.postMessage('{"event":"command","func":"stopVideo","args":""}', '*');
      } catch {
        // ignore
      }
      btnStay.remove();
      headline.textContent = 'Embedded media disabled';
      return;
    }
    if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
      chrome.runtime.sendMessage({ type: 'CLOSE_TAB' });
    }
  });

  const btnRow = document.createElement('div');
  btnRow.style.cssText =
    'display:flex;flex-direction:column;width:100%;' +
    (isCompact ? 'gap:6px;max-width:300px;' : 'gap:8px;max-width:340px;');
  btnRow.append(note, btnStay);
  if (!isSubFrame) card.appendChild(createMark());
  card.append(pill, headline, body, pageTitle, btnRow);
  shadow.appendChild(card);
  document.documentElement.appendChild(host);
}
