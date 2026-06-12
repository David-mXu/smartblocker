// Injected into the page via scripting.executeScript({ func }), which
// SERIALIZES the function — it must be fully self-contained (no imports,
// no closures over module scope).
export function showOverlay(label: string, score: number, ms: number) {
  document.getElementById('flowguard-overlay')?.remove();
  const el = document.createElement('div');
  el.id = 'flowguard-overlay';
  el.style.cssText =
    'position:fixed;inset:0;z-index:2147483647;background:rgba(180,0,0,.93);' +
    'color:#fff;display:flex;flex-direction:column;gap:10px;align-items:center;' +
    'justify-content:center;font:700 28px system-ui;cursor:pointer;text-align:center';
  const title = document.createElement('div');
  title.textContent = `FlowGuard blocked this: "${label}" (${Math.round(score * 100)}%)`;
  const meta = document.createElement('div');
  meta.style.cssText = 'font:400 16px system-ui;opacity:.8';
  meta.textContent = `classified in ${Math.round(ms)}ms — click anywhere to dismiss (POC)`;
  el.append(title, meta);
  el.addEventListener('click', () => el.remove());
  document.documentElement.appendChild(el);
}
