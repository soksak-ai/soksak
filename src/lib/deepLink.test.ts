// 딥링크 계약 — command URI 파싱/생성 왕복 + 활성화(권한·danger 게이트 유지=remote:true).
import { describe, expect, it } from "vitest";
import { buildDeepLink, parseDeepLink, resolveDeepLink } from "./deepLink";

describe("parseDeepLink", () => {
  it("soksak://cmd/<command> → {command, params}", () => {
    expect(parseDeepLink("soksak://cmd/git.log")).toEqual({ command: "git.log", params: {} });
  });

  it("쿼리 값 강제: number/bool 은 파싱, 문자열은 그대로", () => {
    expect(
      parseDeepLink("soksak://cmd/mailbox.open?id=m1&n=5&flag=true"),
    ).toEqual({ command: "mailbox.open", params: { id: "m1", n: 5, flag: true } });
  });

  it("형식 불일치는 null(프로토콜·host·빈 command)", () => {
    expect(parseDeepLink("http://x/y")).toBeNull();
    expect(parseDeepLink("soksak://other/x")).toBeNull();
    expect(parseDeepLink("soksak://cmd/")).toBeNull();
    expect(parseDeepLink("not a url")).toBeNull();
  });
});

describe("buildDeepLink ↔ parseDeepLink 왕복", () => {
  it("생성한 URL 을 다시 파싱하면 동일(타입 보존)", () => {
    const url = buildDeepLink("mailbox.open", { id: "m1", project: "projA", n: 2 });
    expect(url).toBe("soksak://cmd/mailbox.open?id=m1&project=projA&n=2");
    expect(parseDeepLink(url)).toEqual({
      command: "mailbox.open",
      params: { id: "m1", project: "projA", n: 2 },
    });
  });

  it("null/undefined 값은 생략", () => {
    expect(buildDeepLink("c", { a: "x", b: null, c: undefined })).toBe("soksak://cmd/c?a=x");
  });
});

describe("resolveDeepLink", () => {
  it("유효 링크 → activate 후 command 실행(remote:true 게이트 유지)", async () => {
    const calls: unknown[] = [];
    const out = await resolveDeepLink("soksak://cmd/mailbox.open?id=m1&project=projA", {
      execute: async (name, params, ctx) => {
        calls.push({ name, params, ctx });
        return { ok: true };
      },
      activate: async () => {
        calls.push("activate");
      },
    });
    expect(out.ok).toBe(true);
    expect(calls[0]).toBe("activate"); // 실행 전에 앱 활성화
    expect(calls[1]).toEqual({
      name: "mailbox.open",
      params: { id: "m1", project: "projA" },
      ctx: { remote: true },
    });
  });

  it("잘못된 링크는 INVALID_PARAMS(실행 안 함)", async () => {
    let executed = false;
    const out = await resolveDeepLink("http://nope", {
      execute: async () => {
        executed = true;
        return { ok: true };
      },
      activate: async () => {},
    });
    expect(out.ok).toBe(false);
    expect(executed).toBe(false);
  });
});
