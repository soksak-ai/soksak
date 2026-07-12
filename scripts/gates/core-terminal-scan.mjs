// 터미널 해석기 방출 스캔 게이트 — 코어(src/·src-tauri/)에 VT 해석기·미러·화면 복원
// 어휘가 다시 들어오는 것을 봉인한다. 법(플랜 §0 결정 2·8, 사용자 판결): VT 해석(바이트→
// 화면 상태)은 코어 밖(사이드카 soksak-sidecar-terminal-alacritty) 소유다. PTY 배관(pty 열고
// 바이트 나름)은 결정 1로 코어 잔류다 — 두 도메인을 이 게이트가 가른다.
//
// 위반 패턴(코어의 터미널 해석 지식):
//   - VT 엔진·미러: alacritty_terminal / soksak_pty_mirror / cold_paint / rehydrate /
//     suppressed_replies / alt_screen / altActive
//   - 코어 복원 신호(페인트 소유가 플러그인으로 가며 은퇴): screen_restored / wasScreenRestored
//   - 체크포인트 도메인 어휘(봉인-블롭 저장소는 배관 어휘를 쓴다): checkpoint
//
// 허용(방출 아님 — 결정 1): PTY OS 프리미티브 openpty / portable_pty / native_pty_system.
// 이건 배관이라 코어 합법이다. PATTERNS 에 넣어 ALLOWLIST 로 사면 — 스캔이 "지운 것"이
// 아니라 "의도적으로 남긴 것"임을 기계로 표명한다(git 게이트의 plugins.rs 스폰과 같은 급).
//
// checkpoint 토큰은 bare word(\bcheckpoint\b)만 금한다 — 복합 식별자(checkpoint_path·
// checkpoint_pk·CkptCfg)·wire(checkpointPk)·온-디스크(ckpt- stem)는 잡지 않는다. 판정(B,
// 사용자 확정):
//   1. 방출의 법익은 "코어가 터미널 해석(화면·VT·미러)을 모른다"이다. "봉인 상태-블롭을 주기
//      저장하고 정상종료 시 지운다"는 동작은 코어 자신의 generic 저장소 의미론이고, 그 자기
//      동작을 가리키는 복합 식별자는 터미널 지식 누수가 아니다.
//   2. wire(checkpointPk)·온-디스크(ckpt- stem)는 사이드카가 SPEC 으로 독립 구현한 계약면이다.
//      순수 표기 목적의 개명은 비용>이익의 breaking wire 변경이라 계약 안정성을 우선한다.
//   3. bare \bcheckpoint\b 금지는 주석·doc·에러 문구의 의미 표류(코어가 "이건 복원 체크포인트"
//      라고 말하기 시작하는 것)를 막는 용도로 정확하다. 단어 경계는 wal_checkpoint(SQLite WAL)
//      같은 무관 배관 오탐도 회피한다.
//
// 구조 제외(스코프 규칙 — allowlist 아님): 테스트 코드는 배포 경로가 아니라 해석기 어휘를
// 서술·단언하는 것이 정당하다(예: 봉투에 altActive 가 '없음'을 단언). *.test.* 파일, Rust
// 통합 테스트(tests/ 하위), #[cfg(test)] 모듈, target/gen/node_modules/.git/dist 를 건너뛴다.
//
// ALLOWLIST 는 아래 목록이 전부다. 추가는 명시 재입법(문제 제기 → 커밋)으로만 한다.
//
// 사용: node scripts/gates/core-terminal-scan.mjs [--root <dir>]
// exit 0 = 봉인 일치, exit 1 = 신규 유입·봉인 초과·stale. blocking 게이트다.
// 짝 테스트: scripts/gates/core-terminal-scan.test.mjs (vitest)
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { stripRustTestModule } from "./core-decoupling-scan.mjs";

