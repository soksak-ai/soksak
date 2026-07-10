// @vitest-environment node
// core-decoupling-scan 자가검사 — 게이트가 위반 픽스처에서 실제로 실패하는지(건전성),
// placeholder·접두 문법·allowlist·테스트 픽스처 영역을 위반으로 오인하지 않는지,
// 그리고 이 repo 자체가 위반 0건인지를 단언한다.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { scanFile, scanRoot, stripRustTestModule } from "./core-decoupling-scan.mjs";

const GATE = join(dirname(fileURLToPath(import.meta.url)), "core-decoupling-scan.mjs");
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
  root = mkdtempSync(join(tmpdir(), "core-decoupling-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("scanFile — 위반 판정", () => {
  it("특정 플러그인 id 문자열은 위반이다", () => {
    const v = scanFile("src/a.ts", 'const x = "soksak-plugin-memo";');
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ file: "src/a.ts", line: 1, token: "soksak-plugin-memo" });
  });

  it("placeholder(soksak-plugin-<id>)는 위반이 아니다", () => {
    expect(scanFile("src/a.ts", 'examples: ["sok plugin.enable soksak-plugin-<id>"]')).toEqual([]);
  });

  it("접두 문법 메커니즘(리터럴·템플릿 합성·정규식 소스)은 위반이 아니다", () => {
    const code = [
      'raw.startsWith("soksak-plugin-")',
      "const c = `soksak-plugin-${raw}`;",
      'id.replace(/^soksak-plugin-/, "")',
      "/^plugin\\.(soksak-plugin-[a-z0-9-]+)\\.(.+)$/",
    ].join("\n");
    expect(scanFile("src/a.ts", code)).toEqual([]);
  });

  it("스펙 패키지명(soksak-plugin-spec@N)은 어디서든 allowlist 다", () => {
    expect(scanFile("src-tauri/src/x.rs", '"spec": "soksak-plugin-spec@1"')).toEqual([]);
    expect(scanFile("src/plugins/y.ts", "// soksak-plugin-spec v1 §0")).toEqual([]);
  });

  it("레지스트리 URL allowlist 는 그 파일·그 줄에만 적용된다", () => {
    const url = '"https://raw.githubusercontent.com/soksak-ai/soksak-plugin-registry/main/registry.json"';
    expect(scanFile("src/state/registry.ts", url)).toEqual([]);
    // 같은 URL 이라도 다른 파일이면 위반.
    expect(scanFile("src/other.ts", url)).toHaveLength(1);
    // allowlist 파일 안이라도 다른 id 는 위반.
    expect(scanFile("src/state/registry.ts", '"soksak-plugin-memo"')).toHaveLength(1);
  });

  it("테스트 파일은 픽스처 영역이라 스캔하지 않는다", () => {
    expect(scanFile("src/a.test.ts", '"soksak-plugin-memo"')).toEqual([]);
    expect(scanFile("src/b.test.tsx", '"soksak-plugin-memo"')).toEqual([]);
  });
});

describe("stripRustTestModule — 러스트 테스트 모듈 절단", () => {
  it("말미 최상위 #[cfg(test)] mod 이후는 스캔 대상이 아니다", () => {
    const rs = 'fn run() {}\n\n#[cfg(test)]\nmod tests {\n    const T: &str = "soksak-plugin-clip";\n}\n';
    expect(scanFile("src-tauri/src/a.rs", rs)).toEqual([]);
  });

  it("테스트 모듈 이전의 실행 경로 위반은 잡는다", () => {
    const rs = 'const OWNER: &str = "soksak-plugin-workflow";\n\n#[cfg(test)]\nmod tests {}\n';
    expect(scanFile("src-tauri/src/a.rs", rs)).toHaveLength(1);
  });

  it("들여쓴 #[cfg(test)] 아이템은 절단 지점이 아니다", () => {
    const rs = "impl A {\n    #[cfg(test)]\n    fn t(&self) {}\n}\nfn real() {}\n";
    expect(stripRustTestModule(rs)).toBe(rs);
  });
});

describe("게이트 실행 — blocking 형식", () => {
  it("위반 픽스처에서 exit 1 로 실패한다", () => {
    write("src/bad.ts", 'const id = "soksak-plugin-memo";');
    const r = runGate();
    expect(r.status).toBe(1);
    expect(r.out).toContain("soksak-plugin-memo");
    expect(r.out).toContain("src/bad.ts:1");
  });

  it("깨끗한 픽스처에서 exit 0 으로 통과한다", () => {
    write("src/ok.ts", 'const cands = raw.startsWith("soksak-plugin-") ? [raw] : [`soksak-plugin-${raw}`];');
    write("src-tauri/src/ok.rs", "fn main() {}");
    const r = runGate();
    expect(r.status).toBe(0);
    expect(r.out).toContain("PASS");
  });

  it("stale allowlist(파일은 있는데 매칭 0건)는 exit 1 이다", () => {
    write("src/state/registry.ts", "export const entries = [];");
    const r = runGate();
    expect(r.status).toBe(1);
    expect(r.out).toContain("stale allowlist");
  });
});

describe("이 repo 의 결합 상태", () => {
  it("코어(src·src-tauri)에 플러그인 id 위반이 0건이다", () => {
    const { violations, staleAllowlist } = scanRoot(REPO_ROOT);
    expect(violations).toEqual([]);
    expect(staleAllowlist).toEqual([]);
  });
});
