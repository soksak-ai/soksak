import { describe, expect, it } from "vitest";
import {
  emitPluginEvent,
  onPluginEvent,
  startPluginHooks,
  type PluginEventMap,
} from "./hooks";
import { useSessions } from "../state/sessions";

// Verifies that startPluginHooks coalesces its sessions diff on a microtask (one synchronous burst
// = one diff) and that event semantics survive the coalescing. Why not rAF: WebKit suspends rAF in
// an occluded window, and an incident was measured where events were delayed indefinitely during
// remote (sok/MCP) operation — the diff is unrelated to rendering, so the microtask is the correct
// alignment point.

// Drain the pending microtask (queueMicrotask in scheduleSessionsDiff).
async function flush() {
  await Promise.resolve();
}

type Ev = { event: keyof PluginEventMap; payload: unknown };

describe("startPluginHooks — sessions diff coalescing", () => {
  it("many writes in one synchronous burst (a resize storm) coalesce into one diff and keep the semantic events", async () => {
    // startPluginHooks runs once per module lifetime (started guard) — started once in this test file.
    startPluginHooks();
    await flush(); // settle the prev snapshot on the pre-start state

    const events: Ev[] = [];
    const subs = (
      ["workspace.changed", "view.activated", "file.opened", "file.closed"] as const
    ).map((e) =>
      onPluginEvent(e, (payload) => events.push({ event: e, payload })),
    );

    const s = useSessions.getState();
    const created = s.addWorkspace({ alias: "perf", root: "<local-evidence>/perf-test" });
    expect(created.ok).toBe(true);

    if (!created.ok) throw new Error("addWorkspace failed");
    // Inside one synchronous burst: add workspace + split + resize storm (120 times) + open file.
    const projectId = created.projectId;
    const split = useSessions
      .getState()
      .splitWithNewView(projectId, created.groupId, "right");
    expect(split.ok).toBe(true);

    // Find the split node id and run the resize storm.
    const tab = useSessions.getState().workspaces.find((t) => t.id === projectId)!;
    const content = tab.spaces[0];
    const splitId =
      content.layout.type === "split" ? content.layout.id : null;
    expect(splitId).not.toBeNull();
    for (let i = 0; i < 120; i++) {
      const a = 0.3 + (i % 40) / 100;
      useSessions.getState().resizeSplit(projectId, splitId!, [a, 1 - a]);
    }

    const opened = useSessions
      .getState()
      .openFileView(projectId, "<local-evidence>/perf-test/a.txt");
    expect(opened.ok).toBe(true);

    // Still before the microtask — 0 events (a diff per write would already have fired many).
    expect(events.length).toBe(0);

    await flush(); // drain the microtask, giving one coalesced diff

    // Semantics preserved: 1 workspace activation change + 1 file open + 1 view activation.
    // The 120 resizes produce no events at all.
    const byEvent = (e: keyof PluginEventMap) =>
      events.filter((x) => x.event === e);
    expect(byEvent("workspace.changed").length).toBe(1);
    expect(byEvent("file.opened").length).toBe(1);
    expect(byEvent("file.opened")[0].payload).toMatchObject({
      path: "<local-evidence>/perf-test/a.txt",
    });
    expect(byEvent("view.activated").length).toBe(1);
    expect(byEvent("file.closed").length).toBe(0);

    // No duplicate firing on a further yield.
    events.length = 0;
    await flush();
    expect(events.length).toBe(0);

    for (const d of subs) d.dispose();
  });

  it("writes in separate bursts each produce a diff — an open and a close in different bursts both fire", async () => {
    const events: Ev[] = [];
    const subOpen = onPluginEvent("file.opened", (p) =>
      events.push({ event: "file.opened", payload: p }),
    );
    const subClose = onPluginEvent("file.closed", (p) =>
      events.push({ event: "file.closed", payload: p }),
    );

    const created = useSessions
      .getState()
      // P5 (no duplicate root) — the root must differ from the first test for a new workspace to be created.
      .addWorkspace({ alias: "perf2", root: "<local-evidence>/perf-test-2" });
    expect(created.ok).toBe(true);
    await flush(); // drain the workspace-added event first
    events.length = 0;

    const tab = useSessions.getState().workspaces.find((t) => t.title === "perf2")!;
    const opened = useSessions
      .getState()
      .openFileView(tab.id, "<local-evidence>/perf-test/b.txt");
    expect(opened.ok).toBe(true);
    await flush();
    expect(events.filter((e) => e.event === "file.opened").length).toBe(1);

    if (opened.ok) {
      useSessions.getState().closeView(tab.id, opened.viewId);
    }
    await flush();
    expect(events.filter((e) => e.event === "file.closed").length).toBe(1);

    subOpen.dispose();
    subClose.dispose();
  });
});

describe("window.live-resize event", () => {
  // Exposes the core native drag signal (window-live-resize) on the plugin events channel.
  // The single channel for terminal and browser plugins to stop heavy work during a drag and snap
  // once at the end — the same shape as app.focus (the window-focus relay). No permission required
  // (a non-sensitive lifecycle signal).
  it("delivers the active toggle in order — true at the start, false at the end", () => {
    const got: boolean[] = [];
    const d = onPluginEvent("window.live-resize", (p) => got.push(p.active));
    emitPluginEvent("window.live-resize", { active: true });
    emitPluginEvent("window.live-resize", { active: false });
    d.dispose();
    // No events are received after disposal.
    emitPluginEvent("window.live-resize", { active: true });
    expect(got).toEqual([true, false]);
  });
});

describe("layout.resize-gesture event", () => {
  // Exposes the pane divider drag gesture (start/end) on the plugin events channel.
  // A layout-internal gesture channel with the same shape as window.live-resize (the window edge)
  // — the signal a native surface provider (browser) uses to defer bounds commits during a drag
  // and show a freeze frame. No permission required (a non-sensitive lifecycle signal).
  it("delivers the active toggle in order — true when the drag starts, false when it ends", () => {
    const got: boolean[] = [];
    const d = onPluginEvent("layout.resize-gesture", (p) => got.push(p.active));
    emitPluginEvent("layout.resize-gesture", { active: true });
    emitPluginEvent("layout.resize-gesture", { active: false });
    d.dispose();
    emitPluginEvent("layout.resize-gesture", { active: true });
    expect(got).toEqual([true, false]);
  });
});

describe("layout.reflow event", () => {
  // The channel the core (App.tsx) fires right after the React commit (useLayoutEffect) once
  // content slots have been parked or unparked, e.g. by a content tab switch. It is the signal for
  // a native surface provider (browser) to re-snap bounds once to the final anchor rect — parking
  // moves position without changing size so ResizeObserver misses it, and the switch signal
  // (view.activated) runs on the store diff microtask, before the commit, so it measures the old
  // position. This channel is the basis for a single post-commit reaction. Without it the webview
  // did not follow on the first click and a second click was required.
  it("delivers the activeSpaceId payload, and delivers nothing after disposal", () => {
    const got: (string | null)[] = [];
    const d = onPluginEvent("layout.reflow", (p) => got.push(p.activeSpaceId));
    emitPluginEvent("layout.reflow", { activeSpaceId: "spc-aaaaaa" });
    emitPluginEvent("layout.reflow", { activeSpaceId: "spc-bbbbbb" });
    d.dispose();
    emitPluginEvent("layout.reflow", { activeSpaceId: "spc-cccccc" });
    expect(got).toEqual(["spc-aaaaaa", "spc-bbbbbb"]);
  });
});
