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
  experimental: {
    // The site can be mounted under a prefix (app.manyfold.ai/spotted-london, see src/mount.ts). The Worker prefixes
    // the paths it writes into the HTML. Paths that the scripts build for themselves (the files a lazy page loads
    // first) are prefixed in the browser, from the same <meta name="app-base">. At the root the prefix is empty.
    renderBuiltUrl: (filename, { hostType }) =>
      hostType === 'js' ? { runtime: `((document.querySelector('meta[name="app-base"]')?.content ?? '') + ${JSON.stringify('/' + filename)})` } : undefined,
  },
});
