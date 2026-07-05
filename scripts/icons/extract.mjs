#!/usr/bin/env node
// 아이콘 셋 추출기 — devDependencies 의 3개 오픈소스 셋에서 "시맨틱 아이콘
// 인벤토리"에 해당하는 SVG 만 뽑아 생성한다(멱등 — 재실행 시 동일 출력):
//   ① 내장 폴백  src/ui/icons/sets/lucide.ts            (ISC)
//   ② 플러그인   examples/plugins/soksak-plugin-icons-tabler/icons.json   (MIT)
//   ③ 플러그인   examples/plugins/soksak-plugin-icons-codicons/icons.json (CC-BY-4.0)
// 이 파일의 MAPPING 이 시맨틱 이름 ↔ 셋별 아이콘 id 의 단일 진실이다.
// 실행: pnpm icons:extract  (생성물은 체크인 — 런타임 의존성 0)

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// f: 렌더 모드 — "stroke"(선, lucide/tabler outline), "fill"(면, codicons 등),
//    "both"(선+면 채움 — filled 변형이 없는 셋의 star-filled/dirty 용)
const MAPPING = {
  close: { lucide: "x", tabler: "outline/x", codicons: "close" },
  add: { lucide: "plus", tabler: "outline/plus", codicons: "add" },
  minus: { lucide: "minus", tabler: "outline/minus", codicons: "remove" },
  refresh: { lucide: "refresh-cw", tabler: "outline/refresh", codicons: "refresh" },
  settings: { lucide: "settings", tabler: "outline/settings", codicons: "gear" },
  sun: { lucide: "sun", tabler: "outline/sun", codicons: "lightbulb" },
  moon: { lucide: "moon", tabler: "outline/moon", codicons: "color-mode" },
  "panel-left": {
    lucide: "panel-left",
    tabler: "outline/layout-sidebar",
    codicons: "layout-sidebar-left",
  },
  "panel-right": {
    lucide: "panel-right",
    tabler: "outline/layout-sidebar-right",
    codicons: "layout-sidebar-right",
  },
  star: { lucide: "star", tabler: "outline/star", codicons: "star-empty" },
  "star-filled": {
    lucide: "star",
    lucideMode: "both",
    tabler: "filled/star",
    tablerMode: "fill",
    codicons: "star-full",
  },
  pin: { lucide: "pin", tabler: "outline/pin", codicons: "pin" },
  "pin-filled": {
    lucide: "pin",
    lucideMode: "both",
    tabler: "filled/pin",
    tablerMode: "fill",
    codicons: "pinned",
  },
  menu: { lucide: "menu", tabler: "outline/menu-2", codicons: "menu" },
  "arrow-left": { lucide: "arrow-left", tabler: "outline/arrow-left", codicons: "arrow-left" },
  "arrow-right": { lucide: "arrow-right", tabler: "outline/arrow-right", codicons: "arrow-right" },
  "arrow-up": { lucide: "arrow-up", tabler: "outline/arrow-up", codicons: "arrow-up" },
  "arrow-down": { lucide: "arrow-down", tabler: "outline/arrow-down", codicons: "arrow-down" },
  "arrow-up-right": {
    lucide: "arrow-up-right",
    tabler: "outline/arrow-up-right",
    codicons: "link-external",
  },
  terminal: { lucide: "terminal", tabler: "outline/terminal-2", codicons: "terminal" },
  file: { lucide: "file-text", tabler: "outline/file-text", codicons: "file" },
  browser: { lucide: "globe", tabler: "outline/world", codicons: "globe" },
  plugin: { lucide: "puzzle", tabler: "outline/puzzle", codicons: "extensions" },
  dirty: {
    lucide: "circle",
    lucideMode: "both",
    tabler: "filled/circle",
    tablerMode: "fill",
    codicons: "circle-filled",
  },
  split: { lucide: "columns-2", tabler: "outline/columns", codicons: "split-horizontal" },
  grip: { lucide: "grip-vertical", tabler: "outline/grip-vertical", codicons: "gripper" },
  "chevron-right": {
    lucide: "chevron-right",
    tabler: "outline/chevron-right",
    codicons: "chevron-right",
  },
  none: { lucide: "ban", tabler: "outline/ban", codicons: "circle-slash" },
  folder: { lucide: "folder", tabler: "outline/folder", codicons: "folder" },
};

