// vite.config.js
import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        // Additional pages will be added here as they are created
      }
    }
  },
  server: {
    port: 3000
  }
});
