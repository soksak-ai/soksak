import { useProgramRegistry } from "../plugins/programRegistry";

// 프로그램 선택 <option> 목록의 단일진실 — 설정/새 프로젝트/프로젝트 설정이
// 공유한다. 항목은 100% 플러그인 등록분(내장 없음 §2.6, 그룹은 optgroup).
// 선택값이 미등록(플러그인 비활성)이면 항목을 추가해 값 유실을 막는다 —
// 동작은 터미널 뷰 폴백 중(아이콘 셋의 lucide 폴백과 동형).
export function ProgramOptions({ current }: { current?: string }) {
  useProgramRegistry((s) => s.version);
  const { programs, order } = useProgramRegistry.getState();

  // select 는 optgroup 1뎁스만 지원 — path 전체("a/b")를 그룹 라벨로 평탄화.
  const flat = order.filter((id) => !programs[id]?.decl.path);
  const groups = new Map<string, string[]>();
  for (const id of order) {
    const g = programs[id]?.decl.path;
    if (!g) continue;
    groups.set(g, [...(groups.get(g) ?? []), id]);
  }
  const known = new Set(order);

  return (
    <>
      {flat.map((id) => (
        <option key={id} value={id}>
          {programs[id].decl.title}
        </option>
      ))}
      {[...groups.entries()].map(([g, ids]) => (
        <optgroup key={g} label={g}>
          {ids.map((id) => (
            <option key={id} value={id}>
              {programs[id].decl.title}
            </option>
          ))}
        </optgroup>
      ))}
      {current && !known.has(current) && (
        <option value={current}>{current} (비활성)</option>
      )}
    </>
  );
}
