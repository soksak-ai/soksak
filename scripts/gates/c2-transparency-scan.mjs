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
// 코어에 플러그인 id 를 넣지 않는다(C1): 판정은 매니페스트 집계다.
//
// [모집단 규칙] 배포·설치는 GitHub 를 통한다 — 로컬 dir 은 개발용 작업 사본일 뿐이다(public 보다
// 앞/뒤설 수 있다). blocking 승격 래칫의 권위 실측 모집단은 "배포 카탈로그(라이브 registry.json)에
// 실린 플러그인의 현재 GitHub 매니페스트"다(--registry) — 승격이 막아야 할 건 배포된 플러그인의
// 드롭이지, 카탈로그 밖 미배포 WIP 가 아니다. 로컬 스캔(--plugins)은 개발자 사전점검이지 승격
// 권위가 아니다. 이 규칙 이전엔 dev-home 을 승격 기준으로 삼아, 로컬이 public 보다 앞선 사이
// 카탈로그된 플러그인들이 public 에서 위반을 안은 채 blocking 이 승격돼 배포 게이트가 그들을
// 드롭했다(14종 사고). 재발 방지 = 이 게이트를 승격 전 GREEN 확인.
//
// 사용:
//   node c2-transparency-scan.mjs --registry            # GitHub public(배포 진실) — 승격 권위
//   node c2-transparency-scan.mjs [--plugins <dir>]     # 로컬 dev-home — 사전점검
//   [--json] 로 기계 판독.
// exit 0 = blocking 규칙 위반 0건, exit 1 = blocking 위반 또는 매니페스트 실측 불가.
// warn 규칙 위반은 보고만 한다 — blocking 승격(재입법)의 기계 조건이 "--registry 가 warn 카운트
// 0 을 실측"이다. make gates 는 로컬 사전점검, make gates-registry 가 승격 권위 게이트다.
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  C2_STATIC_ENFORCEMENT,
  parseManifest,
  transparencyViolations,
} from "@soksak-ai/plugin-spec";

