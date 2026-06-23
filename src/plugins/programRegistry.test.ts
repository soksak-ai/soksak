// 프로그램 레지스트리 계약 고정 — 등록 충돌 / 실행·설치 명령의 분리.
// 실행(autorun)은 command 그대로(래핑 금지 — 터미널에 원라이너가 노출되는
// 사고 방지), 설치(ensure)는 활성화 시점 소관(installCommandFor 가 공급).
import { describe, expect, it } from "vitest";
import {
  autorunCommandOf,
  installCommandFor,
  useProgramRegistry,
} from "./programRegistry";
import type { ContributedProgram } from "./spec";

const term = (id: string, extra: Partial<ContributedProgram> = {}): ContributedProgram => ({
  id,
  title: id,
  kind: "terminal",
  ...extra,
});

describe("programRegistry — 등록 규율", () => {
  it("전역 id 충돌은 등록 시점 에러(§0-3)", () => {
    const off = useProgramRegistry.getState().register("p1", term("dup"));
    try {
      expect(() =>
        useProgramRegistry.getState().register("p2", term("dup")),
      ).toThrow(/이미 등록된 프로그램/);
    } finally {
      off();
    }
  });

  it("해제 후 재등록 가능(멱등 해제)", () => {
    const off = useProgramRegistry.getState().register("p1", term("re"));
    off();
    off(); // 멱등
    const off2 = useProgramRegistry.getState().register("p1", term("re"));
    off2();
  });
});

describe("autorunCommandOf — 실행은 command 그대로(래핑 금지)", () => {
  it("비터미널(view) kind 는 자동실행 없음", () => {
    expect(
      autorunCommandOf({ id: "b", title: "b", kind: "view", view: "x" }),
    ).toBeUndefined();
  });

  it("command 그대로(맨 터미널은 undefined)", () => {
    expect(autorunCommandOf(term("t"))).toBeUndefined();
    expect(autorunCommandOf(term("c", { command: "claude" }))).toBe("claude");
  });

  it("ensure 가 있어도 실행 명령은 command 그대로 — 설치는 활성화 시점 소관", () => {
    expect(
      autorunCommandOf(
        term("c", {
          command: "claude",
          ensure: { bin: "claude", install: { darwin: "curl …" } },
        }),
      ),
    ).toBe("claude");
  });
});

describe("installCommandFor — 활성화 시점 설치 명령(플랫폼 분기)", () => {
  const decl = term("c", {
    command: "claude",
    ensure: {
      bin: "claude",
      install: {
        darwin: "curl -fsSL https://claude.ai/install.sh | bash",
        win32: "irm https://claude.ai/install.ps1 | iex",
      },
    },
  });

  it("이 플랫폼의 공식 설치 명령을 그대로 반환", () => {
    expect(installCommandFor(decl, "darwin")).toBe(
      "curl -fsSL https://claude.ai/install.sh | bash",
    );
    expect(installCommandFor(decl, "win32")).toBe(
      "irm https://claude.ai/install.ps1 | iex",
    );
  });

  it("미제공 플랫폼/ensure 없음/비터미널(view) kind 는 undefined", () => {
    expect(installCommandFor(decl, "linux")).toBeUndefined();
    expect(installCommandFor(term("t"), "darwin")).toBeUndefined();
    expect(
      installCommandFor({ id: "b", title: "b", kind: "view", view: "x" }, "darwin"),
    ).toBeUndefined();
  });
});
