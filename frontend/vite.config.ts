import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import wails from "@wailsio/runtime/plugins/vite";

const MAX_CHUNK_BYTES = 500_000;

function enforceChunkBudget(): Plugin {
  return {
    name: "enforce-chunk-budget",
    generateBundle(_, bundle) {
      for (const output of Object.values(bundle)) {
        if (output.type === "chunk" && Buffer.byteLength(output.code) > MAX_CHUNK_BYTES) {
          this.error(`${output.fileName} is ${Buffer.byteLength(output.code)} bytes; maximum is ${MAX_CHUNK_BYTES}`);
        }
      }
    },
  };
}

// The build picks which framework backs the alias. No fallback bundles both implementations and
// chooses by a runtime marker — the unselected implementation must be absent from the bundle graph.
export default defineConfig({
  build: {
    rolldownOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("/node_modules/react") || id.includes("/node_modules/scheduler/")) return "react";
          if (id.includes("/node_modules/@soksak-ai/plugin-spec/")) return "plugin-spec";
          if (/\/src\/i18n\.(?:en|ko)\.ts$/.test(id)) return "translations";
        },
      },
    },
  },
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
  plugins: [react(), wails("./bindings"), enforceChunkBudget()],
});
