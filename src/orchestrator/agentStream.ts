// claude -p stream-json 라인 파서(순수) — 바이트 스트림을 의미 이벤트로 바꾼다.
// I/O·발행·상태 없음: feed(chunk) → 이벤트 배열. 스폰·발행은 agent.ts 소유(테스트 격리).
// 형태 출처: claude CLI --output-format stream-json --include-partial-messages --verbose
// (검증 선례: 구 vtuber claudeCli.ts — session_id 캡처·content_block_delta·result 계약 동일).

export type AgentEvent =
  // 세션 식별자(--resume 연속성 재료). 여러 줄에 실려 반복 도착할 수 있다 — 소비자가 최신을 유지.
  | { kind: "session"; sessionId: string }
  // assistant 텍스트 델타(스트리밍 조각).
  | { kind: "text"; text: string }
  // 도구 사용 시작 — name + 입력 힌트(Bash 는 command). 진행 델타("무엇을 하는 중")의 재료.
  | { kind: "tool"; name: string; detail?: string }
  // 턴 종료. ok=success 여부, text=최종 답변(실패면 오류 설명).
  | { kind: "result"; ok: boolean; text: string };

export class AgentStreamParser {
  private buf = "";

  /** 스트림 조각을 먹이고 완성된 라인들의 이벤트를 돌려준다(불완전 라인은 내부 보관). */
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
        continue; // JSON 아닌 라인(경고 등)은 무시 — 스트림은 계속된다
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
      // 완성 assistant 메시지의 tool_use — 입력(command)까지 담겨 도착한다(델타 경로엔 없음).
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
        : String(d.result ?? d.error ?? d.subtype ?? "실패");
      out.push({ kind: "result", ok, text });
    }
    return out;
  }
}
