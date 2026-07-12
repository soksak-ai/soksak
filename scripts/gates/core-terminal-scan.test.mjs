// @vitest-environment node
// core-terminal-scan 자가검사 — 게이트가 신규 해석기 유입 픽스처에서 실제로 실패하는지
// (건전성), PTY 배관 allowlist·테스트 코드·무관 배관(wal_checkpoint)을 위반으로 오인하지
// 않는지, 그리고 축소(stale) 메커니즘이 봉인 공표 후에도 사는지를 단언한다.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { scanFile, scanRoot, SEALED } from "./core-terminal-scan.mjs";

const GATE = join(dirname(fileURLToPath(import.meta.url)), "core-terminal-scan.mjs");
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
  root = mkdtempSync(join(tmpdir(), "core-terminal-scan-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("scanFile — 해석기 표면 판정", () => {
  it("VT 엔진·미러 어휘는 잡는다", () => {
    expect(scanFile("src-tauri/src/x.rs", "use soksak_pty_mirror::Mirror;")).toHaveLength(1);
    expect(scanFile("src-tauri/crates/a/Cargo.rs", "// soksak-pty-mirror path")).toHaveLength(1);
    expect(scanFile("src-tauri/src/x.rs", "let s = alacritty_terminal::Term::new();")).toHaveLength(1);
    expect(scanFile("src-tauri/src/x.rs", "let p = st.mirror.cold_paint();")).toHaveLength(1);
    expect(scanFile("src-tauri/src/x.rs", "let b = st.mirror.rehydrate();")).toHaveLength(1);
    expect(scanFile("src/a.ts", "if (data.altActive) {}")).toHaveLength(1);
  });

  it("코어 화면 복원 신호는 snake·camel·was 접두 모두 잡는다", () => {
    expect(scanFile("src-tauri/src/pty.rs", "pub screen_restored: bool,")).toHaveLength(1);
    expect(scanFile("src/a.ts", "screenRestored: boolean;")).toHaveLength(1);
    expect(scanFile("src/a.ts", "return pty.wasScreenRestored(id);")).toHaveLength(1);
  });

  it("checkpoint 도메인 어휘는 잡되, 무관 배관(wal_checkpoint)은 잡지 않는다", () => {
    expect(scanFile("src-tauri/src/x.rs", 'let notice = "sealed checkpoint";')).toHaveLength(1);
    // SQLite WAL checkpoint 는 언더스코어 경계라 \bcheckpoint\b 밖 — 방출 대상 아님.
    expect(scanFile("src-tauri/src/data/backup.rs", 'conn.execute("PRAGMA wal_checkpoint(TRUNCATE);");')).toEqual([]);
    // checkpoint_path 같은 식별자도 언더스코어 경계라 bare checkpoint 매칭 밖(개명은 별도 강제 아님).
    expect(scanFile("src-tauri/src/x.rs", "let p = proto::checkpoint_path(h, w, pane);")).toEqual([]);
  });

  it("PTY 배관은 정본 파일에서 allowlist 다(방출 아님 — 결정 1)", () => {
    expect(
      scanFile("src-tauri/crates/soksak-ptyd/src/main.rs", "let sys = native_pty_system();"),
    ).toEqual([]);
    expect(scanFile("src-tauri/src/pty.rs", ".openpty(PtySize { rows, cols })")).toEqual([]);
    // 같은 배관 토큰이라도 정본 밖 파일이면 유입으로 잡힌다(사면은 파일 한정).
    expect(scanFile("src-tauri/src/other.rs", "let sys = native_pty_system();")).toHaveLength(1);
  });

  it("테스트 코드(.test·Rust tests/·#[cfg(test)])는 스캔하지 않는다", () => {
    expect(scanFile("src/a.test.ts", "if (data.altActive) {}")).toEqual([]);
    // Rust 통합 테스트(tests/ 하위) — 봉투에 altActive '없음' 단언 같은 정당한 참조 보호.
    expect(
      scanFile("src-tauri/crates/soksak-ptyd/tests/daemon.rs", 'assert!(doc.get("altActive").is_none());'),
    ).toEqual([]);
    const rs = [
      "pub fn run() {}",
      "#[cfg(test)]",
      "mod tests {",
      "    fn t() { let b = m.rehydrate(); }",
      "}",
    ].join("\n");
    expect(scanFile("src-tauri/src/x.rs", rs)).toEqual([]);
  });

  it("generic 문구(무관 식별자)는 잡지 않는다", () => {
    expect(scanFile("src/a.ts", "const defaultActiveTab = 0;")).toEqual([]);
    expect(scanFile("src/a.ts", "// 라이브 스트림을 화면에 그린다")).toEqual([]);
  });
});

