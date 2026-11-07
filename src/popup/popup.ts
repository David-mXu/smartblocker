import React from 'react';
import { createRoot } from 'react-dom/client';
import '../styles/globals.css';
import { PopupApp } from './PopupApp';
import { loadPopupData, type PopupData } from './popup-model';
import { commitFocusSessionIfDue } from '../shared/focus-session';

// The popup opens at the size of its first paint, so load everything first
// and render real content on frame one (no skeleton → content jump). The
// race keeps a slow storage read from leaving the popup blank; the app then
// loads on its own into reserved-height placeholders.
const PRELOAD_BUDGET_MS = 250;

function render(initial: PopupData | null) {
  const rootEl = document.getElementById('root');
  if (!rootEl) return;
  createRoot(rootEl).render(
    React.createElement(React.StrictMode, null, React.createElement(PopupApp, { initial })),
  );
}

const preload = commitFocusSessionIfDue()
  .catch(() => false)
  .then(() => loadPopupData())
  .catch(() => null);

void Promise.race([
  preload,
  new Promise<null>((resolve) => setTimeout(() => resolve(null), PRELOAD_BUDGET_MS)),
]).then(render);