// 패턴별 이름 — 보고 가독성용. 매칭 수는 파일 단위로 합산해 SEALED 와 대조한다.
export const PATTERNS = [
  // VT 엔진·미러·직렬화 어휘. soksak-pty-mirror 는 하이픈이라 단어 경계 밖(주석·문자열)도 잡는다.
  { name: "interp-engine", re: /soksak[_-]pty[_-]mirror|\balacritty_terminal\b/g },
  { name: "interp-paint", re: /\b(?:cold_paint|rehydrate|suppressed_replies|alt_screen|altActive)\b/g },
  // 코어 화면 복원 신호(방출 결정 8) — snake·camel·was 접두 전부.
  { name: "screen-restored", re: /\bscreen_restored\b|\b(?:was)?[Ss]creenRestored\b/g },
  // 체크포인트 도메인 어휘. \b 로 감싸 wal_checkpoint(SQLite WAL) 같은 무관 배관은 잡지 않는다.
  { name: "checkpoint-vocab", re: /\bcheckpoint\b/g },
  // PTY OS 프리미티브 — 결정 1로 코어 잔류. ALLOWLIST 로 사면(방출 대상 아님).
  { name: "pty-plumbing", re: /\b(?:openpty|portable_pty|native_pty_system)\b/g },
];

// 봉인 — 파일별 잔존 매칭 수. 이 표는 봉인이지 승인이 아니다. 방출(M4) 완료로 표는 비었다
// (목표 달성). 코어에 터미널 해석은 없다 — 어떤 신규 해석기 매칭도 유입으로 실패한다(PTY
// 배관만 ALLOWLIST). 재입법이 필요하면 명시 문제 제기 후 이 표에 항목을 되살린다.
export const SEALED = new Map([]);

// 명시 allowlist — 해석기가 아니라 OS 프리미티브인 PTY 사용. 스캔에서 계수하지 않는다.
export const ALLOWLIST = [
  {
    file: "src-tauri/crates/soksak-ptyd/src/main.rs",
    pattern: /openpty|portable_pty|native_pty_system/,
    reason:
      "PTY = OS 프리미티브(결정 1, 사용자 확정): 데몬이 pty 를 열어 바이트를 나른다." +
      " 방출된 건 VT 해석이지 pty 배관이 아니다.",
  },
  {
    file: "src-tauri/src/pty.rs",
    pattern: /openpty|portable_pty|native_pty_system/,
    reason:
      "PTY = OS 프리미티브(결정 1, 사용자 확정): 앱의 in-process 폴백 백엔드가 pty 를" +
      " 직접 연다. pty 배관은 코어 잔류, 해석기는 아니다.",
  },
];

const SCAN_ROOTS = ["src", "src-tauri"];
const SKIP_DIRS = new Set(["target", "gen", "node_modules", ".git", "dist"]);
const SCAN_EXTS = new Set([".ts", ".tsx", ".rs", ".mjs"]);
const TEST_FILE = /\.test\.(ts|tsx|mjs)$/;
// Rust 통합 테스트(크레이트 tests/ 하위) — 배포 경로가 아니다. 해석기 어휘의 서술·단언이
// 정당하므로 #[cfg(test)]·.test.* 와 같은 구조 제외로 다룬다.
const INTEGRATION_TEST = /(?:^|\/)tests\//;

function allowMatch(relPath, matchText) {
  return ALLOWLIST.some((e) => e.file === relPath && e.pattern.test(matchText));
}

// 한 파일 스캔 — 매칭 상세 목록을 돌려준다. 순수 함수(테스트 짝이 직접 부른다).
export function scanFile(relPath, content, allowUse) {
  const hits = [];
  if (TEST_FILE.test(relPath) || INTEGRATION_TEST.test(relPath)) return hits;
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
// 무관하게 검증할 수 있게 주입 가능.
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
  console.log(`터미널 해석기 방출 스캔 — 대상 ${SCAN_ROOTS.join("·")} (root: ${root})`);
  if (added.length) {
    console.log(`\n신규 해석기 유입/봉인 초과 ${added.length}파일:`);
    for (const a of added) {
      console.log(`  ✗ ${a.file} — 실측 ${a.count}건 (봉인 ${a.sealed}건)`);
      for (const h of a.hits) console.log(`      ${h.file}:${h.line} [${h.pattern}] ${h.text}`);
    }
    console.log(
      "\nVT 해석은 코어에서 방출한다(결정 2·8). 화면 상태 해석은 사이드카에 만든다." +
        " PTY 배관(openpty 등)만 결정 1로 코어 잔류(ALLOWLIST). 봉인 증액은 재입법 커밋으로만.",
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
  console.log(`\nPASS: 신규 해석기 유입 0 — 봉인 잔존 ${SEALED.size}파일 ${total}건 (목표 0)`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
