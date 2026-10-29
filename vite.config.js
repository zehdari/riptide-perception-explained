import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { readdirSync } from 'node:fs';

const pages = Object.fromEntries(readdirSync(__dirname).filter((f) => f.endsWith('.html')).map((f) => [f.replace('.html', ''), resolve(__dirname, f)]));

export default defineConfig({
  base: '/riptide-perception-explained/',
  build: { rollupOptions: { input: pages }, chunkSizeWarningLimit: 1200 },
  worker: { format: 'es' },
});
