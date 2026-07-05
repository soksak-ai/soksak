// AgentStreamParser 계약 테스트 — stream-json 라인 → 의미 이벤트(순수).
import { describe, expect, it } from "vitest";
import { AgentStreamParser, type AgentEvent } from "./agentStream";

const line = (o: unknown) => JSON.stringify(o) + "\n";

describe("AgentStreamParser", () => {
  it("session_id 를 어느 줄에서든 캡처한다(system.init 등)", () => {
    const p = new AgentStreamParser();
    const ev = p.feed(line({ type: "system", subtype: "init", session_id: "s-1" }));
    expect(ev).toEqual([{ kind: "session", sessionId: "s-1" }]);
  });

  it("content_block_delta 텍스트를 text 이벤트로 흘린다", () => {
    const p = new AgentStreamParser();
    const ev = p.feed(
      line({ type: "stream_event", event: { type: "content_block_delta", delta: { text: "안녕" } } }),
    );
    expect(ev).toEqual([{ kind: "text", text: "안녕" }]);
  });

  it("반 잘린 라인은 보관했다가 완성 시 파싱한다(청크 경계 무관)", () => {
    const p = new AgentStreamParser();
    const full = line({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { text: "조각" } },
    });
    expect(p.feed(full.slice(0, 20))).toEqual([]);
    expect(p.feed(full.slice(20))).toEqual([{ kind: "text", text: "조각" }]);
  });

  it("tool_use 시작(스트림)과 완성 메시지(입력 포함)를 tool 이벤트로 만든다", () => {
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
            { type: "text", text: "실행할게요" },
            { type: "tool_use", name: "Bash", input: { command: "sok window.projects" } },
          ],
        },
      }),
    );
    expect(full).toEqual([{ kind: "tool", name: "Bash", detail: "sok window.projects" }]);
  });

  it("result 성공/실패를 최종 이벤트로 만든다", () => {
    const p = new AgentStreamParser();
    expect(p.feed(line({ type: "result", subtype: "success", result: "창 3개가 열려 있어요." }))).toEqual([
      { kind: "result", ok: true, text: "창 3개가 열려 있어요." },
    ]);
    expect(p.feed(line({ type: "result", subtype: "error_during_execution" }))).toEqual([
      { kind: "result", ok: false, text: "error_during_execution" },
    ]);
  });

  it("JSON 아닌 라인·빈 줄은 조용히 건너뛴다(스트림 지속)", () => {
    const p = new AgentStreamParser();
    const ev = p.feed("warning: something\n\n" + line({ type: "result", subtype: "success", result: "ok" }));
    expect(ev).toEqual([{ kind: "result", ok: true, text: "ok" }] satisfies AgentEvent[]);
  });
});
