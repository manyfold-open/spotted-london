import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In development the Worker runs on :8787 (npm run dev at the repo root); Vite proxies to it.
const worker = 'http://localhost:8787';

export default defineConfig({
  plugins: [react()],
  worker: { format: 'es' },
  server: {
    port: 5173,
    proxy: { '/api': worker, '/login': worker, '/mcp': worker },
  },
  // the map library is big and only loads on the map and Add screens
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 1100 },
});
