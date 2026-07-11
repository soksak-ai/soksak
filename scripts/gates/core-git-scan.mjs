// W8 git 방출 스캔 게이트 — 코어(src/·src-tauri/)의 git 기능 표면 잔존을 봉인하고 축소만 허용한다.
// 법(플랜 v2 §5.8 W8, 사용자 판결): git 은 코어 완전 방출 — 코어에 남는 것은 generic 뿐이다.
// 기존 코어 git 표면(git.rs·catalogGit.ts git.init/log/show/diff·explorer.git·fs.rs git_status·
// api.ts git capability)은 레거시다(선례 아님, R6). 이 게이트는 두 가지를 기계화한다:
//   ① 신규 git 유입 0 — 봉인에 없는 파일·봉인 수 초과는 즉시 실패(blocking).
//   ② 방출 진행 = 봉인 축소 — 잔존이 줄면 stale 로 실패하고, 같은 커밋에서 SEALED 를 내린다.
//      목표는 SEALED 공표(空表)다. 값을 올리는 유일한 길은 명시 재입법 커밋뿐이다(C5).
//
// 위반 패턴(코어의 git 기능 지식):
//   - Rust git 서브프로세스 스폰: Command::new("git")
//   - git 기능 커맨드 식별자: git_status/git_log/git_show/git_diff/git_init_if_missing
//   - 레지스트리 git 기능 축: register("git.*")·explorer.git
//   - 플러그인 권한 git 축: "git:read"/"git:write" (W8: 권한 축 폐지 대상)
//
// 구조 제외(스코프 규칙 — allowlist 아님): *.test.* 파일, Rust #[cfg(test)] 모듈(코어 스캔과
// 동일 기준 — 실행 경로가 아니다), target/gen/node_modules/.git.
//
// ALLOWLIST 는 아래 목록이 전부다. 추가는 C5 절차(명시 문제 제기 → 재입법 커밋)로만 한다.
//
// 사용: node scripts/gates/core-git-scan.mjs [--root <dir>]
// exit 0 = 봉인 일치, exit 1 = 신규 유입·봉인 초과·stale. blocking 게이트다.
// 짝 테스트: scripts/gates/core-git-scan.test.mjs (vitest)
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { stripRustTestModule } from "./core-decoupling-scan.mjs";

