// foldFeed contract test — exact parentId correlation (conversation set) coexisting with the legacy heuristic.
import { describe, expect, it } from "vitest";
import { foldFeed, itemWindow, type ActivityEntry } from "./feedFold";

let seq = 0;
const entry = (kind: string, payload: Record<string, unknown>, ts = 1000): ActivityEntry => ({
  seq: ++seq,
  ts,
  kind,
  source: "test",
  payload,
});

describe("foldFeed — the conversation set (parentId is the source of truth)", () => {
  it("prompt, child commands and deltas, answer fold into one card (body in seq order)", () => {
    seq = 0;
    const prompt = entry("chat.prompt", { text: "list the windows", turnId: "pjt-aaaaaa", window: "main" });
    const delta = entry("command.progress", { command: "orchestrator.ask", delta: "checking", parentId: "pjt-aaaaaa", window: "main" });
    const child = entry("command.executed", { command: "window.projects", ok: true, parentId: "pjt-aaaaaa", window: "win-abc" });
    const answer = entry("chat.answer", { text: "three are open", parentId: "pjt-aaaaaa", window: "main" });
    const other = entry("view.activated", { viewId: "tab-aaaaaa", window: "win-abc" });

    const items = foldFeed([prompt, delta, child, answer, other]);
    expect(items).toHaveLength(2);
    const card = items[0];
    if (card.kind !== "chat") throw new Error("card expected");
    expect(card.prompt.payload.text).toBe("list the windows");
    expect(card.body.map((e) => e.kind)).toEqual(["command.progress", "command.executed", "chat.answer"]);
    expect(card.closed).toBe(true);
    // Card visibility follows the parent — the card window is main even when a child is w-abc.
    expect(itemWindow(card)).toBe("main");
  });

  it("a card with no answer stays open (in progress) — a late child after stop is kept in seq order", () => {
    seq = 0;
    const prompt = entry("chat.prompt", { text: "x", turnId: "pjt-aaaaaa", window: "main" });
    const child = entry("command.executed", { command: "ping", ok: true, parentId: "pjt-aaaaaa", window: "main" });
    const open = foldFeed([prompt, child]);
    expect(open[0].kind).toBe("chat");
    expect((open[0] as { closed: boolean }).closed).toBe(false);

    const answer = entry("chat.answer", { text: "stopped", parentId: "pjt-aaaaaa", ok: false, window: "main" });
    const late = entry("command.executed", { command: "late.cmd", ok: true, parentId: "pjt-aaaaaa", window: "main" });
    const closed = foldFeed([prompt, child, answer, late]);
    const card = closed[0];
    if (card.kind !== "chat") throw new Error("card expected");
    expect(card.closed).toBe(true);
    expect(card.body.map((e) => e.kind)).toEqual(["command.executed", "chat.answer", "command.executed"]);
  });

  it("an orphan parentId entry whose parent was evicted is shown on its own (no information lost)", () => {
    seq = 0;
    const orphan = entry("command.executed", { command: "ping", ok: true, parentId: "gone", window: "main" });
    const items = foldFeed([orphan]);
    expect(items).toEqual([{ kind: "entry", entry: orphan, deltas: undefined }]);
  });
});

describe("foldFeed — the legacy heuristic (a delta with no derived correlation)", () => {
  it("a delta with no parentId folds by window, command name and time window", () => {
    seq = 0;
    const d = entry("command.progress", { command: "reconcile", delta: "50%", window: "win-1" }, 1000);
    const done = entry(
      "command.executed",
      { command: "plugin.soksak-plugin-workflow.reconcile", ok: true, window: "win-1", startedAt: 900, finishedAt: 1200 },
      1200,
    );
    const items = foldFeed([d, done]);
    expect(items).toHaveLength(1);
    const it0 = items[0];
    if (it0.kind !== "entry") throw new Error("entry expected");
    expect(it0.deltas?.map((x) => x.payload.delta)).toEqual(["50%"]);
  });

  it("a delta with a parentId is excluded from the heuristic (exact correlation wins)", () => {
    seq = 0;
    const prompt = entry("chat.prompt", { text: "x", turnId: "pjt-aaaaaa", window: "main" });
    const d = entry(
      "command.progress",
      { command: "orchestrator.ask", delta: "thinking", parentId: "pjt-aaaaaa", window: "main" },
      1000,
    );
    // An unrelated run in the same window with an overlapping time window — the heuristic would have folded it into this turn.
    const done = entry(
      "command.executed",
      { command: "orchestrator.ask", ok: true, window: "main", startedAt: 900, finishedAt: 1100 },
      1100,
    );
    const items = foldFeed([prompt, d, done]);
    const card = items.find((x) => x.kind === "chat");
    if (!card || card.kind !== "chat") throw new Error("card expected");
    expect(card.body.map((e) => e.payload.delta)).toEqual(["thinking"]);
    const plain = items.find((x) => x.kind === "entry");
    if (!plain || plain.kind !== "entry") throw new Error("entry expected");
    expect(plain.deltas).toBeUndefined();
  });
});
