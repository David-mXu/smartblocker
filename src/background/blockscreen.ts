// Injected into the page via scripting.executeScript({ func }), which
// SERIALIZES the function — it must be fully self-contained (no imports,
// no closures over module scope). Runs in the page's isolated content-script
// world where chrome.runtime.sendMessage IS available.
export function showBlockScreen(
  label: string,
  score: number,
  title: string,
  ms: number,
): void {
  // Idempotent: remove any prior overlay first.
  document.getElementById('flowguard-overlay')?.remove();

  // --- Root overlay ---
  const overlay = document.createElement('div');
  overlay.id = 'flowguard-overlay';
  overlay.style.cssText =
    'position:fixed;inset:0;z-index:2147483647;' +
    'background:rgba(15,15,20,.96);' +
    'color:#fff;display:flex;flex-direction:column;align-items:center;' +
    'justify-content:center;gap:20px;font-family:system-ui,sans-serif;' +
    'padding:32px;box-sizing:border-box;text-align:center';

  // --- Card container ---
  const card = document.createElement('div');
  card.style.cssText =
    'max-width:520px;width:100%;display:flex;flex-direction:column;' +
    'align-items:center;gap:16px';

  // --- Icon / badge ---
  const badge = document.createElement('div');
  badge.style.cssText =
    'width:56px;height:56px;border-radius:50%;background:#dc2626;' +
    'display:flex;align-items:center;justify-content:center;' +
    'font-size:26px;line-height:1;flex-shrink:0';
  badge.textContent = '\u{1F6AB}';

  // --- Headline ---
  const headline = document.createElement('div');
  headline.style.cssText =
    'font-size:22px;font-weight:700;line-height:1.3;color:#fff';
  headline.textContent = 'FlowGuard blocked this page';

  // --- Category pill ---
  const pill = document.createElement('div');
  pill.style.cssText =
    'display:inline-flex;align-items:center;gap:6px;' +
    'background:rgba(220,38,38,.25);border:1px solid rgba(220,38,38,.5);' +
    'border-radius:99px;padding:4px 14px;font-size:14px;font-weight:600;' +
    'color:#fca5a5;letter-spacing:.02em';
  pill.textContent = label + ' — ' + Math.round(score * 100) + '% confidence';

  // --- Page title ---
  const pageTitle = document.createElement('div');
  pageTitle.style.cssText =
    'font-size:15px;font-weight:400;color:rgba(255,255,255,.7);' +
    'max-width:480px;line-height:1.5;word-break:break-word';
  // Build title text with a preceding label via text nodes — no innerHTML.
  const titleLabel = document.createTextNode('“');
  const titleText = document.createTextNode(title);
  const titleEnd = document.createTextNode('”');
  pageTitle.append(titleLabel, titleText, titleEnd);

  // --- Latency meta ---
  const meta = document.createElement('div');
  meta.style.cssText =
    'font-size:12px;color:rgba(255,255,255,.35);letter-spacing:.03em';
  meta.textContent = 'classified in ' + Math.round(ms) + 'ms';

  // --- Button row ---
  const btnRow = document.createElement('div');
  btnRow.style.cssText =
    'display:flex;flex-direction:column;gap:10px;width:100%;max-width:360px;' +
    'margin-top:8px';

  // PRIMARY: send override correction, then dismiss.
  const btnOverride = document.createElement('button');
  btnOverride.style.cssText =
    'box-sizing:border-box;margin:0;padding:13px 20px;border-radius:8px;border:none;cursor:pointer;' +
    'background:#16a34a;color:#fff;font-size:15px;font-weight:600;' +
    'font-family:inherit;transition:opacity .15s;line-height:1.3;height:auto;min-height:min-content;';
  btnOverride.textContent = 'This is actually productive — let me through';
  btnOverride.addEventListener('mouseenter', () => {
    btnOverride.style.opacity = '0.85';
  });
  btnOverride.addEventListener('mouseleave', () => {
    btnOverride.style.opacity = '1';
  });
  btnOverride.addEventListener('click', () => {
    if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
      chrome.runtime.sendMessage({ type: 'OVERRIDE', title });
    }
    overlay.remove();
  });

  // SECONDARY: close the tab outright — the real "stay focused" action.
  const btnStay = document.createElement('button');
  btnStay.style.cssText =
    'box-sizing:border-box;margin:0;padding:11px 20px;border-radius:8px;cursor:pointer;' +
    'background:transparent;color:rgba(255,255,255,.6);' +
    'border:1px solid rgba(255,255,255,.2);font-size:14px;font-weight:500;' +
    'font-family:inherit;transition:opacity .15s;line-height:1.3;height:auto;min-height:min-content;';
  btnStay.textContent = 'Stay focused (close tab)';
  btnStay.addEventListener('mouseenter', () => {
    btnStay.style.opacity = '0.7';
  });
  btnStay.addEventListener('mouseleave', () => {
    btnStay.style.opacity = '1';
  });
  btnStay.addEventListener('click', () => {
    if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
      chrome.runtime.sendMessage({ type: 'CLOSE_TAB' });
    }
  });

  // TERTIARY: dismiss only — no correction recorded, no tab action. The old
  // "Stay focused" behavior, kept for a plain "let me see it just this once."
  const btnDismiss = document.createElement('button');
  btnDismiss.style.cssText =
    'box-sizing:border-box;margin:0;padding:9px 20px;border-radius:8px;cursor:pointer;' +
    'background:transparent;color:rgba(255,255,255,.35);' +
    'border:none;font-size:13px;font-weight:400;' +
    'font-family:inherit;transition:opacity .15s;line-height:1.3;height:auto;min-height:min-content;';
  btnDismiss.textContent = 'Dismiss';
  btnDismiss.addEventListener('mouseenter', () => {
    btnDismiss.style.opacity = '0.7';
  });
  btnDismiss.addEventListener('mouseleave', () => {
    btnDismiss.style.opacity = '1';
  });
  btnDismiss.addEventListener('click', () => {
    overlay.remove();
  });

  btnRow.append(btnOverride, btnStay, btnDismiss);
  card.append(badge, headline, pill, pageTitle, meta, btnRow);
  overlay.appendChild(card);
  document.documentElement.appendChild(overlay);
}
