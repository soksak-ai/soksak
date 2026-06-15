// @ts-nocheck — vanilla 플러그인(plugins/soksak-plugin-claude-gui/main.js) 순수 로직 단위테스트.
// 규칙: 비자명 로직은 순수함수로 분리(named export) → RED→구현→GREEN. tsc 건너뜀, vitest 실행.
//
// 대상:
//   synthAgentProgress(...)  — ③ workflow/agent: agent JSONL+meta 로 진행 라인 합성(거짓 진행률 금지)
//   diffLines(old,new)       — B: Edit/Write 구조화 diff(현 평문 → del/add/ctx 라인)
//   toolResultSummary(name,t)— B: tool_result 결과 카운트(Read N lines 등)

import { describe, it, expect } from "vitest";
import {
  synthAgentProgress,
  diffLines,
  toolResultSummary,
  parseCommandTags,
} from "../../plugins/soksak-plugin-claude-gui/main.js";

describe("parseCommandTags (슬래시 명령 transcript 태그 파싱)", () => {
  it("command-name 을 슬래시 명령으로 추출(이름 정규화)", () => {
    const t = "<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>";
    expect(parseCommandTags(t)).toEqual({ kind: "command", name: "/clear", args: "" });
  });

  it("슬래시 없는 이름도 /접두 정규화 + 인자 보존", () => {
    const t = "<command-name>resume</command-name> <command-args>foo bar</command-args>";
    expect(parseCommandTags(t)).toEqual({ kind: "command", name: "/resume", args: "foo bar" });
  });

  it("local-command-stdout 은 출력 텍스트로", () => {
    expect(parseCommandTags("<local-command-stdout>Resume cancelled</local-command-stdout>")).toEqual({
      kind: "stdout",
      text: "Resume cancelled",
    });
  });

  it("빈 stdout 은 text 빈 문자열(버블 생략 신호)", () => {
    expect(parseCommandTags("<local-command-stdout></local-command-stdout>")).toEqual({ kind: "stdout", text: "" });
  });

  it("명령 태그가 아니면 null(일반 메시지)", () => {
    expect(parseCommandTags("안녕하세요")).toBeNull();
    expect(parseCommandTags("")).toBeNull();
    expect(parseCommandTags(null)).toBeNull();
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
