import '@fontsource-variable/inter';
import '../../ui/styles.css';
import './options.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Options } from './Options';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Options />
  </StrictMode>,
);
