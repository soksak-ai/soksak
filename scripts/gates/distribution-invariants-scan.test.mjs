// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { REPO_ROOT, scanRoot } from "./distribution-invariants-scan.mjs";

let root;

function write(rel, body) {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

function configs() {
  write("src-tauri/tauri.conf.json", JSON.stringify({ identifier: "com.soksak.dev", bundle: {} }));
  write("src-tauri/tauri.debug.conf.json", JSON.stringify({ identifier: "com.soksak.debug", bundle: {} }));
  write("src-tauri/tauri.release.conf.json", JSON.stringify({ identifier: "com.soksak.app" }));
  write(".github/workflows/release.yml", "# https://github.com/soksak-ai/soksak-app/releases\n");
  write(
    "scripts/release/prepare-tauri-config.mjs",
    'const key = process.env.TAURI_UPDATER_PUBLIC_KEY; // soksak-ai/soksak-app/releases\n',
  );
  write("src-tauri/src/home.rs", "fn fixed_identity_home() {}\n");
  write("src-tauri/cli/src/lib.rs", "fn fixed_identity_home() {}\n");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "soksak-distribution-gate-"));
  configs();
  write("Makefile", "install-cli:\n\tinstall -m 0755 sok /usr/local/bin/sok\n");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("distribution invariants", () => {
  it("regular file 설치와 release-only updater는 통과한다", () => {
    expect(scanRoot(root)).toEqual([]);
  });

  it("symlink 설치와 tar dereference를 거부한다", () => {
    write("Makefile", "install-cli:\n\tln -sf ./sok /usr/local/bin/sok\narchive:\n\ttar -czLf out .\n");
    const violations = scanRoot(root).join("\n");
    expect(violations).toContain("symlink CLI 설치 금지");
    expect(violations).toContain("tar symlink dereference");
  });

  it("dev/debug updater와 private core release URL을 거부한다", () => {
    write(
      "src-tauri/tauri.conf.json",
      JSON.stringify({ plugins: { updater: { endpoints: ["x"] } }, bundle: { createUpdaterArtifacts: true } }),
    );
    write(".github/workflows/release.yml", "https://github.com/soksak-ai/soksak/releases/download/v1/a\n");
    const violations = scanRoot(root).join("\n");
    expect(violations).toContain("dev identity updater 금지");
    expect(violations).toContain("private core 저장소 updater/asset URL 금지");
  });

  it("debug/test 이름으로도 identity home runtime override를 허용하지 않는다", () => {
    write(
      "src-tauri/src/home.rs",
      'fn bad() { let _ = std::env::var("SOKSAK_TEST_HOME"); }\n',
    );
    expect(scanRoot(root)).toContain("identity home: 앱/CLI runtime 환경변수 override 금지");
  });

  it("이 저장소도 불변식을 만족한다", () => {
    expect(scanRoot(REPO_ROOT)).toEqual([]);
  });

  it("CLI installer는 regular file을 실제 regular file로 원자 설치한다", () => {
    const source = join(root, "build", "sok");
    const destination = join(root, "bin", "sok");
    write("build/sok", "binary-v1");
    mkdirSync(dirname(destination), { recursive: true });
    const result = spawnSync(
      "bash",
      [join(REPO_ROOT, "scripts/install/install-regular-file.sh"), source, destination],
      { encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
    const installed = spawnSync("test", ["-f", destination]);
    const link = spawnSync("test", ["-L", destination]);
    expect(installed.status).toBe(0);
    expect(link.status).not.toBe(0);
  });
});
