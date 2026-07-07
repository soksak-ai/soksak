import { semverGte, type LocalizedText } from "./spec";

// 공식 플러그인 레지스트리 — "설치 가능 목록"의 단일 진실. 각 엔트리는 한 플러그인의 표시용 메타 +
// git 레포 URL(설치 source). 빌드에 스냅샷으로 포함(첫 실행/오프라인), 온라인이면 원격 registry.json
// 으로 갱신. 실제 설치는 repo clone 후 plugin.install → parseManifest 가 엄격 재검증하므로, 여기 검증은
// "목록에 표시 가능한가" 수준(신뢰 경계지만 가벼움 — 손상 엔트리만 스킵, 전체는 살린다).

export const REGISTRY_SPEC = "soksak-registry@1";

export interface RegistryEntry {
  id: string;
  name: LocalizedText;
  version: string; // 스냅샷/원격 시점의 게시 버전 — 설치본과 비교해 업데이트 표시
  description: LocalizedText;
  author?: string;
  repo: string; // git URL — plugin.install 의 source
  branch?: string; // 설치 대상 브랜치 — 없으면 repo 기본 브랜치. master/main 가정 금지(설치 reference)
  commands?: string[]; // 매니페스트 선언 명령 이름(집계 투영) — 설치 전 능력 조회용
}

export interface Registry {
  spec: typeof REGISTRY_SPEC;
  plugins: RegistryEntry[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// name/description: 문자열 또는 {언어:문자열} 객체(LocalizedText). 표시용이라 내용 형식은 느슨히 본다.
function isText(v: unknown): v is LocalizedText {
  if (typeof v === "string") return v.length > 0;
  return isRecord(v) && Object.values(v).some((x) => typeof x === "string");
}

function parseEntry(v: unknown): RegistryEntry | null {
  if (!isRecord(v)) return null;
  if (typeof v.id !== "string" || v.id.length === 0) return null;
  if (typeof v.repo !== "string" || v.repo.length === 0) return null;
  if (typeof v.version !== "string" || v.version.length === 0) return null;
  if (!isText(v.name) || !isText(v.description)) return null;
  const e: RegistryEntry = {
    id: v.id,
    name: v.name,
    version: v.version,
    description: v.description,
    repo: v.repo,
  };
  if (typeof v.author === "string" && v.author.length > 0) e.author = v.author;
  if (typeof v.branch === "string" && v.branch.length > 0) e.branch = v.branch;
  if (Array.isArray(v.commands) && v.commands.every((c) => typeof c === "string"))
    e.commands = v.commands as string[];
  return e;
}

// 외부(빌드 스냅샷 / 원격 fetch) JSON → 검증된 Registry. spec 불일치·비배열이면 null(전체 거부),
// 개별 엔트리 손상은 스킵(부분 살림 — 한 플러그인 오타가 목록 전체를 죽이지 않는다).
export function parseRegistry(raw: unknown): Registry | null {
  if (!isRecord(raw) || raw.spec !== REGISTRY_SPEC || !Array.isArray(raw.plugins)) {
    return null;
  }
  const plugins: RegistryEntry[] = [];
  for (const p of raw.plugins) {
    const e = parseEntry(p);
    if (e) plugins.push(e);
  }
  return { spec: REGISTRY_SPEC, plugins };
}

// 한 레지스트리 엔트리의 설치 상태(리스트 UI 배지·버튼 결정용). installedVersion 은 설치본 버전
// (usePlugins 의 manifest.version), 미설치면 undefined. installedSource 는 설치본 출처(usePlugins 의
// source), 미설치면 undefined.
//  - "available"  : 미설치
//  - "update"     : 설치됨 + 레지스트리 버전이 더 높음(semver)
//  - "installed"  : 설치됨 + 최신(또는 버전 비교 불가, 또는 dev 소스)
export type InstallState = "available" | "installed" | "update";

export function installState(
  entry: RegistryEntry,
  installedVersion?: string,
  installedSource?: "installed" | "dev",
): InstallState {
  if (!installedVersion) return "available";
  // dev 소스: 로컬 워크스페이스가 단일진실. 카탈로그 버전과 무관하게 install/update 권유 금지 —
  // state.update() 가 dev 를 거부하므로(plugins.ts) 레지스트리에 dead 업데이트 버튼을 띄우면 불일치.
  // dev 설치본은 "설치됨" 섹션에서 dev 배지로 노출되고, 레지스트리 actionable 목록에선 빠진다.
  if (installedSource === "dev") return "installed";
  // 레지스트리 버전 ≥ 설치본이면서 같지 않음 = 업데이트 있음. 비교 불가(형식 불량)면 installed 로 보수.
  if (entry.version !== installedVersion) {
    const newer = semverGte(entry.version, installedVersion);
    if (newer === true) return "update";
  }
  return "installed";
}

// 원격 fetch 결과를 빌드 스냅샷에 대해 채택. 원격이 valid(parse 성공)면 원격이 진실(교체),
// 실패(null)면 스냅샷 유지 — 오프라인/손상에도 목록이 사라지지 않는다.
export function mergeRegistry(snapshot: Registry, remoteRaw: unknown): Registry {
  return parseRegistry(remoteRaw) ?? snapshot;
}

// 설치본 id 가 공식 레지스트리에 등재됐나(출처 구분 — "설치됨" 섹션 배지). 등재=공식, 미등재=수동/
// 서드파티(또는 옛 id 잔재). 미등재 설치본도 정상 — 출처만 구분하고 제거를 강제하지 않는다.
export function isOfficial(entries: RegistryEntry[], id: string): boolean {
  return entries.some((e) => e.id === id);
}