// 패턴별 이름 — 보고 가독성용. 매칭 수는 파일 단위로 합산해 SEALED 와 대조한다.
export const PATTERNS = [
  { name: "git-spawn", re: /Command::new\("git"\)/g },
  { name: "git-command-ident", re: /\b(?:git_status|git_log|git_show|git_diff|git_init_if_missing)\b/g },
  { name: "git-registry-axis", re: /register\("git\.|explorer\.git/g },
  { name: "git-permission-axis", re: /"git:(?:read|write)"/g },
];

// 봉인 — 파일별 잔존 매칭 수. 이 표는 봉인이지 승인이 아니다. 방출(M3) 완료로 표는 비었다(목표
// 달성). 코어에 git 기능은 없다 — 어떤 신규 git 매칭도 유입으로 실패한다(plugins.rs 설치 스폰만
// ALLOWLIST). 재입법(C5)이 필요하면 명시 문제 제기 후 이 표에 항목을 되살린다.
export const SEALED = new Map([]);

// 명시 allowlist — 기능이 아니라 플랫폼 메커니즘인 git 사용. 스캔에서 계수하지 않는다.
export const ALLOWLIST = [
  {
    file: "src-tauri/src/plugins.rs",
    pattern: /Command::new\("git"\)/,
    reason:
      "플러그인 설치·갱신·스캐폴드의 git clone/fetch — 플러그인 플랫폼의 단일 배포 메커니즘이다" +
      " (Obsidian 모델, C1 레지스트리 URL allowlist 와 같은 급). git 기능 표면이 아니다.",
  },
];

const SCAN_ROOTS = ["src", "src-tauri"];
const SKIP_DIRS = new Set(["target", "gen", "node_modules", ".git", "dist"]);
const SCAN_EXTS = new Set([".ts", ".tsx", ".rs", ".mjs"]);
const TEST_FILE = /\.test\.(ts|tsx|mjs)$/;

function allowMatch(relPath, matchText) {
  return ALLOWLIST.some((e) => e.file === relPath && e.pattern.test(matchText));
}

// 한 파일 스캔 — 매칭 상세 목록을 돌려준다. 순수 함수(테스트 짝이 직접 부른다).
export function scanFile(relPath, content, allowUse) {
  const hits = [];
  if (TEST_FILE.test(relPath)) return hits;
  const text = relPath.endsWith(".rs") ? stripRustTestModule(content) : content;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    for (const pat of PATTERNS) {
      for (const m of lines[i].matchAll(pat.re)) {
        if (allowMatch(relPath, m[0])) {
          if (allowUse) {
            const idx = ALLOWLIST.findIndex((e) => e.file === relPath && e.pattern.test(m[0]));
            allowUse[idx] = (allowUse[idx] ?? 0) + 1;
          }
          continue;
        }
        hits.push({ file: relPath, line: i + 1, pattern: pat.name, text: lines[i].trim() });
      }
    }
  }
  return hits;
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

// 루트 전체 스캔 → 봉인 대조. { added, stale, staleAllowlist, perFile } 를 돌려준다.
//   added = 신규 유입(봉인에 없는 파일) 또는 봉인 수 초과.
//   stale = 봉인보다 실측이 적다(방출 진행 — 같은 커밋에서 SEALED 축소 의무).
// sealed 는 대조할 봉인 표(기본 = 이 repo 의 SEALED). 자가검사가 축소 메커니즘을 실측 봉인과
// 무관하게 검증할 수 있게 주입 가능 — 방출 완료(SEALED 공표)여도 stale 판정 로직은 살아 있다.
export function scanRoot(rootDir, sealed = SEALED) {
  const perFile = new Map();
  const allowUse = {};
  for (const scanRootName of SCAN_ROOTS) {
    const dir = join(rootDir, scanRootName);
    if (!existsSync(dir)) continue;
    for (const p of walk(dir)) {
      const rel = relative(rootDir, p);
      const hits = scanFile(rel, readFileSync(p, "utf8"), allowUse);
      if (hits.length) perFile.set(rel, hits);
    }
  }
  const added = [];
  const stale = [];
  for (const [file, hits] of perFile) {
    const sealedCount = sealed.get(file) ?? 0;
    if (hits.length > sealedCount) added.push({ file, count: hits.length, sealed: sealedCount, hits });
  }
  for (const [file, sealedCount] of sealed) {
    const count = perFile.get(file)?.length ?? 0;
    if (count < sealedCount) stale.push({ file, count, sealed: sealedCount });
  }
  const staleAllowlist = ALLOWLIST.filter(
    (e, i) => existsSync(join(rootDir, e.file)) && !(allowUse[i] > 0),
  ).map((e) => e.file);
  return { added, stale, staleAllowlist, perFile };
}

function main() {
  const args = process.argv.slice(2);
  const rootIdx = args.indexOf("--root");
  const root =
    rootIdx >= 0 ? args[rootIdx + 1] : join(fileURLToPath(import.meta.url), "..", "..", "..");
  const { added, stale, staleAllowlist } = scanRoot(root);
  console.log(`W8 git 방출 스캔 — 대상 ${SCAN_ROOTS.join("·")} (root: ${root})`);
  if (added.length) {
    console.log(`\n신규 git 유입/봉인 초과 ${added.length}파일:`);
    for (const a of added) {
      console.log(`  ✗ ${a.file} — 실측 ${a.count}건 (봉인 ${a.sealed}건)`);
      for (const h of a.hits) console.log(`      ${h.file}:${h.line} [${h.pattern}] ${h.text}`);
    }
    console.log(
      "\ngit 은 코어에서 완전 방출한다(W8). 신규 git 기능은 git 플러그인에 만든다." +
        " 봉인 증액은 C5 재입법 커밋으로만 한다.",
    );
  }
  if (stale.length) {
    console.log(`\nstale 봉인 ${stale.length}파일 — 방출이 진행됐다. 같은 커밋에서 SEALED 를 내려라:`);
    for (const s of stale) console.log(`  ✗ ${s.file} — 실측 ${s.count}건 < 봉인 ${s.sealed}건`);
  }
  if (staleAllowlist.length) {
    console.log(`\nstale allowlist ${staleAllowlist.length}건 — 매칭 0건 예외는 제거하라:`);
    for (const f of staleAllowlist) console.log(`  ✗ ${f}`);
  }
  if (added.length || stale.length || staleAllowlist.length) process.exit(1);
  const total = [...SEALED.values()].reduce((a, b) => a + b, 0);
  console.log(`\nPASS: 신규 git 유입 0 — 봉인 잔존 ${SEALED.size}파일 ${total}건 (목표 0)`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
