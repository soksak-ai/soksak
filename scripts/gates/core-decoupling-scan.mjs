// C1 결합 스캔 게이트 — 코어(src/·src-tauri/)에서 특정 플러그인 id 문자열을 차단한다.
// 법(C-법, docs/ARCHITECTURE.md 결합 법칙): 코어는 특정 플러그인과 강결합하지 않는다.
// 대상은 실행 경로 코드(핸들러·상수·분기)와 배포 문서(스킬 등 코어와 함께 출하되는 문서)다.
//
// 위반 = "soksak-plugin-" 뒤에 실제 id 문자([a-z0-9])가 이어지는 토큰.
//   위반이 아닌 것(패턴이 애초에 잡지 않는다):
//   - placeholder: soksak-plugin-<id> ("<" 는 id 문자가 아니다)
//   - 접두 문법 메커니즘: "soksak-plugin-" 리터럴, `soksak-plugin-${...}` 합성,
//     /^soksak-plugin-/ 류 정규식 소스 — 명명 문법 자체는 generic 이다.
//
// 구조 제외(스코프 규칙 — allowlist 아님):
//   - *.test.ts / *.test.tsx / *.test.mjs — 테스트 픽스처 영역, 실행 경로가 아니다.
//   - Rust 파일 말미의 최상위 #[cfg(test)] mod — 같은 이유. 코어 관례상 테스트 모듈은
//     파일 말미에만 둔다(현행 전 파일 실측). 말미가 아닌 위치의 테스트 모듈을 두지 마라.
//   - src-tauri/target, src-tauri/gen, node_modules, .git — 산출물·외부물.
//
// ALLOWLIST 는 아래 목록이 전부다. 추가는 C5 절차(명시 문제 제기 → 재입법 커밋)로만 한다.
// 무언 추가 금지. stale 항목(파일은 있는데 매칭 0건)은 실패다 — 죽은 예외를 남기지 마라.
//
// 사용: node scripts/gates/core-decoupling-scan.mjs [--root <dir>]
// exit 0 = 위반 0건, exit 1 = 위반 또는 stale allowlist. blocking 게이트다.
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, extname, basename } from "node:path";
import { fileURLToPath } from "node:url";

// 위반 후보 토큰: 접두 뒤에 실제 id 가 시작되는 경우만. 스펙 판 접미(@N)까지 토큰에 포함해
// allowlist 판정이 토큰 전체를 보게 한다.
const TOKEN = /soksak-plugin-[a-z0-9][a-z0-9-]*(?:@[0-9]+)?/g;

// 명시 allowlist — 파일+사유 쌍. token/line 정규식이 있으면 그 매칭에만 적용된다(파일 전체 아님).
export const ALLOWLIST = [
  {
    file: "src/state/registry.ts",
    line: /soksak-ai\/soksak-plugin-registry\/main\/registry\.json/,
    reason:
      "레지스트리 repo URL 상수 — 플러그인 카탈로그의 단일 발견 지점. 코어가 아는 유일한 외부 좌표다.",
  },
  {
    file: "src/plugins/registrySnapshot.json",
    reason:
      "레지스트리 카탈로그 빌드 스냅샷 — 발견 지점 데이터의 오프라인 시드(첫 실행·오프라인 폴백). 실행 분기가 아니라 카탈로그 데이터다.",
  },
  {
    file: "*",
    token: /^soksak-plugin-spec(?:@[0-9]+)?$/,
    reason:
      "스펙 패키지명 — 계약 이름이지 플러그인 id 가 아니다. 매니페스트 spec 선언(scaffold·contract.json)과 주석이 이 이름을 문법상 요구한다.",
  },
];

const SCAN_ROOTS = ["src", "src-tauri"];
const SKIP_DIRS = new Set(["target", "gen", "node_modules", ".git"]);
const SCAN_EXTS = new Set([
  ".ts", ".tsx", ".js", ".mjs", ".cjs", ".rs", ".toml", ".json", ".md", ".html", ".css",
]);
const TEST_FILE = /\.test\.(ts|tsx|mjs)$/;

