import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('./src/sharing/web', import.meta.url)),
  plugins: [react()],
  build: { target: 'es2022', outDir: '../../../dist/sharing', emptyOutDir: true },
});
