// C2 투명성 스캔 게이트 — 설치된 플러그인 매니페스트에서 결합 법칙 C2 정적 규칙의 위반을 실측한다.
// 법(C-법, docs/ARCHITECTURE.md 결합 법칙): 모든 기능은 투명성 3종(command·status·DOM)을 노출한다.
// 이 게이트가 판정하는 건 매니페스트 카운트만으로 결정되는 정적 2종이다:
//   - command-surface: 기능 보유(views>0 ∨ programs>0 ∨ fileViewers>0) ∧ commands=0
//   - view-nodes:      views>0 ∧ nodes=0(ui.tree 부재 = 주소 기반 클릭 E2E 불가)
// view-status 는 마운트된 콘텐츠 뷰에서만 판정 가능한 런타임 규칙이라 헤드리스 매니페스트 스캔 밖이다 —
// 그 실측·시행 지점은 plugin.conformance(코어) 다.
//
// 판정 규칙의 단일진실은 코어 src/plugins/conformance.ts 의 transparencyViolations 이고, 이 게이트의
// c2StaticViolations 는 그 미러다 — 짝 테스트(c2-transparency-scan.test.mjs)가 두 함수의 일치를
// count 행렬 전수로 핀한다. 코어에 플러그인 id 를 넣지 않는다(C1): 스캔은 런타임 디렉토리 순회다.
//
// 사용: node scripts/gates/c2-transparency-scan.mjs [--plugins <dir>] [--json]
// exit 0 = 위반 0건, exit 1 = 위반 또는 매니페스트 파싱 실패. "위반 0 실측"을 exit code 로 —
// C2 정적 규칙의 blocking 승격(C2_ENFORCEMENT 재입법)의 기계 조건이다. 현행 상태는 위반 잔존이라
// 아직 make gates(blocking)에 편입되지 않는다 — 승격 시 재입법 커밋이 편입한다.
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { parseManifest } from "@soksak-ai/plugin-spec";

// 판정 미러 — 코어 transparencyViolations 와 동일해야 한다(짝 테스트가 강제). 정적 2종만.
export function c2StaticViolations(counts) {
  const out = [];
  if (
    (counts.views > 0 || counts.programs > 0 || counts.fileViewers > 0) &&
    counts.commands === 0
  ) {
    out.push({
      rule: "command-surface",
      detail: `기능 보유(views=${counts.views}, programs=${counts.programs}, fileViewers=${counts.fileViewers})인데 commands=0`,
    });
  }
  if (counts.views > 0 && counts.nodes === 0) {
    out.push({
      rule: "view-nodes",
      detail: `views=${counts.views}인데 contributes.nodes=0 — ui.tree 노출 없음`,
    });
  }
  return out;
}

// 파싱된 매니페스트 → 기여축 카운트(로더가 시행에 쓰는 것과 같은 배열 길이).
export function manifestCounts(manifest) {
  const c = manifest.contributes;
  return {
    views: c.views.length,
    programs: c.programs.length,
    fileViewers: c.fileViewers.length,
    commands: c.commands.length,
    nodes: c.nodes.length,
  };
}

// 플러그인 디렉토리 순회 → { perRule, plugins, scanned, parseErrors }.
//   perRule: { "command-surface": [id...], "view-nodes": [id...] } — 규칙별 위반 플러그인 목록.
//   parseErrors: 매니페스트가 파싱 실패한 디렉토리(스캔 불가 = 실측 불가 = 실패로 취급).
export function scanPlugins(pluginsDir) {
  const perRule = { "command-surface": [], "view-nodes": [] };
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
    const counts = manifestCounts(manifest);
    const violations = c2StaticViolations(counts);
    plugins.push({ id: manifest.id, dir: name, counts, violations });
    for (const v of violations) perRule[v.rule].push(manifest.id);
  }
  return { perRule, plugins, scanned, parseErrors, pluginsDir, missing: false };
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
    console.log(`C2 투명성 스캔(정적 2종) — 대상 ${pluginsDir}`);
    if (r.missing) {
      console.log("  플러그인 디렉토리 없음 — SOKSAK_HOME/SOKSAK_ENV 또는 --plugins 로 지정하라.");
    } else {
      console.log(`  스캔 ${r.scanned}개, 위반 매니페스트 ${r.plugins.filter((p) => p.violations.length).length}개`);
      for (const rule of Object.keys(r.perRule)) {
        const ids = r.perRule[rule];
        console.log(`  ${rule}: 위반 ${ids.length}${ids.length ? ` — ${ids.join(", ")}` : ""}`);
      }
      if (r.parseErrors.length) {
        console.log(`\n매니페스트 파싱 실패 ${r.parseErrors.length}건(실측 불가):`);
        for (const e of r.parseErrors) console.log(`  ✗ ${e.dir}: ${e.errors.join("; ")}`);
      }
    }
  }
  const violationCount = Object.values(r.perRule).reduce((n, ids) => n + ids.length, 0);
  const failed = r.missing || violationCount > 0 || r.parseErrors.length > 0;
  if (!asJson) {
    console.log(failed ? "\nFAIL: C2 정적 위반 잔존 — blocking 승격 불가" : "\nPASS: C2 정적 위반 0건");
  }
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
