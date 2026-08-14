// claude -p stream-json line parser (pure) — turns a byte stream into meaning events.
// No I/O, no publishing, no state: feed(chunk) → event array. Spawn and publish are owned by agent.ts (test isolation).
// Shape source: claude CLI --output-format stream-json --include-partial-messages --verbose
// (verified precedent: the old vtuber claudeCli.ts — same session_id capture, content_block_delta and result contract).

export type AgentEvent =
  // Session identifier (material for --resume continuity). Can arrive repeatedly across lines — the consumer keeps the latest.
  | { kind: "session"; sessionId: string }
  // assistant text delta (streaming fragment).
  | { kind: "text"; text: string }
  // Tool use start — name + input hint (command for Bash). Material for the progress delta ("what is running").
  | { kind: "tool"; name: string; detail?: string }
  // Turn end. ok = whether it succeeded, text = final answer (error description on failure).
  | { kind: "result"; ok: boolean; text: string };

export class AgentStreamParser {
  private buf = "";

  /** Feeds a stream chunk and returns the events of the completed lines (an incomplete line is kept internally). */
  feed(chunk: string): AgentEvent[] {
    this.buf += chunk;
    const events: AgentEvent[] = [];
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let d: Record<string, unknown>;
      try {
        d = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue; // A non-JSON line (a warning and the like) is skipped — the stream continues
      }
      events.push(...this.lineEvents(d));
    }
    return events;
  }

  private lineEvents(d: Record<string, unknown>): AgentEvent[] {
    const out: AgentEvent[] = [];
    if (typeof d.session_id === "string" && d.session_id) {
      out.push({ kind: "session", sessionId: d.session_id });
    }
    if (d.type === "stream_event") {
      const ev = d.event as
        | {
            type?: string;
            delta?: { text?: unknown };
            content_block?: { type?: string; name?: unknown; input?: { command?: unknown } };
          }
        | undefined;
      if (ev?.type === "content_block_delta") {
        const text = typeof ev.delta?.text === "string" ? ev.delta.text : "";
        if (text) out.push({ kind: "text", text });
      } else if (ev?.type === "content_block_start" && ev.content_block?.type === "tool_use") {
        const name = typeof ev.content_block.name === "string" ? ev.content_block.name : "tool";
        out.push({ kind: "tool", name });
      }
    } else if (d.type === "assistant") {
      // tool_use in a completed assistant message — arrives with the input (command) included (absent on the delta path).
      const content = (d.message as { content?: unknown } | undefined)?.content;
      if (Array.isArray(content)) {
        for (const c of content) {
          const b = c as { type?: string; name?: unknown; input?: { command?: unknown } };
          if (b.type === "tool_use") {
            out.push({
              kind: "tool",
              name: typeof b.name === "string" ? b.name : "tool",
              detail: typeof b.input?.command === "string" ? b.input.command : undefined,
            });
          }
        }
      }
    } else if (d.type === "result") {
      const ok = d.subtype === "success";
      const text = ok
        ? String(d.result ?? "")
        : String(d.result ?? d.error ?? d.subtype ?? tmsg("msg.orchestrator.ask.failed"));
      out.push({ kind: "result", ok, text });
    }
    return out;
  }
}
