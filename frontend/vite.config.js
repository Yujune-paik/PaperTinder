import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    // Proxy for local development only (not used on Vercel)
    proxy: {
      "/api": "http://localhost:8000",
      "/figures": "http://localhost:8000",
    },
  },
  build: {
    outDir: "dist",
  },
});
