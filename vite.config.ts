import { defineConfig } from 'vite';

// Boards live in browser storage, which is separate for every address (including the port).
// Dev and preview share one fixed address so they see the same boards.
const PORT = 4173;

export default defineConfig({
  // Relative base so the build works from any folder or static host (e.g. GitHub Pages).
  base: './',
  server: { port: PORT, strictPort: true },
  preview: { port: PORT, strictPort: true },
});
