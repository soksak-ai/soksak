// 배포 카탈로그 fetch — 단일진실. 배포·설치는 GitHub 를 통한다(로컬 dir 은 개발 사본일 뿐).
// 배포 모집단 = 라이브 registry.json 에 실린 플러그인(=사용자에게 배포되는 것)의 현재 GitHub
// 매니페스트. C2 승격 게이트(c2-transparency-scan)와 의존 그래프 게이트(dependency-graph-scan)가
// 이 fetch 하나를 공유한다 — 모집단 정의 미러 0.
//
// gh 불필요(순수 public fetch). 네트워크 의존이라 이 모듈을 쓰는 게이트는 opt-in 이다.

// 배포 카탈로그 위치(GitHub 를 통한 배포 진실) — Makefile REGISTRY_URL 과 같은 라이브 registry.json.
// 인프라 위치이지 플러그인 id 가 아니다(C1 무저촉). 환경 재정의 가능.
export const REGISTRY_URL =
  process.env.SOKSAK_REGISTRY_URL ||
  "https://raw.githubusercontent.com/soksak-ai/soksak-plugin-registry/main/registry.json";

// 라이브 registry.json 에 실린 플러그인의 현재 매니페스트를 그 repo/branch 에서 fetch.
// 반환: [{ name, text }] — text 는 매니페스트 원문(null = fetch 실패 = 실측 불가, 소비자가 판정).
// 카탈로그 밖 public repo(미배포 WIP)는 대상이 아니다 — 게이트가 지키는 건 배포된 것의 무결성.
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
    } catch { /* text=null → 소비자가 실측 불가로 판정 */ }
    entries.push({ name: p.id, text });
  }
  return entries;
}
