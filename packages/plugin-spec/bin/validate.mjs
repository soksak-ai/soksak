#!/usr/bin/env node
// 헤드리스 매니페스트 검증 게이트 — 앱(소켓) 없이 plugin.json 을 검증한다.
//
// 왜 독립 스크립트인가(검증된 제약):
//   - sok CLI 는 실행 중 앱의 Unix 소켓에 붙는 transport(src-tauri/cli) — 앱 없으면 동작 0.
//     CI/pre-commit/발행 훅은 앱이 없으므로 sok 으로는 게이트할 수 없다.
//   - spec.ts §0 P5: 코어는 플러그인을 나열·검사하지 않는다. 검증은 dev-kit(이 스크립트)·각 repo 몫.
//   - 유일한 헤드리스 경로 = parseManifest 직접 import. spec.ts 는 순수 TS(enum/namespace 0,
//     외부 import 0)라 node strip-types(v23.6+)로 의존성 없이 로드된다.
//   이것이 vsce(editor)·검증 봇(notes-app)의 soksak 등가다.
//
// 사용: npx soksak-validate <plugin.json>...  (코어에선 node packages/plugin-spec/bin/validate.mjs)
// 종료코드: 0 = 전부 통과, 1 = 하나라도 위반, 2 = 사용법 오류.

import { readFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { parseManifest } from "../src/spec.ts";

const paths = process.argv.slice(2);
if (paths.length === 0) {
  console.error("사용: node scripts/spec/validate-manifest.mjs <plugin.json>...");
  process.exit(2);
}

let failed = 0;
for (const p of paths) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(p, "utf8"));
  } catch (e) {
    console.error(`✗ ${p}: JSON 파싱 실패 — ${e.message}`);
    failed++;
    continue;
  }
  // dirName = 플러그인 디렉터리명(단일폴더 모델: ~/.soksak/plugins/<id>). parseManifest 가 id 검증 등에 사용.
  const dirName = basename(dirname(p));
  const { validation } = parseManifest(raw, dirName);
  if (validation.ok) {
    console.log(`✓ ${p}`);
    for (const w of validation.warnings ?? []) console.log(`  ⚠ ${w}`);
  } else {
    console.error(`✗ ${p}`);
    for (const err of validation.errors) console.error(`  - ${err}`);
    failed++;
  }
}

process.exit(failed > 0 ? 1 : 0);
