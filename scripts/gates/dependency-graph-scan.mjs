// 의존 그래프 게이트 — 배포 카탈로그의 플러그인↔플러그인 의존이 카탈로그 안에서 충족되는지 실측한다.
// 규칙: 플러그인은 그 의존(dependencies: depId → semver 범위)이 배포 카탈로그에 존재하고 버전이
// 범위를 만족할 때만 배포 무결하다. 불충족 = 카탈로그가 동작 못 하는 플러그인을 광고하는 상태.
//
// 근거(사고): 배포 게이트(update.sh)는 플러그인을 고립적으로만 검증(스키마+doctor)하고 그래프를
// 안 봤다. 그래서 (a) rename 된 대상(soksak-plugin-browser→-native)을 옛 id 로 가리키는 의존자,
// (b) 미발행 대상(git-core)을 가리키는 의존자가 그대로 카탈로그됐다 — 의존이 안 풀리는 채로.
// 이 게이트가 그 그래프-맹목을 닫는다(시행 모집단 = 배포 카탈로그).
//
// 판정은 순수(available·requirements 만 받는다). 버전 만족은 스펙 패키지 semverSatisfies 단일진실.
// 카탈로그 fetch 는 deploy-catalog 단일진실(C2 게이트와 공유). 네트워크 의존이라 opt-in 이다.
//
// 사용: node scripts/gates/dependency-graph-scan.mjs [--json]
// exit 0 = 미충족 의존 0 + 실측불가 0, exit 1 = 미충족 의존 또는 매니페스트 실측 불가.
import { semverSatisfies, parseManifest } from "@soksak-ai/plugin-spec";
import { fileURLToPath } from "node:url";
import { REGISTRY_URL, fetchRegistryEntries } from "./deploy-catalog.mjs";

// entries([{name,text}]) → { available: {id→version}, requirements: [{id, deps}], parseErrors }.
//   available: 카탈로그가 제공하는 것(의존 해소 후보). requirements: 각 플러그인이 요구하는 의존.
export function parseCatalog(entries) {
  const available = {};
  const requirements = [];
  const parseErrors = [];
  for (const { name, text } of entries) {
    let raw;
    try {
      if (text == null) throw new Error("매니페스트 본문 없음(fetch 실패)");
      raw = JSON.parse(text);
    } catch (e) {
      parseErrors.push({ id: name, error: e.message });
      continue;
    }
    const { manifest } = parseManifest(raw, name);
    const id = manifest?.id ?? raw.id ?? name;
    available[id] = manifest?.version ?? raw.version ?? "0.0.0";
    requirements.push({ id, deps: (manifest?.dependencies ?? raw.dependencies) || {} });
  }
  return { available, requirements, parseErrors };
}

// 미충족 의존 판정 — 각 의존이 available 에 존재(id)하고 그 버전이 범위(semver)를 만족하는가.
//   reason "missing" = 대상 id 가 카탈로그에 없음(미발행·rename 등). "version" = 있으나 버전 불만족.
export function unsatisfiedDependencies({ available, requirements }) {
  const violations = [];
  for (const { id, deps } of requirements) {
    for (const [depId, range] of Object.entries(deps || {})) {
      if (!(depId in available)) {
        violations.push({ id, dep: depId, range, reason: "missing", detail: "배포 카탈로그에 없음" });
      } else if (!semverSatisfies(available[depId], range)) {
        violations.push({
          id, dep: depId, range, reason: "version",
          detail: `카탈로그 버전 ${available[depId]} 이 ${range} 불만족`,
        });
      }
    }
  }
  return violations;
}

// 배포 카탈로그 그래프 실측 — fetch → 파싱 → 미충족 판정. fetchEntries 주입 가능(테스트·무네트워크).
export async function scanRegistry({ fetchEntries = fetchRegistryEntries } = {}) {
  const entries = await fetchEntries();
  const { available, requirements, parseErrors } = parseCatalog(entries);
  return {
    violations: unsatisfiedDependencies({ available, requirements }),
    scanned: requirements.length,
    parseErrors,
    source: "registry",
  };
}

function report(r, asJson, label) {
  if (asJson) {
    console.log(JSON.stringify(r, null, 2));
    return;
  }
  console.log(`의존 그래프 스캔 — 대상 ${label}`);
  console.log(`  스캔 ${r.scanned}개, 미충족 의존 ${r.violations.length}건`);
  for (const v of r.violations) {
    console.log(`  ✗ ${v.id} → ${v.dep}@${v.range}: ${v.detail} (${v.reason})`);
  }
  if (r.parseErrors.length) {
    console.log(`\n매니페스트 실측 불가 ${r.parseErrors.length}건:`);
    for (const e of r.parseErrors) console.log(`  ✗ ${e.id}: ${e.error}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");
  let r;
  try {
    r = await scanRegistry();
  } catch (e) {
    console.error(`FAIL: 배포 카탈로그 실측 불가 — ${e.message}`);
    process.exit(1);
  }
  report(r, asJson, `배포 카탈로그 (${REGISTRY_URL})`);
  const failed = r.violations.length > 0 || r.parseErrors.length > 0;
  if (!asJson) {
    console.log(
      failed
        ? "\nFAIL: 미충족 의존 또는 실측 불가 — 배포 게이트가 의존 대상을 함께 배포하거나 참조를 정정하라"
        : "\nPASS: 모든 배포 플러그인의 의존이 카탈로그 안에서 충족됨",
    );
  }
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
