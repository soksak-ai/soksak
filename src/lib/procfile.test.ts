import { describe, expect, it } from "vitest";
import { parseProcfile, removeEntry, upsertEntry } from "./procfile";

// Procfile 라운드트립 계약 — 주석·빈 줄·순서 보존, 표준 포맷 유지(비표준 확장 금지).

describe("parseProcfile", () => {
  it("표준 라인을 해석하고 주석·빈 줄은 무시한다", () => {
    const t = "# dev stack\ndev: npm run dev\n\ndb: docker compose up postgres\n";
    expect(parseProcfile(t)).toEqual([
      { name: "dev", cmd: "npm run dev" },
      { name: "db", cmd: "docker compose up postgres" },
    ]);
  });

  it("같은 이름이 여러 번이면 마지막 선언이 이긴다", () => {
    const t = "dev: old\ndev: new\n";
    expect(parseProcfile(t)).toEqual([{ name: "dev", cmd: "new" }]);
  });

  it("cmd 안의 콜론은 그대로 보존한다(URL 등)", () => {
    const t = "web: node server.js --origin http://localhost:3000\n";
    expect(parseProcfile(t)[0].cmd).toBe("node server.js --origin http://localhost:3000");
  });

  it("비형식 라인은 엔트리가 아니다", () => {
    expect(parseProcfile("잘못된 줄\n:no-name\n")).toEqual([]);
  });
});

describe("upsertEntry", () => {
  it("없으면 끝에 붙인다 — 주석·기존 줄 보존", () => {
    const t = "# stack\ndev: npm run dev\n";
    expect(upsertEntry(t, "db", "docker compose up")).toBe(
      "# stack\ndev: npm run dev\ndb: docker compose up\n",
    );
  });

  it("있으면 그 자리에서 교체한다(순서 유지)", () => {
    const t = "a: one\nb: two\nc: three\n";
    expect(upsertEntry(t, "b", "TWO")).toBe("a: one\nb: TWO\nc: three\n");
  });

  it("빈 본문에서 시작할 수 있다", () => {
    expect(upsertEntry("", "dev", "npm run dev")).toBe("dev: npm run dev\n");
  });

  it("이름 형식이 잘못되면 오류가 발생한다", () => {
    expect(() => upsertEntry("", "bad name", "x")).toThrow();
  });
});

describe("removeEntry", () => {
  it("그 선언만 지우고 나머지는 보존한다", () => {
    const t = "# keep\na: one\nb: two\n";
    expect(removeEntry(t, "a")).toEqual({ text: "# keep\nb: two\n", removed: true });
  });

  it("없으면 원문 그대로 removed=false", () => {
    const t = "a: one\n";
    expect(removeEntry(t, "zz")).toEqual({ text: t, removed: false });
  });
});
