import { defineConfig } from 'vite';
import { execSync } from 'node:child_process';

// Short commit id shown in-game, so it's easy to tell which build a phone is running.
function buildId(): string {
  const sha = process.env.GITHUB_SHA ?? (() => {
    try {
      return execSync('git rev-parse HEAD').toString().trim();
    } catch {
      return 'dev';
    }
  })();
  return sha.slice(0, 7);
}

// Relative base so the build works on GitHub Pages under /<repo>/ as well as at a domain root.
export default defineConfig({
  base: './',
  define: { __BUILD_ID__: JSON.stringify(buildId()) },
  build: { chunkSizeWarningLimit: 6000 },
});
