// Plugin custom event bus — arbitrary-topic pub/sub between plugins (general coordination).
//
// Separate from core-defined event topics (hooks.ts PluginEventMap: file.saved·command.started…), a plugin
// emits and subscribes to its own topics. Example: acp-core streams an ACP session/update over
// `acp.update.<connId>` → cockpit/lounge (separate plugins) subscribe and render live. It fills the
// **streaming channel** that the single command registry (request/response) cannot provide.
//
// In-app in-memory pub/sub — 0 system access (no files, processes, network). Under the full-trust model (§0-2)
// coordination between plugins is possible anyway, so it is provided to every plugin with no permission gate (general).

import { moduleState } from "../lib/moduleState";

type BusFn = (payload: unknown) => void;
const topics = moduleState(
  "plugins/bus#topics",
  () => new Map<string, Set<BusFn>>(),
);

// Delivers payload to the topic subscribers. One listener error does not block other listeners or emit (isolation).
export function busEmit(topic: string, payload: unknown): void {
  const set = topics.get(topic);
  if (!set) return;
  for (const fn of [...set]) {
    try {
      fn(payload);
    } catch (e) {
      console.error(`[bus] ${topic} listener error:`, e);
    }
  }
}

// Subscribe to a topic → unsubscribe function. (api.ts wraps it with tracker.wrap so deactivation collects it automatically.)
export function busOn(topic: string, fn: BusFn): () => void {
  let set = topics.get(topic);
  if (!set) {
    set = new Set();
    topics.set(topic, set);
  }
  set.add(fn);
  return () => {
    const s = topics.get(topic);
    if (s) {
      s.delete(fn);
      if (s.size === 0) topics.delete(topic);
    }
  };
}

// Test only — clears everything.
export function busResetForTest(): void {
  topics.clear();
}
