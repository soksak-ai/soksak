// 프로그램 레지스트리 계약 고정 — 등록 충돌/ensure 자동실행 래퍼.
// 래퍼는 사용자 셸에서 실행되는 한 줄이므로 형식을 기계로 고정한다(설치
// 명령이 조용히 깨지면 사용자 터미널에서 즉시 보이는 사고가 된다).
import { describe, expect, it } from "vitest";
import {
  autorunCommandOf,
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

describe("autorunCommandOf — ensure 래퍼", () => {
  it("browser kind 는 자동실행 없음", () => {
    expect(
      autorunCommandOf({ id: "b", title: "b", kind: "browser" }),
    ).toBeUndefined();
  });

  it("ensure 없으면 command 그대로(맨 터미널은 undefined)", () => {
    expect(autorunCommandOf(term("t"))).toBeUndefined();
    expect(autorunCommandOf(term("c", { command: "claude" }))).toBe("claude");
  });

  it("ensure: 셸 PATH 확인 → 있으면 실행, 없으면 공식 설치 명령", () => {
    const cmd = autorunCommandOf(
      term("c", {
        command: "claude",
        ensure: {
          bin: "claude",
          install: { darwin: "curl -fsSL https://claude.ai/install.sh | bash" },
        },
      }),
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
        term("x", {
          command: "codex",
          ensure: { bin: "codex", install: { win32: "irm …" } },
        }),
        "darwin",
      ),
    ).toBe("codex");
  });

  it("win32: PowerShell Get-Command 게이트", () => {
    const cmd = autorunCommandOf(
      term("c", {
        command: "claude",
        ensure: {
          bin: "claude",
          install: { win32: "irm https://claude.ai/install.ps1 | iex" },
        },
      }),
      "win32",
    );
    expect(cmd).toContain("Get-Command claude");
    expect(cmd).toContain("irm https://claude.ai/install.ps1 | iex");
  });
});