// 판정은 모집단 무관 — entries([{name,text}]) 를 스펙 패키지 표·함수로만 판정한다(소스 분리).
// 로컬 dir 순회든 GitHub public fetch 든 같은 판정을 통과한다(판정 미러 0 — 이중진실 폐기).
//   perRule: 규칙별 위반 플러그인 id 목록(규칙 축 = C2_STATIC_ENFORCEMENT 의 키 — 표가 곧 축).
//   parseErrors: 매니페스트가 파싱 실패한 항목(스캔 불가 = 실측 불가 = 실패로 취급).
export function judgeManifests(entries) {
  const perRule = Object.fromEntries(
    Object.keys(C2_STATIC_ENFORCEMENT).map((rule) => [rule, []]),
  );
  const plugins = [];
  const parseErrors = [];
  let scanned = 0;
  for (const { name, text } of entries) {
    scanned++;
    let raw;
    try {
      if (text == null) throw new Error("매니페스트 본문 없음(fetch 실패)");
      raw = JSON.parse(text);
    } catch (e) {
      parseErrors.push({ dir: name, errors: [`plugin.json 파싱 실패: ${e.message}`] });
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
  return { perRule, plugins, scanned, parseErrors };
}

// [로컬 = 개발 사전점검] 설치본 디렉토리 순회. dev-home 은 작업 사본일 뿐이라 public 보다
// 앞/뒤설 수 있다 — 승격 권위가 아니다(권위는 scanRegistry). 개발자 자기 작업 확인용.
export function scanPlugins(pluginsDir) {
  if (!existsSync(pluginsDir)) {
    return { ...judgeManifests([]), pluginsDir, missing: true };
  }
  const entries = [];
  for (const name of readdirSync(pluginsDir).sort()) {
    const dir = join(pluginsDir, name);
    if (!statSync(dir).isDirectory()) continue;
    const manifestPath = join(dir, "plugin.json");
    if (!existsSync(manifestPath)) continue;
    let text = null;
    try {
      text = readFileSync(manifestPath, "utf8");
    } catch { /* text=null → parseErrors */ }
    entries.push({ name, text });
  }
  return { ...judgeManifests(entries), pluginsDir, missing: false };
}

// 배포 카탈로그 위치(GitHub 를 통한 배포 진실) — Makefile REGISTRY_URL 과 같은 라이브 registry.json.
// 인프라 위치이지 플러그인 id 가 아니다(C1 무저촉). 테스트·환경 재정의 가능.
export const REGISTRY_URL =
  process.env.SOKSAK_REGISTRY_URL ||
  "https://raw.githubusercontent.com/soksak-ai/soksak-plugin-registry/main/registry.json";

// [배포 모집단 = 카탈로그된 플러그인의 현재 GitHub 매니페스트] 라이브 registry.json 에 실린
// 플러그인(=사용자에게 배포되는 것)의 현재 매니페스트를 그 repo/branch 에서 fetch 한다. 카탈로그
// 밖 public repo(미배포 WIP)는 래칫 대상이 아니다 — 승격이 막아야 할 건 "배포된 플러그인의 드롭".
// gh 불필요(순수 public fetch). 네트워크 의존이라 opt-in 게이트다.
export async function fetchRegistryEntries({ registryUrl = REGISTRY_URL } = {}) {
  const res = await fetch(registryUrl);
  if (!res.ok) throw new Error(`registry.json fetch 실패(${res.status}) — ${registryUrl}`);
  const registry = JSON.parse(await res.text());
  const entries = [];
  for (const p of registry.plugins ?? []) {
    // repo URL → raw 매니페스트 URL(owner/name 추출). branch 는 카탈로그 선언값.
    const m = /github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(p.repo || "");
    const owner = m?.[1] ?? "soksak-ai";
    const name = m?.[2] ?? p.id;
    const branch = p.branch || "main";
    let text = null;
    try {
      const r = await fetch(`https://raw.githubusercontent.com/${owner}/${name}/${branch}/plugin.json`);
      if (r.ok) text = await r.text();
    } catch { /* text=null → parseErrors(실측 불가) */ }
    entries.push({ name: p.id, text });
  }
  return entries;
}

// 승격 래칫의 권위 실측 — 배포(GitHub public) 모집단을 판정한다. C2 규칙을 blocking 으로 승격하려면
// 이 게이트가 위반·실측불가 0 이어야 한다(시행 모집단 = 측정 모집단). fetchEntries 주입 가능(테스트).
export async function scanRegistry({ fetchEntries = fetchRegistryEntries } = {}) {
  const entries = await fetchEntries();
  return { ...judgeManifests(entries), source: "registry" };
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

function report(r, asJson, label) {
  if (asJson) {
    console.log(JSON.stringify(r, null, 2));
    return;
  }
  console.log(`C2 투명성 스캔(정적 3종) — 대상 ${label}`);
  if (r.missing) {
    console.log("  플러그인 디렉토리 없음 — SOKSAK_HOME/SOKSAK_ENV 또는 --plugins 로 지정하라.");
    return;
  }
  console.log(`  스캔 ${r.scanned}개, 위반 매니페스트 ${r.plugins.filter((p) => p.violations.length).length}개`);
  for (const [rule, ids] of Object.entries(r.perRule)) {
    const mode = C2_STATIC_ENFORCEMENT[rule];
    console.log(`  ${rule}(${mode}): 위반 ${ids.length}${ids.length ? ` — ${ids.join(", ")}` : ""}`);
  }
  if (r.parseErrors.length) {
    console.log(`\n매니페스트 실측 불가 ${r.parseErrors.length}건:`);
    for (const e of r.parseErrors) console.log(`  ✗ ${e.dir}: ${e.errors.join("; ")}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");
  let r, label;
  if (args.includes("--registry")) {
    // 승격 권위 — GitHub public(배포 진실) 실측.
    try {
      r = await scanRegistry();
      label = `배포 카탈로그 (${REGISTRY_URL})`;
    } catch (e) {
      console.error(`FAIL: 배포 모집단 실측 불가 — ${e.message}`);
      process.exit(1);
    }
  } else {
    // 로컬 dev-home — 개발 사전점검.
    label = resolvePluginsDir(args);
    r = scanPlugins(label);
  }
  report(r, asJson, label);
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

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
