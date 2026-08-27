import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: resolve("src/renderer"),
  publicDir: resolve("src/renderer/public"),
  plugins: [react()],
  resolve: {
    alias: {
      "@shared": resolve("src/shared"),
      "@renderer": resolve("src/renderer/src"),
    },
  },
  server: {
    port: 5179,
    strictPort: true,
  },
});
