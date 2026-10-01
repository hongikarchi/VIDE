import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('./src/ui', import.meta.url)),
  plugins: [react()],
  // Relative asset addresses: the same page is served at the PC's root and, relayed by the account
  // site, under "/pc/<hostId>/".
  base: './',
  build: {
    target: 'es2022',
    outDir: '../../dist/ui',
    emptyOutDir: true,
    manifest: true,
    // Fonts stay files: the server's CSP allows fonts from 'self' only, not data: addresses.
    assetsInlineLimit: (file) => (file.endsWith('.woff2') ? false : undefined),
  },
});
