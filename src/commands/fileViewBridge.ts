// 파일 뷰(에디터) 인스턴스의 명령 브리지. FileViewer 가 마운트 시 viewId 로 자기
// 기능(save/find/replace)을 등록하고 언마운트 시 해제한다 — editor.* 명령이 이 통로로
// 동작한다(컴포넌트 내부 상태를 store 로 끌어내지 않고 기능만 노출하는 최소 결합).

export interface FindOptions {
  caseSensitive?: boolean;
  regexp?: boolean;
  wholeWord?: boolean;
}

interface FileViewApi {
  save: () => Promise<{ saved: boolean; reason?: string }>;
  // 검색 하이라이트 + 첫 매치 선택. 매치 수 반환.
  find: (query: string, opts: FindOptions) => { matches: number };
  // 치환(all=false 면 현재/다음 매치 1건). 치환 건수 반환.
  replace: (
    query: string,
    replacement: string,
    opts: FindOptions & { all?: boolean },
  ) => { replaced: number };
  // 버퍼 읽기/통째 치환(undo 1회 보존) — 플러그인 editor API/포매터 통로.
  // 코드 편집 뷰가 아니거나(미디어) 로딩 전이면 null/false.
  getText?: () => string | null;
  setText?: (text: string) => boolean;
}

const views = new Map<string, FileViewApi>();

export function registerFileView(viewId: string, api: FileViewApi): () => void {
  views.set(viewId, api);
  return () => {
    if (views.get(viewId) === api) views.delete(viewId);
  };
}

export function getFileView(viewId: string): FileViewApi | undefined {
  return views.get(viewId);
}

export function saveFileView(
  viewId: string,
): Promise<{ saved: boolean; reason?: string }> | undefined {
  return views.get(viewId)?.save();
}
