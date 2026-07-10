#!/usr/bin/env node
// 헤드리스 매니페스트 검증 게이트 — 앱(소켓) 없이 plugin.json 을 검증한다.
//
// 왜 독립 스크립트인가(검증된 제약):
//   - sok CLI 는 실행 중 앱의 Unix 소켓에 붙는 transport(src-tauri/cli) — 앱 없으면 동작 0.
//     CI/pre-commit/발행 훅은 앱이 없으므로 sok 으로는 게이트할 수 없다.
//   - spec.ts §0 P5: 코어는 플러그인을 나열·검사하지 않는다. 검증은 dev-kit(이 스크립트)·각 repo 몫.
//   - 유일한 헤드리스 경로 = parseManifest 직접 import. 발행물은 빌드된 dist/spec.js(.d.ts 동봉)라
//     의존성 0·모든 node(>=18)에서 로드된다. spec.ts(소스)는 단일진실이고 dist 는 산출물.
//   이것이 vsce(editor)·검증 봇(notes-app)의 soksak 등가다.
//
// 사용: npx soksak-validate <plugin.json>...  (코어 회귀는 make spec-gate 가 빌드 후 실행)
// 종료코드: 0 = 전부 통과, 1 = 하나라도 위반, 2 = 사용법 오류.

import { readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  C2_STATIC_ENFORCEMENT,
  parseManifest,
  transparencyViolations,
} from "../dist/spec.js";

const USAGE = `사용: npx soksak-validate <플러그인 폴더 | plugin.json>...
  플러그인 폴더를 주면 그 안의 plugin.json 을 검증합니다.
  종료코드: 0 = 전부 통과, 1 = 위반 있음, 2 = 사용법 오류.`;

const args = process.argv.slice(2);
if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
  console.error(USAGE);
  process.exit(args.length === 0 ? 2 : 0);
}

// 저자는 폴더를 준다 — 폴더면 plugin.json 으로 해소한다(자기설명 표면).
const paths = args.map((p) => {
  try {
    if (statSync(p).isDirectory()) return join(p, "plugin.json");
  } catch {
    /* 존재하지 않으면 아래 읽기에서 안내된다 */
  }
  return p;
});

let failed = 0;
for (const p of paths) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(p, "utf8"));
  } catch (e) {
    console.error(`✗ ${p}: JSON 파싱 실패 — ${e.message}`);
    console.error(`  플러그인 폴더 또는 plugin.json 경로를 주십시오. (도움말: --help)`);
    failed++;
    continue;
  }
  // dirName = 플러그인 디렉터리명(단일폴더 모델: ~/.soksak/plugins/<id>). parseManifest 가 id 검증에 사용.
  // resolve 로 절대화 — pre-commit 의 `soksak-validate plugin.json`(상대) 도 repo 루트명을 dirName 으로 얻는다.
  const dirName = basename(dirname(resolve(p)));
  const { manifest, validation } = parseManifest(raw, dirName);
  if (!validation.ok) {
    console.error(`✗ ${p}`);
    for (const err of validation.errors) console.error(`  - ${err}`);
    failed++;
    continue;
  }
  // C2 정적 투명성 판정 — 문법과 별개 섹션(저자 경계). 판정·시행표의 단일진실은 패키지
  // (transparency.ts) — 앱 로더·설치본 게이트와 같은 표를 본다. blocking 규칙 위반 = 실패
  // (앱이 활성화를 거부할 매니페스트를 발행 전에 알린다), warn 규칙 위반 = 경고 + 통과(래칫).
  const c2 = transparencyViolations(manifest.contributes);
  const blocking = c2.filter((v) => C2_STATIC_ENFORCEMENT[v.rule] === "blocking");
  const warned = c2.filter((v) => C2_STATIC_ENFORCEMENT[v.rule] === "warn");
  if (blocking.length > 0) {
    console.error(`✗ ${p}`);
    console.error(`  C2 투명성 위반(blocking — 앱이 활성화를 거부한다):`);
    for (const v of blocking) console.error(`  - ${v.rule} — ${v.detail}`);
    for (const v of warned) console.error(`  ⚠ C2 ${v.rule}: ${v.detail}`);
    failed++;
    continue;
  }
  console.log(`✓ ${p}`);
  for (const w of validation.warnings ?? []) console.log(`  ⚠ ${w}`);
  for (const v of warned) console.log(`  ⚠ C2 ${v.rule}: ${v.detail}`);
}

process.exit(failed > 0 ? 1 : 0);
