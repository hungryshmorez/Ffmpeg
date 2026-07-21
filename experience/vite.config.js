import { defineConfig } from 'vite';

// base: './' keeps asset URLs relative so the build can be hosted from any
// sub-path (e.g. doesntmatter.us/experience/) or dropped into the web-OS.
export default defineConfig({
  base: './',
  build: {
    target: 'es2020',
    outDir: 'dist',
    sourcemap: false,
  },
});
