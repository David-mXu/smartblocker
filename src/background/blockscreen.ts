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

  const svgNs = 'http://www.w3.org/2000/svg';
  const createShieldIcon = () => {
    const svg = document.createElementNS(svgNs, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', isCompact ? '18' : '24');
    svg.setAttribute('height', isCompact ? '18' : '24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', '#f87171');
    svg.setAttribute('stroke-width', '1.75');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    const path1 = document.createElementNS(svgNs, 'path');
    path1.setAttribute('d', 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z');
    const path2 = document.createElementNS(svgNs, 'path');
    path2.setAttribute('d', 'M9.5 9.5l5 5M14.5 9.5l-5 5');
    svg.append(path1, path2);
    return svg;
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
    'background:radial-gradient(circle at 50% 0%, rgba(220,38,38,0.12), rgba(7,7,9,0.98) 62%), #070709 !important;' +
    'color:#fafafa !important;' +
    (isCompact
      ? 'justify-content:flex-start !important;overflow-y:auto !important;overflow-x:hidden !important;padding:10px 12px !important;'
      : 'justify-content:center !important;padding:32px !important;') +
    'font-family:Geist,Outfit,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;' +
    'box-sizing:border-box !important;text-align:center !important;-webkit-font-smoothing:antialiased';
  // Open shadow root: page document.querySelector/CSS stops at this boundary.
  const shadow = host.attachShadow({ mode: 'open' });

  // --- Editorial monolith card container ---
  const card = document.createElement('div');
  card.style.cssText =
    (isCompact
      ? 'max-width:420px;width:100%;gap:8px;padding:14px 16px;border-radius:14px;margin:auto;'
      : 'max-width:540px;width:100%;gap:18px;padding:42px 36px;border-radius:24px;') +
    'display:flex;flex-direction:column;align-items:center;' +
    'background:rgba(13,13,18,0.94);border:1px solid rgba(255,255,255,0.09);' +
    'box-shadow:0 32px 90px rgba(0,0,0,0.85);backdrop-filter:blur(24px);box-sizing:border-box';

  // --- Icon / badge ---
  const badge = document.createElement('div');
  badge.style.cssText =
    (isCompact ? 'width:32px;height:32px;border-radius:10px;' : 'width:52px;height:52px;border-radius:16px;') +
    'background:rgba(239,68,68,0.12);' +
    'border:1px solid rgba(239,68,68,0.32);display:flex;align-items:center;justify-content:center;' +
    'flex-shrink:0';
  badge.appendChild(createShieldIcon());

  // --- Category pill ---
  const pill = document.createElement('div');
  pill.style.cssText =
    'display:inline-flex;align-items:center;gap:6px;' +
    'background:rgba(239,68,68,0.12);border:1px solid rgba(239,68,68,0.35);' +
    (isCompact ? 'border-radius:999px;padding:3px 10px;font-size:10px;' : 'border-radius:999px;padding:5px 14px;font-size:12px;') +
    'font-weight:600;color:#fca5a5;letter-spacing:0.03em;text-transform:uppercase';
  pill.textContent = label + ' — ' + Math.round(score * 100) + '% confidence';

  // --- Headline ---
  const headline = document.createElement('div');
  headline.style.cssText =
    (isCompact ? 'font-size:15px;' : 'font-size:28px;') +
    'font-weight:600;line-height:1.15;letter-spacing:-0.025em;color:#fafafa;margin-top:2px';
  headline.textContent = isSubFrame
    ? 'Smart Blocker intercepted this embed'
    : 'Smart Blocker intercepted this page';

  // --- Page title ---
  const pageTitle = document.createElement('div');
  pageTitle.style.cssText =
    (isCompact
      ? 'font-size:12px;max-height:2.8em;overflow:hidden;line-height:1.35;'
      : 'font-size:15px;line-height:1.55;') +
    'font-weight:400;color:#a1a1aa;max-width:460px;word-break:break-word';
  const titleLabel = document.createTextNode('“');
  const titleText = document.createTextNode(title);
  const titleEnd = document.createTextNode('”');
  pageTitle.append(titleLabel, titleText, titleEnd);

  // --- Latency meta ---
  const meta = document.createElement('div');
  meta.style.cssText =
    (isCompact ? 'font-size:10px;' : 'font-size:11px;') +
    'font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;' +
    'color:#71717a;letter-spacing:0.04em;text-transform:uppercase';
  meta.textContent = 'Local ONNX verdict in ' + Math.round(ms) + 'ms';

  // --- Button row ---
  const btnRow = document.createElement('div');
  btnRow.style.cssText =
    'display:flex;flex-direction:column;' +
    (isCompact ? 'gap:6px;margin-top:4px;max-width:320px;' : 'gap:10px;margin-top:10px;max-width:380px;') +
    'width:100%';

  // Locked mode (timer/password/frozen/schedule lock active): no bypass —
  // the override and dismiss buttons are never attached, only "close tab" / "hide embed".
  const lockNote = document.createElement('div');
  lockNote.style.cssText =
    (isCompact ? 'font-size:11px;padding:6px 10px;' : 'font-size:12px;padding:10px 14px;') +
    'font-weight:500;color:#fca5a5;background:rgba(239,68,68,0.1);' +
    'border:1px solid rgba(239,68,68,0.28);border-radius:10px;letter-spacing:0.01em';
  lockNote.textContent = 'Smart Blocker is locked — bypass is disabled';

  // Re-mount observer: if the page removes the host or re-parents it into a
  // wrapper (to hide it behind transforms/overflow), put it straight back as
  // a direct <html> child — where hiding it would require hiding the whole
  // page. Guarded so our own re-append doesn't loop, and inert after a
  // legitimate dismissal.
  const remount = new MutationObserver(() => {
    if (dismissed) return;
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

  // PRIMARY: send override correction, then dismiss. High-contrast white button on dark card.
  const btnOverride = document.createElement('button');
  btnOverride.style.cssText =
    'box-sizing:border-box;margin:0;' +
    (isCompact ? 'padding:8px 12px;font-size:12px;border-radius:8px;' : 'padding:13px 20px;font-size:14px;border-radius:10px;') +
    'border:none;cursor:pointer;background:#fafafa;color:#09090b;font-weight:600;' +
    'font-family:inherit;transition:background .15s,transform .15s;line-height:1.3;height:auto;min-height:min-content;' +
    'width:100%;white-space:normal;word-break:break-word;text-transform:none;letter-spacing:-0.01em;';
  btnOverride.textContent = 'This is actually productive — let me through';
  btnOverride.addEventListener('mouseenter', () => {
    btnOverride.style.background = '#ffffff';
  });
  btnOverride.addEventListener('mouseleave', () => {
    btnOverride.style.background = '#fafafa';
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

  // SECONDARY: close the tab outright on top-level pages, or permanently kill
  // the embedded player inside sub-frames without destroying the host tab.
  const btnStay = document.createElement('button');
  btnStay.style.cssText =
    'box-sizing:border-box;margin:0;' +
    (isCompact ? 'padding:7px 12px;font-size:12px;border-radius:8px;' : 'padding:12px 20px;font-size:14px;border-radius:10px;') +
    'cursor:pointer;background:rgba(24,24,32,0.9);color:#e4e4e7;' +
    'border:1px solid rgba(255,255,255,0.14);font-weight:500;' +
    'font-family:inherit;transition:border-color .15s,background .15s;line-height:1.3;height:auto;min-height:min-content;' +
    'width:100%;white-space:normal;word-break:break-word;text-transform:none;letter-spacing:normal;';
  btnStay.textContent = isSubFrame ? 'Stay focused (disable embed)' : 'Stay focused (close tab)';
  btnStay.addEventListener('mouseenter', () => {
    btnStay.style.background = 'rgba(39,39,48,0.95)';
    btnStay.style.borderColor = 'rgba(255,255,255,0.28)';
  });
  btnStay.addEventListener('mouseleave', () => {
    btnStay.style.background = 'rgba(24,24,32,0.9)';
    btnStay.style.borderColor = 'rgba(255,255,255,0.14)';
  });
  btnStay.addEventListener('click', (e) => {
    if (!e.isTrusted) return;
    if (isSubFrame) {
      pauseMedia(document, true);
      btnRow.remove();
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
    'box-sizing:border-box;margin:0;' +
    (isCompact ? 'padding:4px 10px;font-size:11px;border-radius:8px;' : 'padding:9px 20px;font-size:13px;border-radius:10px;') +
    'cursor:pointer;background:transparent;color:#71717a;' +
    'border:none;font-weight:400;' +
    'font-family:inherit;transition:color .15s;line-height:1.3;height:auto;min-height:min-content;' +
    'width:100%;white-space:normal;word-break:break-word;text-transform:none;letter-spacing:normal;';
  btnDismiss.textContent = 'Dismiss';
  btnDismiss.addEventListener('mouseenter', () => {
    btnDismiss.style.color = '#d4d4d8';
  });
  btnDismiss.addEventListener('mouseleave', () => {
    btnDismiss.style.color = '#71717a';
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
    btnRow.append(btnOverride, btnStay, btnDismiss);
  }
  card.append(badge, pill, headline, pageTitle, meta, btnRow);
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
    'background:#070709 !important;pointer-events:none !important;transition:opacity .12s ease';

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

  const svgNs = 'http://www.w3.org/2000/svg';
  const warningIcon = () => {
    const svg = document.createElementNS(svgNs, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', isCompact ? '18' : '24');
    svg.setAttribute('height', isCompact ? '18' : '24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', '#fbbf24');
    svg.setAttribute('stroke-width', '1.75');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    const p1 = document.createElementNS(svgNs, 'path');
    p1.setAttribute('d', 'M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z');
    const p2 = document.createElementNS(svgNs, 'path');
    p2.setAttribute('d', 'M12 9v4M12 17h.01');
    svg.append(p1, p2);
    return svg;
  };

  const host = document.createElement('div');
  host.id = 'smartblocker-overlay';
  host.setAttribute('data-smartblocker-context', isSubFrame ? 'subframe' : 'top');
  host.setAttribute('data-smartblocker-reason', 'classifier-unavailable');
  // Amber (not the normal red) so an unavailable-classifier block is instantly
  // distinguishable from a category block — in screenshots, logs, and tests.
  host.style.cssText =
    'position:fixed !important;inset:0 !important;z-index:2147483647 !important;' +
    'display:flex !important;flex-direction:column !important;align-items:center !important;' +
    'visibility:visible !important;opacity:1 !important;pointer-events:auto !important;' +
    'transform:none !important;filter:none !important;clip-path:none !important;' +
    'width:auto !important;height:auto !important;margin:0 !important;' +
    'background:radial-gradient(circle at 50% 0%, rgba(217,119,6,0.18), rgba(7,7,9,0.985) 62%), #070709 !important;' +
    'color:#fafafa !important;' +
    (isCompact
      ? 'justify-content:flex-start !important;overflow-y:auto !important;overflow-x:hidden !important;padding:10px 12px !important;'
      : 'justify-content:center !important;padding:32px !important;') +
    'font-family:Geist,Outfit,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;' +
    'box-sizing:border-box !important;text-align:center !important;-webkit-font-smoothing:antialiased';
  const shadow = host.attachShadow({ mode: 'open' });

  const card = document.createElement('div');
  card.style.cssText =
    (isCompact
      ? 'max-width:420px;width:100%;gap:8px;padding:14px 16px;border-radius:14px;margin:auto;'
      : 'max-width:540px;width:100%;gap:18px;padding:42px 36px;border-radius:24px;') +
    'display:flex;flex-direction:column;align-items:center;' +
    'background:rgba(13,13,18,0.94);border:1px solid rgba(251,191,36,0.28);' +
    'box-shadow:0 32px 90px rgba(0,0,0,0.85);backdrop-filter:blur(24px);box-sizing:border-box';

  const badge = document.createElement('div');
  badge.style.cssText =
    (isCompact ? 'width:32px;height:32px;border-radius:10px;' : 'width:52px;height:52px;border-radius:16px;') +
    'background:rgba(251,191,36,0.12);' +
    'border:1px solid rgba(251,191,36,0.4);display:flex;align-items:center;justify-content:center;' +
    'flex-shrink:0';
  badge.appendChild(warningIcon());

  const pill = document.createElement('div');
  pill.style.cssText =
    'display:inline-flex;align-items:center;gap:6px;' +
    'background:rgba(251,191,36,0.12);border:1px solid rgba(251,191,36,0.42);' +
    (isCompact ? 'border-radius:999px;padding:3px 10px;font-size:10px;' : 'border-radius:999px;padding:5px 14px;font-size:12px;') +
    'font-weight:600;color:#fcd34d;letter-spacing:0.03em;text-transform:uppercase';
  pill.textContent = 'Classifier unavailable — fail-closed';

  const headline = document.createElement('div');
  headline.style.cssText =
    (isCompact ? 'font-size:15px;' : 'font-size:28px;') +
    'font-weight:600;line-height:1.15;letter-spacing:-0.025em;color:#fafafa;margin-top:2px';
  headline.textContent = isSubFrame
    ? 'Smart Blocker can’t verify this embed'
    : 'Smart Blocker can’t verify this page';

  const body = document.createElement('div');
  body.style.cssText =
    (isCompact
      ? 'font-size:12px;max-height:6.2em;overflow:hidden;line-height:1.45;'
      : 'font-size:14px;line-height:1.6;') +
    'font-weight:400;color:#a1a1aa;max-width:460px;word-break:break-word';
  const bodyText = document.createTextNode(
    'A lock is active and the on-device classifier could not run, so Smart Blocker is ' +
      'failing closed instead of letting this through unchecked. It keeps retrying ' +
      'automatically — if the model recovers, this screen updates on its own.',
  );
  body.appendChild(bodyText);

  const pageTitle = document.createElement('div');
  pageTitle.style.cssText =
    (isCompact ? 'font-size:11px;' : 'font-size:13px;') +
    'font-weight:400;color:#71717a;max-width:460px;word-break:break-word;line-height:1.4';
  if (title) {
    const titleLabel = document.createTextNode('“');
    const titleText = document.createTextNode(title);
    const titleEnd = document.createTextNode('”');
    pageTitle.append(titleLabel, titleText, titleEnd);
  }

  const note = document.createElement('div');
  note.style.cssText =
    (isCompact ? 'font-size:11px;padding:6px 10px;' : 'font-size:12px;padding:10px 14px;') +
    'font-weight:500;color:#fcd34d;background:rgba(251,191,36,0.1);' +
    'border:1px solid rgba(251,191,36,0.3);border-radius:10px;letter-spacing:0.01em';
  note.textContent = 'Smart Blocker is locked — bypass is disabled';

  const remount = new MutationObserver(() => {
    if (dismissed) return;
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
    'box-sizing:border-box;margin:0;' +
    (isCompact ? 'padding:7px 12px;font-size:12px;border-radius:8px;' : 'padding:12px 20px;font-size:14px;border-radius:10px;') +
    'cursor:pointer;background:rgba(24,24,32,0.9);color:#e4e4e7;' +
    'border:1px solid rgba(255,255,255,0.14);font-weight:500;' +
    'font-family:inherit;transition:border-color .15s,background .15s;line-height:1.3;height:auto;min-height:min-content;' +
    'white-space:normal;word-break:break-word;text-transform:none;letter-spacing:normal;';
  btnStay.textContent = isSubFrame ? 'Stay focused (disable embed)' : 'Stay focused (close tab)';
  btnStay.addEventListener('mouseenter', () => {
    btnStay.style.background = 'rgba(39,39,48,0.95)';
    btnStay.style.borderColor = 'rgba(255,255,255,0.28)';
  });
  btnStay.addEventListener('mouseleave', () => {
    btnStay.style.background = 'rgba(24,24,32,0.9)';
    btnStay.style.borderColor = 'rgba(255,255,255,0.14)';
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
    'display:flex;flex-direction:column;' +
    (isCompact ? 'gap:6px;margin-top:4px;max-width:320px;' : 'gap:10px;margin-top:10px;max-width:380px;') +
    'width:100%';
  btnRow.append(note, btnStay);
  card.append(badge, pill, headline, body, pageTitle, btnRow);
  shadow.appendChild(card);
  document.documentElement.appendChild(host);
}
