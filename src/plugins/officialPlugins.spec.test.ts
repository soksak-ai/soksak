// 공식 플러그인 15종의 기계 검증 — 매니페스트가 실제 parseManifest 를 통과하고
// main.js 가 스펙의 "단일 번들·import 금지" 규율을 지키는지 레포 차원에서 고정.
// (런타임 동작은 E2E 수동 검증 항목 — 여기는 스펙 위반의 회귀 방지선.)
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseManifest } from "./spec";

const PLUGINS_DIR = join(process.cwd(), "plugins");
const EXPECTED = [
  "soksak-agent-claude",
  "soksak-agent-codex",
  "soksak-bookmarks",
  "soksak-browser",
  "soksak-code-highlight",
  "soksak-formatter",
  "soksak-git-diff",
  "soksak-git-history",
  "soksak-git-init",
  "soksak-icons-codicons",
  "soksak-icons-tabler",
  "soksak-memo",
  "soksak-plugin-skeleton",
  "soksak-shark",
  "soksak-terminal",
];

describe("공식 플러그인 — 스펙 준수", () => {
  it("15종 전부 존재", () => {
    const dirs = readdirSync(PLUGINS_DIR, { withFileTypes: true })
      // 숨김 디렉토리(.repos — make plugin-repos 산출물)는 소스가 아니다.
      .filter((d) => d.isDirectory() && !d.name.startsWith("."))
      .map((d) => d.name)
      .sort();
    expect(dirs).toEqual(EXPECTED);
  });

  it.each(EXPECTED)("%s: plugin.json 이 parseManifest 통과(거부 사유 0)", (id) => {
    const raw = JSON.parse(
      readFileSync(join(PLUGINS_DIR, id, "plugin.json"), "utf8"),
    );
    const { manifest, validation } = parseManifest(raw, id);
    expect(validation.errors).toEqual([]);
    expect(manifest?.id).toBe(id);
  });

  it.each(EXPECTED)("%s: main.js 는 import 없는 단일 ESM + README 존재", (id) => {
    const main = readFileSync(join(PLUGINS_DIR, id, "main.js"), "utf8");
    // blob import 는 상대/bare import 를 해석 못 한다(스펙 배포 모델) — 정적 import 금지.
    expect(main).not.toMatch(/^\s*import\s/m);
    expect(main).toMatch(/export\s+default/);
    expect(existsSync(join(PLUGINS_DIR, id, "README.md"))).toBe(true);
  });
});
