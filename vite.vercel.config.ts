import path from 'node:path';
import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/postcss';
import { defineConfig } from 'vite';

const rootDirectory = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: path.join(rootDirectory, 'vercel-app'),
  plugins: [react()],
  css: { postcss: { plugins: [tailwindcss()] } },
  resolve: { alias: { '@': rootDirectory } },
  build: {
    outDir: path.join(rootDirectory, 'vercel-dist'),
    emptyOutDir: true,
  },
});
