import { createRoot } from 'react-dom/client';
import { MobileNavigation } from './mobile-navigation.tsx';

const navigation = document.getElementById('mobile-navigation');
if (!navigation) throw new Error('Mobile navigation mount is missing');
const root = createRoot(navigation);
root.render(<MobileNavigation />);
window.addEventListener('pagehide', event => { if (!event.persisted) root.unmount(); });

// Legacy panels retain ownership of their DOM until their individual migration.
await import('./app.ts');
