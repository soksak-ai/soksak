// foldFeed 계약 테스트 — parentId 정확 상관(대화 세트)과 레거시 휴리스틱의 공존.
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

describe("foldFeed — 대화 세트(parentId 정본)", () => {
  it("prompt→자식 명령·델타→answer 가 한 카드로 접힌다(seq 순 body)", () => {
    seq = 0;
    const prompt = entry("chat.prompt", { text: "창 알려줘", turnId: "t1", window: "main" });
    const delta = entry("command.progress", { command: "orchestrator.ask", delta: "확인 중", parentId: "t1", window: "main" });
    const child = entry("command.executed", { command: "window.projects", ok: true, parentId: "t1", window: "w-abc" });
    const answer = entry("chat.answer", { text: "3개 열려 있어요", parentId: "t1", window: "main" });
    const other = entry("view.activated", { viewId: "v1", window: "w-abc" });

    const items = foldFeed([prompt, delta, child, answer, other]);
    expect(items).toHaveLength(2);
    const card = items[0];
    if (card.kind !== "chat") throw new Error("card expected");
    expect(card.prompt.payload.text).toBe("창 알려줘");
    expect(card.body.map((e) => e.kind)).toEqual(["command.progress", "command.executed", "chat.answer"]);
    expect(card.closed).toBe(true);
    // 카드 가시성은 부모 기준 — 자식이 w-abc 여도 카드 창은 main.
    expect(itemWindow(card)).toBe("main");
  });

  it("answer 없는 카드는 열림(진행 중) — stop 후 지각 자식도 seq 순 그대로 담는다", () => {
    seq = 0;
    const prompt = entry("chat.prompt", { text: "x", turnId: "t1", window: "main" });
    const child = entry("command.executed", { command: "ping", ok: true, parentId: "t1", window: "main" });
    const open = foldFeed([prompt, child]);
    expect(open[0].kind).toBe("chat");
    expect((open[0] as { closed: boolean }).closed).toBe(false);

    const answer = entry("chat.answer", { text: "중단", parentId: "t1", ok: false, window: "main" });
    const late = entry("command.executed", { command: "late.cmd", ok: true, parentId: "t1", window: "main" });
    const closed = foldFeed([prompt, child, answer, late]);
    const card = closed[0];
    if (card.kind !== "chat") throw new Error("card expected");
    expect(card.closed).toBe(true);
    expect(card.body.map((e) => e.kind)).toEqual(["command.executed", "chat.answer", "command.executed"]);
  });

  it("부모가 밀려난 고아 parentId 엔트리는 단독 표시된다(정보 유실 없음)", () => {
    seq = 0;
    const orphan = entry("command.executed", { command: "ping", ok: true, parentId: "gone", window: "main" });
    const items = foldFeed([orphan]);
    expect(items).toEqual([{ kind: "entry", entry: orphan, deltas: undefined }]);
  });
});

describe("foldFeed — 레거시 휴리스틱(파생 상관 없는 델타)", () => {
  it("parentId 없는 델타는 창+명령명+시간창으로 접힌다", () => {
    seq = 0;
    const d = entry("command.progress", { command: "reconcile", delta: "50%", window: "w-1" }, 1000);
    const done = entry(
      "command.executed",
      { command: "plugin.soksak-plugin-workflow.reconcile", ok: true, window: "w-1", startedAt: 900, finishedAt: 1200 },
      1200,
    );
    const items = foldFeed([d, done]);
    expect(items).toHaveLength(1);
    const it0 = items[0];
    if (it0.kind !== "entry") throw new Error("entry expected");
    expect(it0.deltas?.map((x) => x.payload.delta)).toEqual(["50%"]);
  });

  it("parentId 있는 델타는 휴리스틱 대상에서 제외된다(정확 상관이 우선)", () => {
    seq = 0;
    const prompt = entry("chat.prompt", { text: "x", turnId: "t1", window: "main" });
    const d = entry(
      "command.progress",
      { command: "orchestrator.ask", delta: "생각 중", parentId: "t1", window: "main" },
      1000,
    );
    // 같은 창·겹치는 시간창의 무관한 실행 — 휴리스틱이었다면 이 턴에 잘못 접혔을 것.
    const done = entry(
      "command.executed",
      { command: "orchestrator.ask", ok: true, window: "main", startedAt: 900, finishedAt: 1100 },
      1100,
    );
    const items = foldFeed([prompt, d, done]);
    const card = items.find((x) => x.kind === "chat");
    if (!card || card.kind !== "chat") throw new Error("card expected");
    expect(card.body.map((e) => e.payload.delta)).toEqual(["생각 중"]);
    const plain = items.find((x) => x.kind === "entry");
    if (!plain || plain.kind !== "entry") throw new Error("entry expected");
    expect(plain.deltas).toBeUndefined();
  });
});
