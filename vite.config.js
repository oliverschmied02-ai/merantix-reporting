import { defineConfig } from 'vite';

export default defineConfig({
  preview: {
    allowedHosts: true,
  },
  build: {
    outDir: 'dist',
    rollupOptions: {
      output: {
        // Content-hashed filenames for cache-busting: after a deploy the URL
        // changes, so browsers can't serve a stale bundle. index.html is served
        // with no-cache (see server.js) and always points at the current hash.
        inlineDynamicImports: true,
        entryFileNames: 'assets/app-[hash].js',
        assetFileNames: 'assets/app-[hash].[ext]',
      },
    },
  },
});
