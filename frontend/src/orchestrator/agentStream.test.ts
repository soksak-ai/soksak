// AgentStreamParser contract test — stream-json line to semantic event (pure).
import { describe, expect, it } from "vitest";
import { AgentStreamParser, type AgentEvent } from "./agentStream";

const line = (o: unknown) => JSON.stringify(o) + "\n";

describe("AgentStreamParser", () => {
  it("captures session_id from any line (system.init and others)", () => {
    const p = new AgentStreamParser();
    const ev = p.feed(line({ type: "system", subtype: "init", session_id: "s-1" }));
    expect(ev).toEqual([{ kind: "session", sessionId: "s-1" }]);
  });

  it("emits content_block_delta text as a text event", () => {
    const p = new AgentStreamParser();
    const ev = p.feed(
      line({ type: "stream_event", event: { type: "content_block_delta", delta: { text: "hi" } } }),
    );
    expect(ev).toEqual([{ kind: "text", text: "hi" }]);
  });

  it("holds a half-cut line and parses it once it is complete (chunk boundaries do not matter)", () => {
    const p = new AgentStreamParser();
    const full = line({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { text: "piece" } },
    });
    expect(p.feed(full.slice(0, 20))).toEqual([]);
    expect(p.feed(full.slice(20))).toEqual([{ kind: "text", text: "piece" }]);
  });

  it("turns a tool_use start (stream) and the completed message (with input) into tool events", () => {
    const p = new AgentStreamParser();
    const started = p.feed(
      line({
        type: "stream_event",
        event: { type: "content_block_start", content_block: { type: "tool_use", name: "Bash" } },
      }),
    );
    expect(started).toEqual([{ kind: "tool", name: "Bash" }]);
    const full = p.feed(
      line({
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "running it" },
            { type: "tool_use", name: "Bash", input: { command: "sok window.projects" } },
          ],
        },
      }),
    );
    expect(full).toEqual([{ kind: "tool", name: "Bash", detail: "sok window.projects" }]);
  });

  it("turns result success and failure into the final event", () => {
    const p = new AgentStreamParser();
    expect(p.feed(line({ type: "result", subtype: "success", result: "three windows are open." }))).toEqual([
      { kind: "result", ok: true, text: "three windows are open." },
    ]);
    expect(p.feed(line({ type: "result", subtype: "error_during_execution" }))).toEqual([
      { kind: "result", ok: false, text: "error_during_execution" },
    ]);
  });

  it("skips a non-JSON line and a blank line silently (the stream continues)", () => {
    const p = new AgentStreamParser();
    const ev = p.feed("warning: something\n\n" + line({ type: "result", subtype: "success", result: "ok" }));
    expect(ev).toEqual([{ kind: "result", ok: true, text: "ok" }] satisfies AgentEvent[]);
  });
});
