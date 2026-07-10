// c2-transparency-scan 자가검사 — 게이트가 위반 픽스처에서 실제로 실패하는지(건전성),
// 판정 미러(c2StaticViolations)가 코어 단일진실(transparencyViolations)과 일치하는지,
// 디렉토리 순회·규칙별 집계·파싱 실패·exit code·plugins 디렉토리 해석을 단언한다.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { c2StaticViolations, scanPlugins, resolvePluginsDir } from "./c2-transparency-scan.mjs";
import { transparencyViolations } from "../../src/plugins/conformance.ts";

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

// ── 판정 미러가 코어 단일진실과 일치한다 ──────────────────────────────────────
describe("c2StaticViolations ≡ transparencyViolations(코어 단일진실)", () => {
  it("count 행렬 전수에서 두 함수의 규칙 목록이 같다", () => {
    for (const views of [0, 1])
      for (const programs of [0, 1])
        for (const fileViewers of [0, 1])
          for (const commands of [0, 1])
            for (const nodes of [0, 1]) {
              const counts = { views, programs, fileViewers, commands, nodes };
              expect(c2StaticViolations(counts).map((v) => v.rule)).toEqual(
                transparencyViolations(counts).map((v) => v.rule),
              );
            }
  });
});

// ── 규칙 판정 ────────────────────────────────────────────────────────────────
describe("c2StaticViolations — 규칙 판정", () => {
  it("파일 뷰어만 기여하고 command=0 → command-surface", () => {
    const v = c2StaticViolations({ views: 0, programs: 0, fileViewers: 4, commands: 0, nodes: 0 });
    expect(v.map((x) => x.rule)).toEqual(["command-surface"]);
  });
  it("views>0 ∧ nodes=0 → view-nodes", () => {
    const v = c2StaticViolations({ views: 1, programs: 0, fileViewers: 0, commands: 2, nodes: 0 });
    expect(v.map((x) => x.rule)).toEqual(["view-nodes"]);
  });
  it("세 표면 다 갖추면 위반 없음", () => {
    expect(
      c2StaticViolations({ views: 1, programs: 0, fileViewers: 0, commands: 1, nodes: 1 }),
    ).toEqual([]);
  });
});

// ── 디렉토리 순회·집계·exit code ─────────────────────────────────────────────
describe("scanPlugins — 설치본 순회 실측", () => {
  it("규칙별 위반 플러그인 목록을 집계한다", () => {
    // command-surface 위반: 파일 뷰어만 기여.
    writePlugin("soksak-plugin-viewer", { fileViewers: [{ id: "img", extensions: ["png"] }] }, ["ui"]);
    // view-nodes 위반: 콘텐츠 뷰 + command, nodes 없음.
    writePlugin("soksak-plugin-canvas", {
      views: [{ id: "c", title: "C", icon: "C", placements: ["content"] }],
      commands: [{ name: "open", title: "O" }],
    });
    // 위반 없음: 세 표면.
    writePlugin("soksak-plugin-clean", {
      views: [{ id: "c", title: "C", icon: "C" }],
      commands: [{ name: "open", title: "O" }],
      nodes: [{ id: "root" }],
    });
    const r = scanPlugins(root);
    expect(r.scanned).toBe(3);
    expect(r.perRule["command-surface"]).toEqual(["soksak-plugin-viewer"]);
    expect(r.perRule["view-nodes"]).toEqual(["soksak-plugin-canvas"]);
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

describe("게이트 exit code — 위반 0 실측", () => {
  it("위반 있으면 exit 1", () => {
    writePlugin("soksak-plugin-viewer", { fileViewers: [{ id: "img", extensions: ["png"] }] }, ["ui"]);
    const r = runGate(root);
    expect(r.status).toBe(1);
    expect(r.out).toContain("command-surface: 위반 1");
  });
  it("위반 0 이면 exit 0", () => {
    writePlugin("soksak-plugin-clean", {
      views: [{ id: "c", title: "C", icon: "C" }],
      commands: [{ name: "open", title: "O" }],
      nodes: [{ id: "root" }],
    });
    const r = runGate(root);
    expect(r.status).toBe(0);
    expect(r.out).toContain("PASS");
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
