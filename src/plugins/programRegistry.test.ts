// 프로그램 레지스트리 계약 고정 — 등록 충돌/spec 검증/ensure 자동실행 래퍼.
// 래퍼는 사용자 셸에서 실행되는 한 줄이므로 형식을 기계로 고정한다(설치
// 명령이 조용히 깨지면 사용자 터미널에서 즉시 보이는 사고가 된다).
import { describe, expect, it } from "vitest";
import {
  autorunCommandOf,
  useProgramRegistry,
} from "./programRegistry";

const decl = (id: string) => ({ id, title: id });

describe("programRegistry — 등록 규율", () => {
  it("전역 id 충돌은 등록 시점 에러(§0-3)", () => {
    const off = useProgramRegistry
      .getState()
      .register("p1", decl("dup"), { kind: "terminal" });
    try {
      expect(() =>
        useProgramRegistry
          .getState()
          .register("p2", decl("dup"), { kind: "terminal" }),
      ).toThrow(/이미 등록된 프로그램/);
    } finally {
      off();
    }
  });

  it("ensure 는 kind=terminal 한정", () => {
    expect(() =>
      useProgramRegistry.getState().register("p1", decl("bad"), {
        kind: "browser",
        ensure: { bin: "x", install: {} },
      }),
    ).toThrow(/ensure/);
  });

  it("해제 후 재등록 가능(멱등 해제)", () => {
    const off = useProgramRegistry
      .getState()
      .register("p1", decl("re"), { kind: "terminal" });
    off();
    off(); // 멱등
    const off2 = useProgramRegistry
      .getState()
      .register("p1", decl("re"), { kind: "terminal" });
    off2();
  });
});

describe("autorunCommandOf — ensure 래퍼(darwin/jsdom)", () => {
  it("browser kind 는 자동실행 없음", () => {
    expect(autorunCommandOf({ kind: "browser" })).toBeUndefined();
  });

  it("ensure 없으면 command 그대로(맨 터미널은 undefined)", () => {
    expect(autorunCommandOf({ kind: "terminal" })).toBeUndefined();
    expect(autorunCommandOf({ kind: "terminal", command: "claude" })).toBe(
      "claude",
    );
  });

  it("ensure: 셸 PATH 확인 → 있으면 실행, 없으면 공식 설치 명령", () => {
    const cmd = autorunCommandOf(
      {
        kind: "terminal",
        command: "claude",
        ensure: {
          bin: "claude",
          install: { darwin: "curl -fsSL https://claude.ai/install.sh | bash" },
        },
      },
      "darwin",
    );
    // POSIX 셸 한 줄 — command -v 게이트 + then 실행 + else 설치 + 안내.
    expect(cmd).toContain("command -v claude >/dev/null 2>&1");
    expect(cmd).toContain("then claude;");
    expect(cmd).toContain("curl -fsSL https://claude.ai/install.sh | bash");
    expect(cmd).toMatch(/^if .*; fi$/);
  });

  it("이 플랫폼 설치 명령 미제공이면 래핑 없이 command", () => {
    expect(
      autorunCommandOf(
        {
          kind: "terminal",
          command: "codex",
          ensure: { bin: "codex", install: { win32: "irm …" } },
        },
        "darwin",
      ),
    ).toBe("codex");
  });

  it("win32: PowerShell Get-Command 게이트", () => {
    const cmd = autorunCommandOf(
      {
        kind: "terminal",
        command: "claude",
        ensure: {
          bin: "claude",
          install: { win32: "irm https://claude.ai/install.ps1 | iex" },
        },
      },
      "win32",
    );
    expect(cmd).toContain("Get-Command claude");
    expect(cmd).toContain("irm https://claude.ai/install.ps1 | iex");
  });
});
