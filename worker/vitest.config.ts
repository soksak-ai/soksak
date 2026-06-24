import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Node environment: Node 18+ exposes crypto.subtle with native Ed25519 + HMAC,
    // the same surface the Cloudflare Workers runtime provides. No miniflare/workerd.
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
