// @ts-nocheck — 대상은 vanilla 플러그인(plugins/soksak-plugin-claude-gui/main.js). tsc 는 건너뛰고
// vitest(esbuild)로만 실행한다. named export(classifyBuffer/createInputQueue)는 로더가 무시
// (loader.ts:38 default 만 사용)하므로 플러그인 동작 불변 — 테스트 전용 노출.
//
// 재현 RED → 구현 → GREEN. 입력 유실 버그(모달/응답중 주입)를 상태머신으로 재현·검증.
// 버퍼 시그니처 fixture 는 cc2 src 근거(PromptInput.tsx:2271 코너 없음 / SpinnerAnimationRow.tsx:216
// "esc to interrupt")로 구성 — 실 캡처 검증은 플랜의 실세션 게이트가 담당.

import { describe, it, expect } from "vitest";
import {
  classifyBuffer,
  createInputQueue,
} from "../../plugins/soksak-plugin-claude-gui/main.js";

// ── 버퍼 fixture(cc2 근거) ───────────────────────────────────────────────────
const PROMPT_BUF = [
  "⏺ 이전 응답입니다.",
  "",
  "─────────────────────────────────────────",
  ' > Try "edit src/foo.ts"',
  "─────────────────────────────────────────",
  "  ? for shortcuts",
].join("\n");

const RESPONDING_BUF = [
  "⏺ 작업 중…",
  "✻ Thinking… (esc to interrupt · 1.2k tokens)",
].join("\n");

// 실측(스크린샷 2026-06-14): /status 등 오버레이 모달은 코너가 아니라 dismiss 힌트
// "Esc to cancel" 로 식별된다. 권한 다이얼로그도 동일(cc2 PermissionPrompt.tsx:309).
const MODAL_STATUS_BUF = [
  "  Settings  Status  Config  Usage  Stats",
  "  Version:      2.1.177",
  "  Session ID:   3e2f7da7-7c61-4f31-8ca9-c232df985352",
  "  Model:        claude-opus-4-8",
  "",
  "  Esc to cancel",
].join("\n");
const MODAL_PERM_BUF = [
  "  Bash command",
  "  Do you want to proceed?",
  "  ❯ 1. Yes",
  "    2. No",
  "  Esc to cancel",
].join("\n");
// 환영 배너는 코너(┌┐└┘)를 쓰지만 모달이 아니다 — 코너만으로 모달 판정하면 오탐(입력 막힘).
const BANNER_PROMPT_BUF = [
  "╭────────────────────────────╮",
  "│ Opus 4.8 · Claude API      │",
  "╰────────────────────────────╯",
  "─────────────────────────────",
  " ❯ ",
  "─────────────────────────────",
  "  ? for shortcuts",
].join("\n");

describe("classifyBuffer (버퍼 → 상태)", () => {
  it("dismiss 힌트(Esc to cancel) = 모달 — /status 등 오버레이", () => {
    expect(classifyBuffer(MODAL_STATUS_BUF)).toBe("modal");
  });
  it("권한 다이얼로그(Do you want to proceed + Esc to cancel) = 모달", () => {
    expect(classifyBuffer(MODAL_PERM_BUF)).toBe("modal");
  });
  it("환영 배너 코너 + 정상 프롬프트 = prompt(코너만으로 모달 판정 금지)", () => {
    expect(classifyBuffer(BANNER_PROMPT_BUF)).toBe("prompt");
  });
  it('"esc to interrupt" = 응답중(모달 아님 — 주입 시 큐 적재 안전)', () => {
    expect(classifyBuffer(RESPONDING_BUF)).toBe("responding");
  });
  it("dismiss·스피너 없음 = 정상 프롬프트", () => {
    expect(classifyBuffer(PROMPT_BUF)).toBe("prompt");
  });
  it("빈 버퍼 = 프롬프트(낙관 — 터미널 준비 전)", () => {
    expect(classifyBuffer("")).toBe("prompt");
  });
  it("모달이 응답중보다 우선(부작용 차단 우선)", () => {
    expect(classifyBuffer(MODAL_STATUS_BUF + "\nesc to interrupt")).toBe("modal");
  });
});

// ── 큐 하네스(주입형 deps — 실 터미널 불요) ───────────────────────────────────
function makeHarness(initial = PROMPT_BUF) {
  let buffer = initial;
  const sent = [];
  let outCb = null;
  let rendered = [];
  let tid = 0;
  const timers = new Map();
  const deps = {
    sendText: (t) => sent.push(t),
    readBuffer: () => buffer,
    onOutput: (cb) => {
      outCb = cb;
      return () => {
        outCb = null;
      };
    },
    onRender: (items) => {
      rendered = items;
    },
    setTimer: (fn, ms) => {
      const id = ++tid;
      timers.set(id, fn);
      return id;
    },
    clearTimer: (id) => timers.delete(id),
    timeoutMs: 2500,
    maxTries: 2,
  };
  return {
    deps,
    sent,
    setBuffer: (b) => {
      buffer = b;
    },
    frame: () => outCb && outCb(), // onOutput 한 프레임 시뮬레이트
    fireTimers: () => {
      const fns = [...timers.values()];
      timers.clear();
      fns.forEach((fn) => fn());
    },
    rendered: () => rendered,
  };
}

