// 예제 플러그인 8종의 기계 검증 — 매니페스트가 실제 parseManifest 를 통과하고
// main.js 가 스펙의 "단일 번들·import 금지" 규율을 지키는지 레포 차원에서 고정.
// (런타임 동작은 E2E 수동 검증 항목 — 여기는 스펙 위반의 회귀 방지선.)
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseManifest } from "./spec";

const EXAMPLES_DIR = join(process.cwd(), "examples", "plugins");
const EXPECTED = [
  "soksak-bookmarks",
  "soksak-code-highlight",
  "soksak-formatter",
  "soksak-git-diff",
  "soksak-git-history",
  "soksak-icons-codicons",
  "soksak-icons-tabler",
  "soksak-memo",
];

describe("예제 플러그인 — 스펙 준수", () => {
  it("8종 전부 존재", () => {
    const dirs = readdirSync(EXAMPLES_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
    expect(dirs).toEqual(EXPECTED);
  });

  it.each(EXPECTED)("%s: plugin.json 이 parseManifest 통과(거부 사유 0)", (id) => {
    const raw = JSON.parse(
      readFileSync(join(EXAMPLES_DIR, id, "plugin.json"), "utf8"),
    );
    const { manifest, validation } = parseManifest(raw, id);
    expect(validation.errors).toEqual([]);
    expect(manifest?.id).toBe(id);
  });

  it.each(EXPECTED)("%s: main.js 는 import 없는 단일 ESM + README 존재", (id) => {
    const main = readFileSync(join(EXAMPLES_DIR, id, "main.js"), "utf8");
    // blob import 는 상대/bare import 를 해석 못 한다(스펙 배포 모델) — 정적 import 금지.
    expect(main).not.toMatch(/^\s*import\s/m);
    expect(main).toMatch(/export\s+default/);
    expect(existsSync(join(EXAMPLES_DIR, id, "README.md"))).toBe(true);
  });
});
