/// <reference types="vitest/globals" />
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Vite config for SlideStage Pro web client.
//
// - dev server proxies `/api` to the Hono API on :3000 (cookies preserved).
// - build outputs to `dist/`.
// - vitest is co-configured here so we ship a single source of truth.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: "0.0.0.0",
    proxy: {
      "/api": {
        target: "http://localhost:3000",
        changeOrigin: false,
        // Keep the cookie path identical so Better Auth's session cookie is
        // accepted by the browser through the proxy.
        cookieDomainRewrite: { "*": "" },
        ws: false,
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
    target: "es2022",
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./tests/setup.ts"],
    css: false,
    include: ["tests/**/*.test.{ts,tsx}"],
  },
});
