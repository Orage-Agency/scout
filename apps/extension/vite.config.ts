import { defineConfig } from "vite";
import { crx } from "@crxjs/vite-plugin";
import manifest from "./src/manifest.json";

export default defineConfig({
  envDir: "../../",
  plugins: [crx({ manifest })],
  build: {
    outDir: "../../",
    emptyOutDir: false,
    rollupOptions: {
      input: {
        offscreen: "src/offscreen/index.html",
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    hmr: { port: 5174 },
  },
});
