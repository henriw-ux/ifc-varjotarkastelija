import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: { chunkSizeWarningLimit: 4000 },
  optimizeDeps: { exclude: ['web-ifc'] },
});
