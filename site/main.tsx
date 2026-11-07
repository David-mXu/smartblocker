import React from 'react';
import { createRoot } from 'react-dom/client';
import { SiteApp } from './SiteApp';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <SiteApp />
  </React.StrictMode>,
);
