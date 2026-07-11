// @vitest-environment node
// core-git-scan 자가검사 — 게이트가 신규 git 유입 픽스처에서 실제로 실패하는지(건전성),
// allowlist·테스트 파일·Rust 테스트 모듈을 위반으로 오인하지 않는지, 그리고 이 repo 의
// 실측이 SEALED 봉인과 정확히 일치하는지(초과도 미달도 없음)를 단언한다.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { scanFile, scanRoot, SEALED } from "./core-git-scan.mjs";

const GATE = join(dirname(fileURLToPath(import.meta.url)), "core-git-scan.mjs");
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

let root;

function runGate() {
  const r = spawnSync(process.execPath, [GATE, "--root", root], { encoding: "utf8" });
  return { status: r.status, out: `${r.stdout}\n${r.stderr}` };
}

function write(rel, content) {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "core-git-scan-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("scanFile — git 기능 표면 판정", () => {
  it("Rust git 서브프로세스 스폰은 잡는다", () => {
    const v = scanFile("src-tauri/src/x.rs", 'let o = std::process::Command::new("git").output();');
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ pattern: "git-spawn", line: 1 });
  });

  it("git 기능 커맨드 식별자(정의·배선·invoke)는 잡는다", () => {
    expect(scanFile("src-tauri/src/x.rs", "pub fn git_log(path: String) {}")).toHaveLength(1);
    expect(scanFile("src/a.ts", 'await invoke("git_status", { path })')).toHaveLength(1);
  });

  it("레지스트리 git 기능 축(register/explorer.git)은 잡는다", () => {
    expect(scanFile("src/a.ts", 'register("git.log", {})')).toHaveLength(1);
    expect(scanFile("src/a.ts", '"msg.explorer.git": "changed"')).toHaveLength(1);
  });

  it("git 권한 축(git:read/git:write)은 잡는다", () => {
    expect(scanFile("src/a.ts", 'has("git:read")')).toHaveLength(1);
    expect(scanFile("src/a.ts", 'has("git:write")')).toHaveLength(1);
  });

  it("generic 문구(경로·주석의 평어 git)는 잡지 않는다", () => {
    expect(scanFile("src/a.ts", "// git init 은 정책 플러그인이 수행")).toEqual([]);
    expect(scanFile("src/a.ts", 'const dir = ".git";')).toEqual([]);
    expect(scanFile("src-tauri/src/x.rs", 'let p = dir.join(".git");')).toEqual([]);
  });

  it("플러그인 설치 메커니즘(plugins.rs 의 git 스폰)은 allowlist 다", () => {
    expect(
      scanFile("src-tauri/src/plugins.rs", 'std::process::Command::new("git").args(["clone"])'),
    ).toEqual([]);
    // 같은 파일이라도 다른 패턴(기능 축)은 사면되지 않는다.
    expect(scanFile("src-tauri/src/plugins.rs", "let s = git_status(p);")).toHaveLength(1);
  });

  it("테스트 파일과 Rust 테스트 모듈은 스캔하지 않는다", () => {
    expect(scanFile("src/a.test.ts", 'register("git.log", {})')).toEqual([]);
    const rs = [
      "pub fn run() {}",
      "#[cfg(test)]",
      "mod tests {",
      '    fn t() { std::process::Command::new("git"); }',
      "}",
    ].join("\n");
    expect(scanFile("src-tauri/src/x.rs", rs)).toEqual([]);
  });
});

describe("게이트 실행 — 신규 유입·봉인 대조", () => {
  it("봉인에 없는 파일의 git 유입은 실패한다", () => {
    write("src/commands/catalogNew.ts", 'register("git.push", { handler: () => {} });');
    const { status, out } = runGate();
    expect(status).toBe(1);
    expect(out).toContain("catalogNew.ts");
    expect(out).toContain("신규 git 유입");
  });

  it("봉인 수 초과는 실패한다", () => {
    // i18n.ts 봉인은 4건 — 5건이면 초과.
    write(
      "src/i18n.ts",
      Array.from({ length: 5 }, (_, i) => `"msg.explorer.git.k${i}": "x"`).join("\n"),
    );
    const { status, out } = runGate();
    expect(status).toBe(1);
    expect(out).toContain("src/i18n.ts");
  });

  // 축소(stale) 메커니즘은 방출이 끝나 SEALED 가 공표(空表)여도 살아 있어야 한다(C5 재입법 시
  // 재가동). 실측 SEALED 와 무관하게, 주입 봉인으로 축소 판정 로직을 직접 검증한다.
  it("봉인 미달(방출 진행)은 stale 로 잡힌다 — SEALED 축소 의무", () => {
    write("src/i18n.ts", '"msg.explorer.git": "x"'); // 실측 1건
    const { stale } = scanRoot(root, new Map([["src/i18n.ts", 4]])); // 봉인 4건 대비
    expect(stale).toEqual([{ file: "src/i18n.ts", count: 1, sealed: 4 }]);
  });

  it("빈 트리는 봉인 전부가 stale 다 — 봉인은 실측과 일치해야만 산다", () => {
    const { stale } = scanRoot(root, new Map([["src-tauri/src/git.rs", 6]]));
    expect(stale).toEqual([{ file: "src-tauri/src/git.rs", count: 0, sealed: 6 }]);
  });
});

describe("이 repo 실측", () => {
  it("실측이 SEALED 와 정확히 일치한다(초과 0·stale 0·allowlist 사용 중)", () => {
    const { added, stale, staleAllowlist, perFile } = scanRoot(REPO_ROOT);
    expect(added).toEqual([]);
    expect(stale).toEqual([]);
    expect(staleAllowlist).toEqual([]);
    // 봉인 파일 집합과 실측 파일 집합이 같다 — 봉인 밖 잔존도, 유령 봉인도 없다.
    expect([...perFile.keys()].sort()).toEqual([...SEALED.keys()].sort());
  });
});
