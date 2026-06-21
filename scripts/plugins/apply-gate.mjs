#!/usr/bin/env node
// 플러그인 매니페스트 게이트 전파 — 단일진실(@soksak-ai/plugin-spec) 검증 게이트를 플러그인 repo 에 배선.
// 게이트 *정의*는 scripts/plugins/gate/(package.json.tmpl·pre-commit) 한 곳 — Rust scaffold(include_str!)도
// 같은 파일을 임베드한다. 여기는 그 정의를 대상 repo 에 적용할 뿐(정의 재구현 0):
//   - package.json: 있으면 scripts.validate/prepare + devDep 병합(기존 보존), 없으면 템플릿(id 치환).
//   - .githooks/pre-commit: 단일진실 hook 기록 + 실행권한.
//   - git config core.hooksPath .githooks — 이 repo 에서 즉시 활성(clone 후엔 prepare 가 재설정).
// 사용: node scripts/plugins/apply-gate.mjs <plugin-dir>...
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const GATE_DIR = join(dirname(fileURLToPath(import.meta.url)), "gate");
const TMPL = JSON.parse(readFileSync(join(GATE_DIR, "package.json.tmpl"), "utf8"));
const PRE_COMMIT = readFileSync(join(GATE_DIR, "pre-commit"), "utf8");

// 순수 — 기존 package.json(없으면 null) + id → 게이트 적용된 package.json 객체. 기존 키 보존, 게이트만 덮어씀.
export function gatePackageJson(existing, id) {
  if (!existing) return { ...TMPL, name: id };
  return {
    ...existing,
    scripts: { ...existing.scripts, ...TMPL.scripts },
    devDependencies: { ...existing.devDependencies, ...TMPL.devDependencies },
  };
}

export function applyGate(dir) {
  const id = basename(dir);
  const pkgPath = join(dir, "package.json");
  const existing = existsSync(pkgPath) ? JSON.parse(readFileSync(pkgPath, "utf8")) : null;
  writeFileSync(pkgPath, JSON.stringify(gatePackageJson(existing, id), null, 2) + "\n");

  const hooksDir = join(dir, ".githooks");
  mkdirSync(hooksDir, { recursive: true });
  const hookPath = join(hooksDir, "pre-commit");
  writeFileSync(hookPath, PRE_COMMIT);
  chmodSync(hookPath, 0o755);

  // 이 repo 에서 즉시 활성. git repo 가 아니면 조용히 스킵(파일은 이미 기록됨).
  try {
    execFileSync("git", ["-C", dir, "config", "core.hooksPath", ".githooks"], { stdio: "ignore" });
  } catch {
    /* not a git repo — prepare script will set hooksPath on first npm install */
  }
  return { id, pkgPath, hookPath, merged: existing !== null };
}

// CLI
const dirs = process.argv.slice(2);
if (dirs.length === 0) {
  console.error("사용: node scripts/plugins/apply-gate.mjs <plugin-dir>...");
  process.exit(2);
}
let failed = 0;
for (const d of dirs) {
  try {
    if (!existsSync(join(d, "plugin.json"))) {
      console.error(`- skip ${d}: plugin.json 없음(플러그인 dir 아님)`);
      continue;
    }
    const r = applyGate(d);
    console.log(`✓ ${r.id}: package.json(${r.merged ? "merged" : "created"}) + .githooks/pre-commit`);
  } catch (e) {
    console.error(`✗ ${d}: ${e.message}`);
    failed++;
  }
}
process.exit(failed > 0 ? 1 : 0);
