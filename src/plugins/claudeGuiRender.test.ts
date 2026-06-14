// @ts-nocheck — vanilla 플러그인(plugins/soksak-claude-gui/main.js) 순수 로직 단위테스트.
// 규칙: 비자명 로직은 순수함수로 분리(named export) → RED→구현→GREEN. tsc 건너뜀, vitest 실행.
//
// 대상:
//   parseLiveResponse(buf)   — ② 라이브 평면: 진행 중 응답 텍스트/토큰/상태 추출(readBuffer 기반)
//   synthAgentProgress(...)  — ③ workflow/agent: agent JSONL+meta 로 진행 라인 합성(거짓 진행률 금지)
//   diffLines(old,new)       — B: Edit/Write 구조화 diff(현 평문 → del/add/ctx 라인)
//   toolResultSummary(name,t)— B: tool_result 결과 카운트(Read N lines 등)
// 버퍼 시그니처 fixture 는 cc2 src 근거(SpinnerAnimationRow.tsx:216 "esc to interrupt",
// figures.ts ⏺) — 실 캡처 검증은 실세션 게이트가 담당.

import { describe, it, expect } from "vitest";
import {
  parseLiveResponse,
  synthAgentProgress,
  diffLines,
  toolResultSummary,
} from "../../plugins/soksak-claude-gui/main.js";

describe("parseLiveResponse (② 라이브 응답 파서)", () => {
  const LIVE = [
    "⏺ 안녕하세요 반갑",
    "습니다 여러분",
    "✻ Cogitating… (esc to interrupt · 1.2k tokens)",
    "─────────────────────────────",
    " > ",
    "─────────────────────────────",
  ].join("\n");
  const IDLE = ["⏺ 이전 답변.", "─────────", " > ", "─────────"].join("\n");

  it("응답중: 진행 텍스트 + 토큰 + responding=true", () => {
    const r = parseLiveResponse(LIVE);
    expect(r.responding).toBe(true);
    expect(r.tokens).toBe(1200); // 1.2k → 1200
    expect(r.text).toBe("안녕하세요 반갑\n습니다 여러분");
  });
  it("idle: responding=false, 텍스트 없음", () => {
    const r = parseLiveResponse(IDLE);
    expect(r.responding).toBe(false);
    expect(r.text).toBe("");
  });
  it("토큰 없는 스피너도 responding 인식", () => {
    const r = parseLiveResponse("⏺ 작업\n(esc to interrupt)");
    expect(r.responding).toBe(true);
    expect(r.tokens).toBe(null);
  });
});

describe("synthAgentProgress (③ 진행 라인 합성 — 실측만, 거짓 금지)", () => {
  const entries = [
    { type: "assistant", message: { content: [{ type: "text", text: "시작" }], usage: { output_tokens: 10 } } },
    { type: "assistant", message: { content: [{ type: "tool_use", name: "Read" }], usage: { output_tokens: 5 } } },
    { type: "user", message: { content: [{ type: "tool_result", content: "ok" }] } },
    { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash" }], usage: { output_tokens: 8 } } },
  ];
  it("tool 카운트·토큰 합·마지막 tool 을 실측", () => {
    const p = synthAgentProgress(entries, { agentType: "Explore", description: "find X" });
    expect(p.agentType).toBe("Explore");
    expect(p.description).toBe("find X");
    expect(p.tools).toBe(2);
    expect(p.tokens).toBe(23);
    expect(p.lastTool).toBe("Bash");
  });
  it("meta 없으면 agentType/description 빈값(추정 금지)", () => {
    const p = synthAgentProgress([], null);
    expect(p.agentType).toBe("");
    expect(p.description).toBe("");
    expect(p.tools).toBe(0);
    expect(p.tokens).toBe(0);
    expect(p.lastTool).toBe(null);
  });
});

describe("diffLines (B: Edit/Write 구조화 diff)", () => {
  it("공통 prefix/suffix 보존, 중간만 del/add", () => {
    expect(diffLines("a\nb\nc", "a\nB\nc")).toEqual([
      { type: "ctx", text: "a" },
      { type: "del", text: "b" },
      { type: "add", text: "B" },
      { type: "ctx", text: "c" },
    ]);
  });
  it("순수 추가(Write 신규)", () => {
    expect(diffLines("", "x\ny")).toEqual([
      { type: "add", text: "x" },
      { type: "add", text: "y" },
    ]);
  });
  it("순수 삭제", () => {
    expect(diffLines("x\ny", "")).toEqual([
      { type: "del", text: "x" },
      { type: "del", text: "y" },
    ]);
  });
  it("변경 없음 = 전부 ctx", () => {
    expect(diffLines("a\nb", "a\nb")).toEqual([
      { type: "ctx", text: "a" },
      { type: "ctx", text: "b" },
    ]);
  });
});

describe("toolResultSummary (B: 결과 카운트)", () => {
  it("Read → N lines", () => {
    expect(toolResultSummary("Read", "l1\nl2\nl3")).toBe("3 lines");
  });
  it("Grep → N matches", () => {
    expect(toolResultSummary("Grep", "m1\nm2")).toBe("2 matches");
  });
  it("빈 결과 → 빈 문자열", () => {
    expect(toolResultSummary("Read", "")).toBe("");
  });
  it("Bash 등 기본 → 빈 문자열(과장 금지)", () => {
    expect(toolResultSummary("Bash", "out\nout2")).toBe("");
  });
});
