import type { LocalizedText } from "./spec";

// 공식 플러그인 레지스트리 — "설치 가능 목록"의 단일 진실. 각 엔트리는 한 플러그인의 표시용 메타 +
// git 레포 URL(설치 source). 빌드에 스냅샷으로 포함(첫 실행/오프라인), 온라인이면 원격 registry.json
// 으로 갱신. 실제 설치는 repo clone 후 plugin.install → parseManifest 가 엄격 재검증하므로, 여기 검증은
// "목록에 표시 가능한가" 수준(신뢰 경계지만 가벼움 — 손상 엔트리만 스킵, 전체는 살린다).

export const REGISTRY_SPEC = "soksak-registry@1";

export interface RegistryEntry {
  id: string;
  name: LocalizedText;
  description: LocalizedText;
  author?: string;
  repo: string; // git URL — plugin.install 의 source
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
  if (!isText(v.name) || !isText(v.description)) return null;
  const e: RegistryEntry = {
    id: v.id,
    name: v.name,
    description: v.description,
    repo: v.repo,
  };
  if (typeof v.author === "string" && v.author.length > 0) e.author = v.author;
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
