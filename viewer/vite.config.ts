// Built with DSIM's own Vite (no new dependency): dsim-main/node_modules/.bin/vite build viewer
// The viewer imports DSIM's renderers and replay player READ-ONLY from ../dsim-main/src.
export default {
  base: './',
  build: { outDir: '../train/public', emptyOutDir: true, target: 'es2022', chunkSizeWarningLimit: 4000 },
  server: { fs: { allow: ['..'] } },
};
