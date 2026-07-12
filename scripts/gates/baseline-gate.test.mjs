// @vitest-environment node
// baseline-gate 자가검사 — 게이트를 실프로세스로 픽스처 루트에 대고 실행해
// 신규=실패 / stale=실패 / --prune 축소만 / --init 1회 / SELF 제외를 경로별로 단언한다.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const GATE = join(dirname(fileURLToPath(import.meta.url)), "baseline-gate.mjs");
const LENGTH_LIMIT = 1500; // 게이트의 상한과 같은 값 — 픽스처가 이 법에 대고 검증한다.

let root;

function runGate(...args) {
  const r = spawnSync(process.execPath, [GATE, "--root", root, ...args], { encoding: "utf8" });
  return { status: r.status, out: `${r.stdout}\n${r.stderr}` };
}

function write(rel, content) {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}

// n건의 .unwrap( 을 가진 러스트 픽스처.
function rustWithUnwraps(n) {
  return `fn main() {\n${"    x.unwrap();\n".repeat(n)}}\n`;
}

function longFile(lines) {
  return "const x = 1;\n".repeat(lines);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "baseline-gate-"));
  write("src-tauri/src/a.rs", rustWithUnwraps(2));
  write("src/big.ts", longFile(LENGTH_LIMIT + 1));
  write("src/ok.ts", "export const ok = true;\n");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("baseline-gate", () => {
  it("기준선 부재면 실패한다", () => {
    const r = runGate();
    expect(r.status).toBe(1);
    expect(r.out).toContain("기준선 부재");
  });

  it("--init 이 기준선을 봉인하고 이후 실행이 통과한다", () => {
    expect(runGate("--init").status).toBe(0);
    expect(existsSync(join(root, "scripts/gates/baseline-unwrap.txt"))).toBe(true);
    expect(existsSync(join(root, "scripts/gates/baseline-file-length.txt"))).toBe(true);
    expect(readFileSync(join(root, "scripts/gates/baseline-unwrap.txt"), "utf8")).toContain("src-tauri/src/a.rs 2");
    expect(readFileSync(join(root, "scripts/gates/baseline-file-length.txt"), "utf8")).toContain(
      `src/big.ts ${LENGTH_LIMIT + 1}`,
    );
    expect(runGate().status).toBe(0);
  });

  it("--init 은 기준선이 이미 있으면 거부한다", () => {
    expect(runGate("--init").status).toBe(0);
    const r = runGate("--init");
    expect(r.status).toBe(1);
    expect(r.out).toContain("--init 거부");
  });

  it("신규 위반 파일이 생기면 실패한다", () => {
    expect(runGate("--init").status).toBe(0);
    write("src-tauri/src/b.rs", rustWithUnwraps(1));
    const r = runGate();
    expect(r.status).toBe(1);
    expect(r.out).toContain("신규 위반 unwrap: src-tauri/src/b.rs");
  });

  it("봉인 값을 초과하면 실패한다", () => {
    expect(runGate("--init").status).toBe(0);
    write("src-tauri/src/a.rs", rustWithUnwraps(3));
    const r = runGate();
    expect(r.status).toBe(1);
    expect(r.out).toContain("신규 위반 unwrap: src-tauri/src/a.rs");
  });

  it("unwrap 은 배포 코드만 계수한다 — 인라인 #[cfg(test)] 모듈 unwrap 은 제외(테스트 idiom)", () => {
    // 배포 2건 + 테스트 모듈 3건 = 전문 5건이지만, unwrap 봉인은 배포 2건만 본다.
    const shipTwoTestThree =
      "fn ship() { x.unwrap(); y.unwrap(); }\n#[cfg(test)]\nmod tests {\n    fn t() { a.unwrap(); b.unwrap(); c.unwrap(); }\n}\n";
    write("src-tauri/src/a.rs", shipTwoTestThree);
    expect(runGate("--init").status).toBe(0);
    expect(readFileSync(join(root, "scripts/gates/baseline-unwrap.txt"), "utf8")).toContain(
      "src-tauri/src/a.rs 2",
    );
    expect(runGate().status).toBe(0);
    // 테스트 모듈 unwrap 을 더 넣어도 위반이 아니다(계수 밖).
    write(
      "src-tauri/src/a.rs",
      "fn ship() { x.unwrap(); y.unwrap(); }\n#[cfg(test)]\nmod tests {\n    fn t() { a.unwrap(); b.unwrap(); c.unwrap(); d.unwrap(); e.unwrap(); }\n}\n",
    );
    expect(runGate().status).toBe(0);
    // 배포 코드 unwrap 이 늘면 여전히 잡힌다 — 신호는 살아 있다.
    write("src-tauri/src/a.rs", "fn ship() { x.unwrap(); y.unwrap(); z.unwrap(); }\n");
    const r = runGate();
    expect(r.status).toBe(1);
    expect(r.out).toContain("신규 위반 unwrap: src-tauri/src/a.rs");
  });

  it("상한 초과 파일이 새로 생기면 실패한다", () => {
    expect(runGate("--init").status).toBe(0);
    write("src/huge.ts", longFile(LENGTH_LIMIT + 1));
    const r = runGate();
    expect(r.status).toBe(1);
    expect(r.out).toContain("신규 위반 file-length: src/huge.ts");
  });

  it("stale 봉인은 실패하고 --prune 만이 축소를 반영한다", () => {
    expect(runGate("--init").status).toBe(0);
    write("src-tauri/src/a.rs", rustWithUnwraps(1));
    const r = runGate();
    expect(r.status).toBe(1);
    expect(r.out).toContain("stale 봉인 unwrap: src-tauri/src/a.rs");
    // stale 실패는 기준선을 바꾸지 않는다 — 자동 축소 금지.
    expect(readFileSync(join(root, "scripts/gates/baseline-unwrap.txt"), "utf8")).toContain("src-tauri/src/a.rs 2");
    expect(runGate("--prune").status).toBe(0);
    expect(readFileSync(join(root, "scripts/gates/baseline-unwrap.txt"), "utf8")).toContain("src-tauri/src/a.rs 1");
    expect(runGate().status).toBe(0);
  });

  it("위반이 소멸하면 --prune 이 항목을 삭제한다", () => {
    expect(runGate("--init").status).toBe(0);
    write("src-tauri/src/a.rs", rustWithUnwraps(0));
    write("src/big.ts", longFile(10));
    expect(runGate().status).toBe(1);
    expect(runGate("--prune").status).toBe(0);
    expect(readFileSync(join(root, "scripts/gates/baseline-unwrap.txt"), "utf8")).not.toContain("src-tauri/src/a.rs");
    expect(readFileSync(join(root, "scripts/gates/baseline-file-length.txt"), "utf8")).not.toContain("src/big.ts");
    expect(runGate().status).toBe(0);
  });

  it("--prune 은 신규 위반을 지우지 못한다", () => {
    expect(runGate("--init").status).toBe(0);
    write("src-tauri/src/b.rs", rustWithUnwraps(1));
    const r = runGate("--prune");
    expect(r.status).toBe(1);
    expect(r.out).toContain("신규 위반 unwrap: src-tauri/src/b.rs");
    // prune 이 신규 위반을 기준선에 추가하지 않는다.
    expect(readFileSync(join(root, "scripts/gates/baseline-unwrap.txt"), "utf8")).not.toContain("src-tauri/src/b.rs");
  });

  it("SELF 제외 — scripts/gates 아래는 스캔하지 않는다", () => {
    expect(runGate("--init").status).toBe(0);
    write("scripts/gates/bait.mjs", longFile(LENGTH_LIMIT + 100));
    expect(runGate().status).toBe(0);
  });

  it("테스트 파일은 스캔하지 않는다", () => {
    expect(runGate("--init").status).toBe(0);
    write("src/huge.test.ts", longFile(LENGTH_LIMIT + 100));
    write("src-tauri/src/b_test.rs", rustWithUnwraps(5));
    expect(runGate().status).toBe(0);
  });

  it("--init 과 --prune 동시 지정은 거부한다", () => {
    expect(runGate("--init", "--prune").status).toBe(1);
  });
});
