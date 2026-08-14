// Core internal path compatibility shim — the real spec (the single truth, parseManifest and so on) is the @soksak-ai/plugin-spec package.
// Routes through the package *by name* without breaking the 24 imports in the core (import("./spec") and so on) (no poking at internal paths).
// The package exports are the build output dist (.js + .d.ts) — before the core build and verify, make spec-gate (= the package build) produces dist
// produces it. The single truth source is packages/plugin-spec/src/spec.ts; the author gate is npx soksak-validate.
export * from "@soksak-ai/plugin-spec";
