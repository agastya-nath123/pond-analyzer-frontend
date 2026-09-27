import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The FastAPI backend has no CORS middleware, so in development the browser
// talks to it through this proxy: /api/analyzeContour -> :8000/analyzeContour.
// Point BACKEND_URL elsewhere if uvicorn runs on another host or port.
const BACKEND_URL = "http://0.0.0.0:8000";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": {
        target: BACKEND_URL,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
        // /analyzeContour on a large map can take a while.
        timeout: 180_000,
        proxyTimeout: 180_000,
      },
    },
  },
  preview: {
    proxy: {
      "/api": {
        target: BACKEND_URL,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
        timeout: 180_000,
        proxyTimeout: 180_000,
      },
    },
  },
});
