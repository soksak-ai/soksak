// Name of the matching CLI binary that talks to this app (sok / sok-dev / sok-debug).
//
// The single authoritative value core computes with cli_for_core_build(core_build) and exposes as
// app_environment.cli. The rule is owned by core home.rs — the frontend reads that computed value
// instead of deriving it again. The frontend bundle is env-independent (the same JS ships in all
// three builds), so it has no name of its own at compile time. It reads the name from the host
// once at boot and caches it.
//
// Use = the prefix of a "next command suggestion" (hint). A suggested command line must run under
// exactly the binary attached to this app's socket — a dev app's hint must run under sok-dev to
// reach the dev socket. The prefix is not data but the identity of the suggester (this app), so
// the hint producer builds only the command form and this value is prepended.

import { moduleState } from "../lib/moduleState";
import { invoke } from "../framework";

// Outside the hot-swap boundary — if these values are recreated, the "already done" record and
// the lazy initialization disappear together, and the side that filled them does not refill.
const ms = moduleState("lib/cliIdentity#state", () => ({
  cached: "sok",
}));
// Cached CLI name. Before the boot load and in tests it is the default sok.
export function cliName(): string {
  return ms.cached;
}

// Once at boot — reads the host's computed value (app_environment.cli) and caches it. On failure
// (pre-boot, tests, non-Tauri) it keeps the default sok — the hint does not lose its prefix and
// falls back to the release name.
export async function loadCliName(): Promise<void> {
  try {
    const env = await invoke<{ cli?: unknown }>("app_environment");
    const cli = env?.cli;
    if (typeof cli === "string" && cli) ms.cached = cli;
  } catch {
    // Pre-boot, tests, non-Tauri: keep the default.
  }
}

// Test only — sets the cache directly for per-env prefix verification.
export function __setCliNameForTest(value: string): void {
  ms.cached = value;
}
