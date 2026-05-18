import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const SERVER_URL = process.env.VITE_API_URL ?? 'http://localhost:4000';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: '0.0.0.0',
    strictPort: true,
    proxy: {
      '/api': {
        target: SERVER_URL,
        changeOrigin: true,
      },
      '/storage': {
        target: SERVER_URL,
        changeOrigin: true,
      },
    },
  },
  preview: {
    port: 4173,
    host: '0.0.0.0',
    proxy: {
      '/api': { target: SERVER_URL, changeOrigin: true },
      '/storage': { target: SERVER_URL, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
