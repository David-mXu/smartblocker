import React from 'react';
import { createRoot } from 'react-dom/client';
import '../styles/globals.css';
import { OptionsApp } from './OptionsApp';

const rootEl = document.getElementById('root');
if (rootEl) {
  createRoot(rootEl).render(
    React.createElement(React.StrictMode, null, React.createElement(OptionsApp)),
  );
}