describe("게이트 실행 — 신규 유입·봉인 대조", () => {
  it("봉인에 없는 파일의 해석기 유입은 실패한다", () => {
    write("src-tauri/src/pty.rs", "pub struct SpawnOutcome { pub screen_restored: bool }");
    const { status, out } = runGate();
    expect(status).toBe(1);
    expect(out).toContain("pty.rs");
    expect(out).toContain("신규 해석기 유입");
  });

  it("정본 밖 PTY 배관 유입은 실패한다(사면은 파일 한정)", () => {
    write("src-tauri/src/rogue.rs", "let sys = native_pty_system();");
    const { status, out } = runGate();
    expect(status).toBe(1);
    expect(out).toContain("rogue.rs");
  });

  it("깨끗한 코어(배관은 정본 파일에만)는 통과한다", () => {
    write("src-tauri/crates/soksak-ptyd/src/main.rs", "let sys = native_pty_system();");
    write("src-tauri/src/pty.rs", "let pair = sys.openpty(size);");
    write("src/plugins/api.ts", "export const spawn = () => invoke('spawn_terminal');");
    const { status, out } = runGate();
    expect(status).toBe(0);
    expect(out).toContain("PASS");
  });

  // 축소(stale) 메커니즘은 방출이 끝나 SEALED 가 공표(空表)여도 살아 있어야 한다(재입법 시
  // 재가동). 실측 SEALED 와 무관하게, 주입 봉인으로 축소 판정 로직을 직접 검증한다.
  it("봉인 미달(방출 진행)은 stale 로 잡힌다 — SEALED 축소 의무", () => {
    write("src-tauri/src/pty.rs", "pub screen_restored: bool,"); // 실측 1건
    const { stale } = scanRoot(root, new Map([["src-tauri/src/pty.rs", 4]])); // 봉인 4건 대비
    expect(stale).toEqual([{ file: "src-tauri/src/pty.rs", count: 1, sealed: 4 }]);
  });

  it("빈 트리는 봉인 전부가 stale 다 — 봉인은 실측과 일치해야만 산다", () => {
    const { stale } = scanRoot(root, new Map([["src-tauri/src/pty.rs", 3]]));
    expect(stale).toEqual([{ file: "src-tauri/src/pty.rs", count: 0, sealed: 3 }]);
  });
});

describe("이 repo 실측 — 방출 완료(SEALED 공표)", () => {
  it("코어에 터미널 해석기 어휘 0 — 유입 0·stale 0·PTY 배관 allowlist 사용 중", () => {
    const { added, stale, staleAllowlist, perFile } = scanRoot(REPO_ROOT);
    expect(added).toEqual([]);
    expect(stale).toEqual([]);
    // ptyd·pty.rs 의 PTY 배관 allowlist 가 실제 매칭 중이다(stale 예외 0).
    expect(staleAllowlist).toEqual([]);
    // 봉인은 공표(空表)이고 실측도 0 — 코어에 해석기 어휘가 남지 않았다.
    expect([...perFile.keys()]).toEqual([]);
    expect(SEALED.size).toBe(0);
  });
});