describe("createInputQueue (입력 3계층 검증)", () => {
  it("정상 프롬프트 enqueue → 즉시 주입(L1) + injecting", () => {
    const h = makeHarness(PROMPT_BUF);
    const q = createInputQueue(h.deps);
    q.enqueue("안녕");
    expect(h.sent).toEqual(["안녕\r"]);
    expect(q.snapshot()).toEqual([{ text: "안녕", state: "injecting", reason: null }]);
  });

  it("L2: 버퍼에 텍스트 출현 → awaiting", () => {
    const h = makeHarness(PROMPT_BUF);
    const q = createInputQueue(h.deps);
    q.enqueue("안녕");
    h.setBuffer(PROMPT_BUF + "\n⏺ 안녕"); // claude 가 받아 화면에 반영
    h.frame();
    expect(q.snapshot()[0].state).toBe("awaiting");
  });

  it("L3: JSONL user 라인 = 실제 입력 → GUI 큐에서 제거(단일 제거점)", () => {
    const h = makeHarness(PROMPT_BUF);
    const q = createInputQueue(h.deps);
    q.enqueue("안녕");
    h.setBuffer(PROMPT_BUF + "\n안녕");
    h.frame(); // awaiting
    q.confirmUserLine("안녕");
    expect(q.snapshot()).toEqual([]);
  });

  it("모달(/status) 상태 enqueue → held(보류), 주입 안 함(부작용 차단)", () => {
    const h = makeHarness(MODAL_STATUS_BUF);
    const q = createInputQueue(h.deps);
    q.enqueue("진행");
    expect(h.sent).toEqual([]);
    expect(q.snapshot()).toEqual([{ text: "진행", state: "held", reason: "modal" }]);
  });

  it("모달 해제 후 프레임 → 자동 주입(FIFO 드레인)", () => {
    const h = makeHarness(MODAL_STATUS_BUF);
    const q = createInputQueue(h.deps);
    q.enqueue("진행");
    h.setBuffer(PROMPT_BUF); // 다이얼로그 닫힘
    h.frame();
    expect(h.sent).toEqual(["진행\r"]);
    expect(q.snapshot()[0].state).toBe("injecting");
  });

  it("이중주입 방지: injecting 중 다음 항목은 주입 보류", () => {
    const h = makeHarness(PROMPT_BUF);
    const q = createInputQueue(h.deps);
    q.enqueue("a");
    q.enqueue("b");
    expect(h.sent).toEqual(["a\r"]); // b 는 a 가 L2 확인될 때까지 미주입
    expect(q.snapshot().map((i) => i.state)).toEqual(["injecting", "held"]);
  });

  it("중복 '안녕?' x2 → user 라인 1개당 FIFO 1:1 제거(한 라인이 둘 제거 X)", () => {
    const h = makeHarness(PROMPT_BUF);
    const q = createInputQueue(h.deps);
    q.enqueue("안녕?");
    h.setBuffer(PROMPT_BUF + "\n안녕?"); // 1회 출현
    h.frame(); // A1 → awaiting
    q.enqueue("안녕?"); // A1 awaiting 이라 A2 즉시 주입
    h.setBuffer(PROMPT_BUF + "\n안녕?\n안녕?"); // 2회 출현
    h.frame(); // A2 → awaiting (count 2 > before 1)
    expect(q.snapshot().map((i) => i.state)).toEqual(["awaiting", "awaiting"]);
    q.confirmUserLine("안녕?"); // 가장 오래된(A1) 제거
    expect(q.snapshot().length).toBe(1);
    q.confirmUserLine("안녕?"); // A2 제거
    expect(q.snapshot().length).toBe(0);
  });

  it("외부 발신(우리 항목 아님) user 라인은 skip — 큐 안 건드림", () => {
    const h = makeHarness(PROMPT_BUF);
    const q = createInputQueue(h.deps);
    q.enqueue("내메시지");
    h.setBuffer(PROMPT_BUF + "\n내메시지");
    h.frame();
    q.confirmUserLine("TUI에서 직접 친 다른 것");
    expect(q.snapshot().length).toBe(1); // 그대로
  });

  it("L3 supersede: injecting 중이라도 JSONL 확정이면 제거(race)", () => {
    const h = makeHarness(PROMPT_BUF);
    const q = createInputQueue(h.deps);
    q.enqueue("a");
    expect(q.snapshot()[0].state).toBe("injecting");
    q.confirmUserLine("a"); // L2 전에 L3 도착
    expect(q.snapshot()).toEqual([]);
  });

  it("restore: 닫았다 열어도 보류 항목 보존(TUI 갔다와도 안 사라짐)", () => {
    const h = makeHarness(MODAL_STATUS_BUF);
    const q = createInputQueue(h.deps);
    q.enqueue("a");
    q.enqueue("b");
    const saved = q.snapshot();
    expect(saved.length).toBe(2);
    // 재오픈 = 새 큐에 복원
    const h2 = makeHarness(MODAL_STATUS_BUF);
    const q2 = createInputQueue(h2.deps);
    q2.restore(saved);
    expect(q2.snapshot().map((i) => i.text)).toEqual(["a", "b"]);
    expect(h2.sent).toEqual([]); // 모달이라 재주입 안 함
  });

  it("restore: awaiting 항목은 재주입 안 함(이중 주입 방지)", () => {
    const h = makeHarness(PROMPT_BUF);
    const q = createInputQueue(h.deps);
    q.restore([{ text: "x", state: "awaiting", reason: null }]);
    expect(h.sent).toEqual([]); // 이미 claude 큐에 있으므로 재주입 X
    expect(q.snapshot()[0].state).toBe("awaiting");
  });

  it("타임아웃 revert + MAX_TRIES 초과 시 stuck(무한 재주입 방지)", () => {
    const h = makeHarness(PROMPT_BUF);
    const q = createInputQueue(h.deps);
    q.enqueue("a"); // try1 주입
    h.fireTimers(); // L2 미확인 → revert → try2 재주입
    h.fireTimers(); // L2 미확인 → tries>=2 → stuck
    expect(h.sent).toEqual(["a\r", "a\r"]); // 최대 2회만
    expect(q.snapshot()[0]).toEqual({ text: "a", state: "held", reason: "stuck" });
  });
});
