// Bundled fonts (참고 앱 A): Inter for Latin, Noto Sans KR for Hangul, JetBrains Mono for code.
import '@fontsource-variable/inter';
import '@fontsource-variable/noto-sans-kr';
import '@fontsource-variable/jetbrains-mono';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { Shell } from './shell/Shell.tsx';

// The shell is drawn once and synchronously (PLAN-26 T-113), so the screen code started below finds
// every element. No StrictMode: the start would run twice (one-time connect token, WebGL, polls).
// The root is not unmounted on pagehide: the screen code disposes the viewport then and needs it.
const mount = document.getElementById('root');
if (!mount) throw new Error('Shell mount is missing');
const root = createRoot(mount);
flushSync(() => root.render(<Shell />));

// The regions' imperative code (src/ui/app/) keeps its DOM until each region's migration.
await import('./app.ts');