const SETS = {
  lucide: {
    dir: join(ROOT, "node_modules/lucide-static/icons"),
    defaultMode: "stroke",
    license:
      "Lucide (https://lucide.dev) — ISC License. Copyright (c) Lucide Contributors.",
  },
  tabler: {
    dir: join(ROOT, "node_modules/@tabler/icons/icons"),
    defaultMode: "stroke",
    license:
      "Tabler Icons (https://tabler.io/icons) — MIT License. Copyright (c) Paweł Kuna.",
  },
  codicons: {
    dir: join(ROOT, "node_modules/@vscode/codicons/src/icons"),
    defaultMode: "fill",
    license:
      "Codicons (https://github.com/microsoft/editor-codicons) — CC-BY-4.0. Copyright (c) Microsoft Corporation.",
  },
};

// SVG 파일 → { v: viewBox, b: 내부 마크업 }. 셋 패키지의 svg 루트 속성(stroke 등)은
// 렌더 모드(f)로 재현하므로 본문만 보존한다.
function parseSvg(path) {
  const raw = readFileSync(path, "utf8");
  const open = raw.match(/<svg\b[^>]*>/);
  if (!open) throw new Error(`svg 루트 없음: ${path}`);
  const viewBox = open[0].match(/viewBox="([^"]+)"/)?.[1];
  if (!viewBox) throw new Error(`viewBox 없음: ${path}`);
  const body = raw
    .slice(raw.indexOf(open[0]) + open[0].length, raw.lastIndexOf("</svg>"))
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return { v: viewBox, b: body };
}

function buildSet(setId) {
  const set = SETS[setId];
  const icons = {};
  for (const [name, m] of Object.entries(MAPPING)) {
    const file = m[setId];
    const mode = m[`${setId}Mode`] ?? set.defaultMode;
    const { v, b } = parseSvg(join(set.dir, `${file}.svg`));
    icons[name] = { v, b, f: mode };
  }
  return icons;
}

// ── ① 내장 lucide(TS) ──
{
  const icons = buildSet("lucide");
  const out = `// 자동 생성 — 수정 금지. 재생성: pnpm icons:extract (scripts/icons/extract.mjs)
// 출처/라이선스: ${SETS.lucide.license}
// 시맨틱 이름 ↔ 아이콘 매핑의 단일 진실은 scripts/icons/extract.mjs 의 MAPPING.
import type { IconSetData } from "../types";

export const LUCIDE_ICONS: IconSetData = ${JSON.stringify(icons, null, 2)};
`;
  const dest = join(ROOT, "src/ui/icons/sets/lucide.ts");
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, out);
  console.log(`생성: src/ui/icons/sets/lucide.ts (${Object.keys(icons).length} icons)`);
}

// ── ②③ 아이콘 셋 플러그인 main.js — 로더가 단일 번들을 요구하므로(상대 import
// 불가) 아이콘 데이터를 인라인해 진입점 전체를 생성한다. plugin.json 은 수동 관리.
const PLUGIN_TITLES = { tabler: "Tabler Icons", codicons: "Codicons" };
for (const setId of ["tabler", "codicons"]) {
  const icons = buildSet(setId);
  const out = `// 자동 생성 — 수정 금지. 재생성: pnpm icons:extract (scripts/icons/extract.mjs)
// 출처/라이선스: ${SETS[setId].license}
// soksak 아이콘 셋 플러그인 — activate 에서 셋을 등록하면 설정 > 아이콘 셋에 나타난다.

const ICONS = ${JSON.stringify(icons, null, 2)};

export default {
  activate(ctx) {
    ctx.subscriptions.push(ctx.app.ui.registerIconSet("${setId}", ICONS));
  },
  deactivate() {},
};
`;
  const dest = join(ROOT, `examples/plugins/soksak-icons-${setId}/main.js`);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, out);
  console.log(
    `생성: examples/plugins/soksak-icons-${setId}/main.js (${Object.keys(icons).length} icons, ${PLUGIN_TITLES[setId]})`,
  );
}
