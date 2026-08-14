import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import wails from "@wailsio/runtime/plugins/vite";

// The build picks which framework backs the alias. No fallback bundles both implementations and
// chooses by a runtime marker — the unselected implementation must be absent from the bundle graph.
export default defineConfig({
  resolve: {
    alias: {
      "#framework-adapter": resolve(process.cwd(), "src/framework/selected.wails.ts"),
    },
  },
  server: {
    host: "127.0.0.1",
    port: Number(process.env.WAILS_VITE_PORT) || 9245,
    strictPort: true,
  },
  plugins: [react(), wails("./bindings")],
});