// Rust 말미 테스트 모듈 절단 — 최상위(#열0) #[cfg(test)] 직후 mod 가 오면 그 이후는 픽스처 영역.
export function stripRustTestModule(content) {
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!/^#\[cfg\(test\)\]\s*$/.test(lines[i])) continue;
    let j = i + 1;
    while (j < lines.length && lines[j].trim() === "") j++;
    if (j < lines.length && /^(pub\s+)?mod\b/.test(lines[j])) {
      return lines.slice(0, i).join("\n");
    }
  }
  return content;
}

function allowMatch(entry, relPath, token, lineText) {
  if (entry.file !== "*" && entry.file !== relPath) return false;
  if (entry.token && !entry.token.test(token)) return false;
  if (entry.line && !entry.line.test(lineText)) return false;
  return true;
}

// 한 파일 스캔 — 위반 목록과 allowlist 사용 횟수를 돌려준다. 순수 함수(테스트 짝이 직접 부른다).
export function scanFile(relPath, content, allowUse) {
  const violations = [];
  if (TEST_FILE.test(relPath)) return violations;
  const text = relPath.endsWith(".rs") ? stripRustTestModule(content) : content;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    for (const m of lines[i].matchAll(TOKEN)) {
      const token = m[0];
      const hit = ALLOWLIST.findIndex((e) => allowMatch(e, relPath, token, lines[i]));
      if (hit >= 0) {
        if (allowUse) allowUse[hit] = (allowUse[hit] ?? 0) + 1;
        continue;
      }
      violations.push({ file: relPath, line: i + 1, token, text: lines[i].trim() });
    }
  }
  return violations;
}

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(name)) continue;
      yield* walk(p);
    } else if (SCAN_EXTS.has(extname(name))) {
      yield p;
    }
  }
}

// 루트 전체 스캔 — { violations, staleAllowlist } 를 돌려준다.
export function scanRoot(rootDir) {
  const violations = [];
  const allowUse = {};
  for (const scanRootName of SCAN_ROOTS) {
    const dir = join(rootDir, scanRootName);
    if (!existsSync(dir)) continue;
    for (const p of walk(dir)) {
      const rel = relative(rootDir, p);
      violations.push(...scanFile(rel, readFileSync(p, "utf8"), allowUse));
    }
  }
  // stale 검출 — 파일 지정 항목만: 그 파일이 실존하는데 매칭 0건이면 죽은 예외다.
  const staleAllowlist = ALLOWLIST.filter(
    (e, i) => e.file !== "*" && existsSync(join(rootDir, e.file)) && !(allowUse[i] > 0),
  ).map((e) => e.file);
  return { violations, staleAllowlist };
}

function main() {
  const args = process.argv.slice(2);
  const rootIdx = args.indexOf("--root");
  const root =
    rootIdx >= 0 ? args[rootIdx + 1] : join(fileURLToPath(import.meta.url), "..", "..", "..");
  const { violations, staleAllowlist } = scanRoot(root);
  console.log(`C1 결합 스캔 — 대상 ${SCAN_ROOTS.join("·")} (root: ${root})`);
  if (violations.length) {
    console.log(`\n위반 ${violations.length}건:`);
    for (const v of violations) console.log(`  ✗ ${v.file}:${v.line} ${v.token} — ${v.text}`);
    console.log(
      "\n코어는 특정 플러그인 id 와 결합할 수 없다. placeholder(soksak-plugin-<id>)로 교체하라." +
        " 기능이 실 id 에 의존하면 C5 재입법 커밋으로만 allowlist 에 등재한다.",
    );
  }
  if (staleAllowlist.length) {
    console.log(`\nstale allowlist ${staleAllowlist.length}건 — 매칭 0건 예외는 제거하라:`);
    for (const f of staleAllowlist) console.log(`  ✗ ${f}`);
  }
  if (violations.length || staleAllowlist.length) process.exit(1);
  console.log("\nPASS: C1 위반 0건");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
