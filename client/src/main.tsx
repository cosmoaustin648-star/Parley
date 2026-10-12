import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { initRouter } from './lib/router.ts';

initRouter();
createRoot(document.getElementById('root')!).render(<App />);
