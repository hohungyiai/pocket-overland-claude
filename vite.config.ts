import { defineConfig } from 'vite';

// Relative base so the build works on GitHub Pages under /<repo>/ as well as at a domain root.
export default defineConfig({
  base: './',
  build: { chunkSizeWarningLimit: 6000 },
});
