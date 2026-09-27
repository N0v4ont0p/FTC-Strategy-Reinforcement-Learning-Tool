// Built with DSIM's own Vite (no new dependency): dsim-main/node_modules/.bin/vite build viewer
// The viewer imports DSIM's renderers and replay player READ-ONLY from ../dsim-main/src.
// Two pages: the studio (index.html) and the printable AUTO playbook (print.html).
import { fileURLToPath } from 'node:url';

const page = (f: string): string => fileURLToPath(new URL(f, import.meta.url));
export default {
  base: './',
  build: {
    outDir: '../train/public',
    emptyOutDir: true,
    target: 'es2022',
    chunkSizeWarningLimit: 4000,
    rollupOptions: { input: { main: page('./index.html'), print: page('./print.html') } },
  },
  server: { fs: { allow: ['..'] } },
};
