#!/usr/bin/env node
// 배포 불변식 게이트 — 환경 identity, regular-file 패키징, public app release 경계를
// 사람이 기억하는 규칙이 아니라 repo 상태로 강제한다. 임시 보정 스크립트가 아니라
// make gates/CI가 매번 실행하는 blocking validator다.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = resolve(fileURLToPath(new URL(".", import.meta.url)));
export const REPO_ROOT = resolve(HERE, "../..");

function read(root, rel) {
  try {
    return readFileSync(resolve(root, rel), "utf8");
  } catch {
    return "";
  }
}

function json(root, rel, violations) {
  const raw = read(root, rel);
  if (!raw) {
    violations.push(`${rel}: 필수 파일 없음`);
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    violations.push(`${rel}: JSON 파싱 실패(${error.message})`);
    return {};
  }
}

function updaterEnabled(config) {
  return Boolean(config?.plugins?.updater) || config?.bundle?.createUpdaterArtifacts === true;
}

export function scanRoot(root = REPO_ROOT) {
  const violations = [];
  const makefile = read(root, "Makefile");
  const base = json(root, "src-tauri/tauri.conf.json", violations);
  const debug = json(root, "src-tauri/tauri.debug.conf.json", violations);
  const release = read(root, "src-tauri/tauri.release.conf.json");
  const releaseWorkflow = read(root, ".github/workflows/release.yml");
  const releaseTool = read(root, "scripts/release/prepare-tauri-config.mjs");
  const appHome = read(root, "src-tauri/src/home.rs");
  const cliHome = read(root, "src-tauri/cli/src/lib.rs");
  const runtimeDep = read(root, "src-tauri/src/runtime_dep.rs");
  const releaseSurface = `${release}\n${releaseWorkflow}\n${releaseTool}`;

  if (/(^|\s)ln\s+-(?:[^\n]*s|s[^\n]*)/.test(makefile)) {
    violations.push("Makefile: symlink CLI 설치 금지(regular file 원자 설치 필요)");
  }
  if (/tar[^\n]*(?:\s-[A-Za-z]*L[A-Za-z]*\b|--dereference\b)/.test(makefile)) {
    violations.push("Makefile: tar symlink dereference(-L/--dereference) 금지");
  }
  if (updaterEnabled(base)) {
    violations.push("src-tauri/tauri.conf.json: dev identity updater 금지");
  }
  if (updaterEnabled(debug)) {
    violations.push("src-tauri/tauri.debug.conf.json: debug identity updater 금지");
  }
  if (releaseSurface.includes("soksak-ai/soksak/releases")) {
    violations.push("release: private core 저장소 updater/asset URL 금지");
  }
  if (!releaseSurface.includes("soksak-ai/soksak-app/releases")) {
    violations.push("release: public soksak-app asset URL 필수");
  }
  if (releaseSurface.includes("UPDATER_PUBKEY_PLACEHOLDER")) {
    violations.push("release: updater 공개키 placeholder 금지");
  }
  if (!releaseTool.includes("TAURI_UPDATER_PUBLIC_KEY")) {
    violations.push("release: TAURI_UPDATER_PUBLIC_KEY 입력 검증 도구 필수");
  }
  if (/std::env::var\("SOKSAK_(?:TEST_)?HOME"\)/.test(`${appHome}\n${cliHome}`)) {
    violations.push("identity home: 앱/CLI runtime 환경변수 override 금지");
  }
  if (/Command::new\("(?:\/usr\/bin\/)?tar"\)/.test(runtimeDep) || /\.unpack\s*\(/.test(runtimeDep)) {
    violations.push("runtime archive: system/generic unpack 위임 금지(entry별 검증 필수)");
  }
  for (const [needle, label] of [
    ["entry_type.is_file()", "regular-file entry gate"],
    ["reject_symlink_components", "symlink/junction ancestor gate"],
    ["create_new(true)", "duplicate-safe file creation"],
  ]) {
    if (!runtimeDep.includes(needle)) {
      violations.push(`runtime archive: ${label} 필수`);
    }
  }

  return violations;
}

function main() {
  const arg = process.argv.indexOf("--root");
  const root = arg >= 0 ? resolve(process.argv[arg + 1]) : REPO_ROOT;
  const violations = scanRoot(root);
  if (violations.length) {
    console.error(`distribution-invariants: FAIL (${violations.length})`);
    for (const v of violations) console.error(`  - ${v}`);
    process.exit(1);
  }
  console.log("distribution-invariants: PASS");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
