import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { injectCssVars } from './theme';
import './styles.css';

// Las variables CSS tienen que existir antes del primer render.
injectCssVars();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
