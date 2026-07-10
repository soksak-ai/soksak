// c2-transparency-scan 자가검사 — 게이트가 위반 픽스처에서 실제로 실패하는지(건전성),
// warn 규칙(content-view-status)이 보고는 되되 게이트를 깨지 않는지(래칫),
// 디렉토리 순회·규칙별 집계·파싱 실패·exit code·plugins 디렉토리 해석을 단언한다.
// 판정 자체의 단위검증은 스펙 패키지(packages/plugin-spec/test/transparency.test.ts) 소유 —
// 게이트는 그 판정을 import 하는 소비자라 판정 미러도 미러-일치 핀도 없다(이중진실 폐기).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { blockingViolationCount, scanPlugins, resolvePluginsDir } from "./c2-transparency-scan.mjs";

const GATE = join(dirname(fileURLToPath(import.meta.url)), "c2-transparency-scan.mjs");

let root;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "c2-scan-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writePlugin(id, contributes, permissions = ["ui", "commands"]) {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "plugin.json"),
    JSON.stringify({
      spec: "soksak-plugin-spec@1",
      id,
      name: id,
      version: "1.0.0",
      description: "fixture",
      permissions,
      contributes,
    }),
  );
}

function runGate(pluginsDir) {
  const r = spawnSync(process.execPath, [GATE, "--plugins", pluginsDir], { encoding: "utf8" });
  return { status: r.status, out: `${r.stdout}\n${r.stderr}` };
}

// ── 디렉토리 순회·집계 ───────────────────────────────────────────────────────
describe("scanPlugins — 설치본 순회 실측", () => {
  it("규칙별 위반 플러그인 목록을 집계한다(정적 3종)", () => {
    // command-surface 위반: 파일 뷰어만 기여.
    writePlugin("soksak-plugin-viewer", { fileViewers: [{ id: "img", extensions: ["png"] }] }, ["ui"]);
    // view-nodes + content-view-status 위반: 콘텐츠 뷰(status 미선언) + command, nodes 없음.
    writePlugin("soksak-plugin-canvas", {
      views: [{ id: "c", title: "C", icon: "C", placements: ["content"] }],
      commands: [{ name: "open", title: "O" }],
    });
    // 위반 없음: 세 표면 + 콘텐츠 뷰 status 선언.
    writePlugin("soksak-plugin-clean", {
      views: [{ id: "c", title: "C", icon: "C", placements: ["content"], status: ["busy"] }],
      commands: [{ name: "open", title: "O" }],
      nodes: [{ id: "root" }],
    });
    const r = scanPlugins(root);
    expect(r.scanned).toBe(3);
    expect(r.perRule["command-surface"]).toEqual(["soksak-plugin-viewer"]);
    expect(r.perRule["view-nodes"]).toEqual(["soksak-plugin-canvas"]);
    expect(r.perRule["content-view-status"]).toEqual(["soksak-plugin-canvas"]);
    expect(r.parseErrors).toEqual([]);
  });

  it("매니페스트 파싱 실패는 parseErrors 로(무음 스킵 아님)", () => {
    const dir = join(root, "soksak-plugin-broken");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "plugin.json"), "{ not valid json");
    const r = scanPlugins(root);
    expect(r.parseErrors.map((e) => e.dir)).toEqual(["soksak-plugin-broken"]);
  });

  it("없는 디렉토리 → missing", () => {
    const r = scanPlugins(join(root, "nope"));
    expect(r.missing).toBe(true);
  });
});

// ── 시행 모드 — blocking 만 게이트를 깬다(warn = 래칫 측정치) ─────────────────
describe("게이트 exit code — blocking 위반 0 실측", () => {
  it("blocking 규칙 위반 있으면 exit 1", () => {
    writePlugin("soksak-plugin-viewer", { fileViewers: [{ id: "img", extensions: ["png"] }] }, ["ui"]);
    const r = runGate(root);
    expect(r.status).toBe(1);
    expect(r.out).toContain("command-surface(blocking): 위반 1");
  });

  it("warn 규칙(content-view-status)만 위반이면 보고하되 exit 0(래칫)", () => {
    writePlugin("soksak-plugin-status-gap", {
      views: [{ id: "c", title: "C", icon: "C", placements: ["content"] }],
      commands: [{ name: "open", title: "O" }],
      nodes: [{ id: "root" }],
    });
    const r = runGate(root);
    expect(r.status).toBe(0);
    expect(r.out).toContain("content-view-status(warn): 위반 1");
    expect(r.out).toContain("PASS");
  });

  it("위반 0 이면 exit 0", () => {
    writePlugin("soksak-plugin-clean", {
      views: [{ id: "c", title: "C", icon: "C", placements: ["content"], status: [] }],
      commands: [{ name: "open", title: "O" }],
      nodes: [{ id: "root" }],
    });
    const r = runGate(root);
    expect(r.status).toBe(0);
    expect(r.out).toContain("PASS");
  });

  it("blockingViolationCount — warn 규칙 카운트는 실패 조건에 안 들어간다", () => {
    expect(
      blockingViolationCount({
        "command-surface": [],
        "view-nodes": [],
        "content-view-status": ["a", "b"],
      }),
    ).toBe(0);
    expect(
      blockingViolationCount({
        "command-surface": ["a"],
        "view-nodes": ["b"],
        "content-view-status": ["c"],
      }),
    ).toBe(2);
  });
});

describe("resolvePluginsDir — 해석 우선순위", () => {
  const saved = { home: process.env.SOKSAK_HOME, env: process.env.SOKSAK_ENV };
  afterEach(() => {
    if (saved.home === undefined) delete process.env.SOKSAK_HOME;
    else process.env.SOKSAK_HOME = saved.home;
    if (saved.env === undefined) delete process.env.SOKSAK_ENV;
    else process.env.SOKSAK_ENV = saved.env;
  });
  it("--plugins 가 최우선", () => {
    process.env.SOKSAK_HOME = "/x";
    expect(resolvePluginsDir(["--plugins", "/y/plugins"])).toBe("/y/plugins");
  });
  it("SOKSAK_HOME → <home>/plugins", () => {
    delete process.env.SOKSAK_ENV;
    process.env.SOKSAK_HOME = "/h";
    expect(resolvePluginsDir([])).toBe(join("/h", "plugins"));
  });
  it("SOKSAK_ENV=debug → .soksak-debug/plugins", () => {
    delete process.env.SOKSAK_HOME;
    process.env.SOKSAK_ENV = "debug";
    expect(resolvePluginsDir([])).toContain(join(".soksak-debug", "plugins"));
  });
});
