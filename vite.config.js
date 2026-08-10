import { defineConfig } from 'vite';
import { resolve } from 'path';
import { readdirSync, statSync } from 'fs';

// Helper to find all HTML files for Vite multi-page build
function getHtmlEntries(dir, entries = {}) {
  const files = readdirSync(dir);
  files.forEach(file => {
    const filePath = resolve(dir, file);
    if (statSync(filePath).isDirectory() && file !== 'node_modules' && file !== 'dist') {
      getHtmlEntries(filePath, entries);
    } else if (file.endsWith('.html')) {
      const name = filePath.replace(__dirname + '/', '').replace('.html', '').replace(/\//g, '_');
      entries[name] = filePath;
    }
  });
  return entries;
}

export default defineConfig({
  build: {
    rollupOptions: {
      input: getHtmlEntries(__dirname)
    }
  },
  server: {
    port: 3000
  }
});
