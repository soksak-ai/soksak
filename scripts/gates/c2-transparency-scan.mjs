// C2 투명성 스캔 게이트 — 설치된 플러그인 매니페스트에서 결합 법칙 C2 정적 규칙의 위반을 실측한다.
// 법(C-법, docs/ARCHITECTURE.md 결합 법칙): 모든 기능은 투명성 3종(command·status·DOM)을 노출한다.
// 이 게이트가 판정하는 건 매니페스트만으로 결정되는 정적 3종이다:
//   - command-surface:     기능 보유(views>0 ∨ programs>0 ∨ fileViewers>0) ∧ commands=0
//   - view-nodes:          views>0 ∧ nodes=0(ui.tree 부재 = 주소 기반 클릭 E2E 불가)
//   - content-view-status: 콘텐츠 뷰의 status 선언(contributes.views[].status) 부재
// 마운트 실보고(view-status)는 런타임 규칙이라 헤드리스 매니페스트 스캔 밖이다 —
// 그 실측·시행 지점은 plugin.conformance(코어) 다.
//
// 판정·시행표의 단일진실은 스펙 패키지(@soksak-ai/plugin-spec transparency.ts)다 — 이 게이트는
// 소비자일 뿐 판정 미러를 두지 않는다(코어 로더·validate CLI 와 같은 함수·표를 import 한다).
// 코어에 플러그인 id 를 넣지 않는다(C1): 스캔은 런타임 디렉토리 순회다.
//
// 사용: node scripts/gates/c2-transparency-scan.mjs [--plugins <dir>] [--json]
// exit 0 = blocking 규칙 위반 0건, exit 1 = blocking 위반 또는 매니페스트 파싱 실패.
// warn 규칙(content-view-status) 위반은 보고만 한다 — blocking 승격(재입법)의 기계 조건이
// "이 게이트가 warn 카운트 0 을 실측"이다(command-surface·view-nodes 가 밟은 래칫과 동일).
// make gates 에 편입되어 있다(blocking) — warn 규칙은 카운트가 남아도 게이트를 깨지 않는다.
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  C2_STATIC_ENFORCEMENT,
  parseManifest,
  transparencyViolations,
} from "@soksak-ai/plugin-spec";

// 플러그인 디렉토리 순회 → { perRule, plugins, scanned, parseErrors }.
//   perRule: 규칙별 위반 플러그인 id 목록(규칙 축 = C2_STATIC_ENFORCEMENT 의 키 — 표가 곧 축).
//   parseErrors: 매니페스트가 파싱 실패한 디렉토리(스캔 불가 = 실측 불가 = 실패로 취급).
export function scanPlugins(pluginsDir) {
  const perRule = Object.fromEntries(
    Object.keys(C2_STATIC_ENFORCEMENT).map((rule) => [rule, []]),
  );
  const plugins = [];
  const parseErrors = [];
  let scanned = 0;
  if (!existsSync(pluginsDir)) {
    return { perRule, plugins, scanned, parseErrors, pluginsDir, missing: true };
  }
  for (const name of readdirSync(pluginsDir).sort()) {
    const dir = join(pluginsDir, name);
    if (!statSync(dir).isDirectory()) continue;
    const manifestPath = join(dir, "plugin.json");
    if (!existsSync(manifestPath)) continue;
    scanned++;
    let raw;
    try {
      raw = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch (e) {
      parseErrors.push({ dir: name, errors: [`plugin.json JSON 파싱 실패: ${e.message}`] });
      continue;
    }
    const { manifest, validation } = parseManifest(raw, name);
    if (!manifest) {
      parseErrors.push({ dir: name, errors: validation.errors });
      continue;
    }
    const violations = transparencyViolations(manifest.contributes);
    plugins.push({ id: manifest.id, dir: name, violations });
    for (const v of violations) perRule[v.rule].push(manifest.id);
  }
  return { perRule, plugins, scanned, parseErrors, pluginsDir, missing: false };
}

// blocking 규칙 위반 총수 — 게이트 실패 조건(warn 규칙은 보고 전용, 래칫 측정치).
export function blockingViolationCount(perRule) {
  return Object.entries(perRule).reduce(
    (n, [rule, ids]) =>
      n + (C2_STATIC_ENFORCEMENT[rule] === "blocking" ? ids.length : 0),
    0,
  );
}

// 설치본 플러그인 디렉토리 해석 — home.rs 와 같은 우선순위(선언/발견, 하드코딩 절대경로 금지):
//   --plugins <dir> > SOKSAK_HOME/plugins > SOKSAK_ENV 로 파생한 identity 홈/plugins > 기본 dev 홈.
export function resolvePluginsDir(args = []) {
  const i = args.indexOf("--plugins");
  if (i >= 0 && args[i + 1]) return args[i + 1];
  if (process.env.SOKSAK_HOME) return join(process.env.SOKSAK_HOME, "plugins");
  const env = process.env.SOKSAK_ENV;
  const suffix = env === "release" || env === "app" ? "" : env === "debug" ? "-debug" : "-dev";
  return join(homedir(), `.soksak${suffix}`, "plugins");
}

function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");
  const pluginsDir = resolvePluginsDir(args);
  const r = scanPlugins(pluginsDir);
  if (asJson) {
    console.log(JSON.stringify(r, null, 2));
  } else {
    console.log(`C2 투명성 스캔(정적 3종) — 대상 ${pluginsDir}`);
    if (r.missing) {
      console.log("  플러그인 디렉토리 없음 — SOKSAK_HOME/SOKSAK_ENV 또는 --plugins 로 지정하라.");
    } else {
      console.log(`  스캔 ${r.scanned}개, 위반 매니페스트 ${r.plugins.filter((p) => p.violations.length).length}개`);
      for (const [rule, ids] of Object.entries(r.perRule)) {
        const mode = C2_STATIC_ENFORCEMENT[rule];
        console.log(`  ${rule}(${mode}): 위반 ${ids.length}${ids.length ? ` — ${ids.join(", ")}` : ""}`);
      }
      if (r.parseErrors.length) {
        console.log(`\n매니페스트 파싱 실패 ${r.parseErrors.length}건(실측 불가):`);
        for (const e of r.parseErrors) console.log(`  ✗ ${e.dir}: ${e.errors.join("; ")}`);
      }
    }
  }
  const failed = r.missing || blockingViolationCount(r.perRule) > 0 || r.parseErrors.length > 0;
  if (!asJson) {
    console.log(
      failed
        ? "\nFAIL: C2 blocking 위반 또는 실측 불가"
        : "\nPASS: C2 blocking 위반 0건(warn 규칙은 래칫 측정치)",
    );
  }
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
