// 계약 동기 게이트 — 코어 발행 contract.json 과 그 하위 소비본(soksak-plugin-doctor 의 vendored
// contract.json)이 일치하는지 실측한다. "계약 데이터는 코어에 한 번 산다"(PLUGIN-CONTRACT §4):
// 코어가 단일 진실이고, doctor 는 그 데이터를 소비할 뿐이다. 그런데 doctor 는 정적 복사본을 vendor
// 하고 sync/drift 게이트가 없어 조용히 드리프트했다(2026-07: service 권한 누락·제거된 git:read 잔존
// → 서비스 플러그인 doctor 오거부). 이 게이트가 그 드리프트를 코어에서 큰 소리로 잡는다.
//
// 판정은 순수(두 계약 객체만 받는다). 배열은 집합으로 정규화(순서 무의미) — 항목 추가/제거만 드리프트.
// 네트워크(doctor 발행본 fetch) 의존이라 opt-in(make gates-registry). 로컬 계약 pin 은
// contract.gen.test.ts 가 이미 코어 contract.json ≡ 라이브 코어를 강제한다 — 이건 그 하위 복사본.
//
// 사용: node scripts/gates/contract-sync-scan.mjs [--json]
// exit 0 = 드리프트 0, exit 1 = 드리프트 또는 발행본 실측 불가.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const DOCTOR_CONTRACT_URL =
  process.env.SOKSAK_DOCTOR_CONTRACT_URL ||
  "https://raw.githubusercontent.com/soksak-ai/soksak-plugin-doctor/main/contract.json";

// 재귀 정규화 — 원시값 배열은 정렬(순서 무의미), 객체 키 정렬. 집합/구조 차이만 남긴다.
function normalize(v) {
  if (Array.isArray(v)) {
    const items = v.map(normalize);
    if (items.every((x) => typeof x !== "object" || x === null)) {
      return [...items].sort((a, b) => String(a).localeCompare(String(b)));
    }
    return items;
  }
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, normalize(v[k])]));
  }
  return v;
}

// 코어 계약 vs 발행본 — 필드별 드리프트. reason: core-only(발행본이 뒤처짐)·published-only(발행본이
// 코어에 없는 것을 실음)·differs(값 상이). 배열 필드는 추가/제거 항목까지 뽑아 조치 가능하게.
export function judgeContractDrift(core, published) {
  const drift = [];
  const keys = [...new Set([...Object.keys(core || {}), ...Object.keys(published || {})])].sort();
  for (const k of keys) {
    const a = JSON.stringify(normalize(core?.[k]));
    const b = JSON.stringify(normalize(published?.[k]));
    if (a === b) continue;
    const entry = { field: k };
    if (Array.isArray(core?.[k]) || Array.isArray(published?.[k])) {
      const cs = new Set((core?.[k] || []).map(String));
      const ps = new Set((published?.[k] || []).map(String));
      entry.coreOnly = [...cs].filter((x) => !ps.has(x));   // 코어에 있고 발행본에 없음(발행본 뒤처짐)
      entry.publishedOnly = [...ps].filter((x) => !cs.has(x)); // 발행본에만(코어가 제거했는데 잔존)
    }
    drift.push(entry);
  }
  return drift;
}

export function readCoreContract() {
  const here = dirname(fileURLToPath(import.meta.url));
  return JSON.parse(readFileSync(join(here, "..", "..", "src", "plugins", "contract.json"), "utf8"));
}

export async function fetchPublishedContract({ url = DOCTOR_CONTRACT_URL } = {}) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`doctor contract.json fetch 실패(${res.status}) — ${url}`);
  return JSON.parse(await res.text());
}

async function main() {
  const asJson = process.argv.slice(2).includes("--json");
  let published;
  try {
    published = await fetchPublishedContract();
  } catch (e) {
    console.error(`FAIL: 발행본 실측 불가 — ${e.message}`);
    process.exit(1);
  }
  const core = readCoreContract();
  const drift = judgeContractDrift(core, published);
  if (asJson) {
    console.log(JSON.stringify({ drift }, null, 2));
  } else {
    console.log(`계약 동기 스캔 — 코어 src/plugins/contract.json ↔ doctor 발행본`);
    console.log(`  드리프트 필드 ${drift.length}건`);
    for (const d of drift) {
      let detail = "";
      if (d.coreOnly?.length) detail += ` 코어에만(발행본 추가 필요): ${d.coreOnly.join(", ")}`;
      if (d.publishedOnly?.length) detail += ` 발행본에만(제거 필요): ${d.publishedOnly.join(", ")}`;
      console.log(`  ✗ ${d.field}:${detail || " 값 상이"}`);
    }
  }
  const failed = drift.length > 0;
  if (!asJson) {
    console.log(
      failed
        ? "\nFAIL: doctor 계약이 코어 발행 contract 와 드리프트 — 코어 src/plugins/contract.json 을 doctor repo 로 동기·push 하라"
        : "\nPASS: doctor 발행 계약이 코어와 일치",
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
