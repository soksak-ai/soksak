// A refusal this API returns is recorded where a person can read it.
import { describe, expect, it, vi } from "vitest";

const published: Array<{ kind: string; source: string; payload: Record<string, unknown> }> = [];
vi.mock("../state/activityFeed", () => ({
  publishActivity: (kind: string, source: string, payload: Record<string, unknown>) => {
    published.push({ kind, source, payload });
  },
}));

import { isBlockedForPlugins } from "./api";

describe("a command a plugin may not run", () => {
  it("is one this API refuses before the registry sees it", () => {
    // The registry records what it executes. A refusal returns before that, so unless this boundary
    // records it the run leaves no trace at all — which is what made a silent index take four
    // rebuilds to find.
    expect(isBlockedForPlugins("plugin.install")).toBe(true);
    expect(isBlockedForPlugins("registry.add")).toBe(true);
    expect(isBlockedForPlugins("session.attach")).toBe(false);
  });
});
