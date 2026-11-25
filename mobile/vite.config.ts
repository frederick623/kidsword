import { defineConfig } from "vitest/config";

export default defineConfig({
  // Relative asset paths so the bundle loads from the native WebView (capacitor://, file://)
  base: "./",
  build: {
    outDir: "dist",
    target: "es2020",
    sourcemap: false
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node"
  }
});
