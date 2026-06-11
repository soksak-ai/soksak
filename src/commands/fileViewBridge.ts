// 파일 뷰(에디터) 인스턴스의 명령 브리지. FileViewer 가 마운트 시 viewId 로 자기
// save 함수를 등록하고 언마운트 시 해제한다 — editor.save 명령이 이 통로로 저장을
// 트리거한다(컴포넌트 내부 상태를 store 로 끌어내지 않고 기능만 노출하는 최소 결합).

interface FileViewApi {
  save: () => Promise<{ saved: boolean; reason?: string }>;
}

const views = new Map<string, FileViewApi>();

export function registerFileView(viewId: string, api: FileViewApi): () => void {
  views.set(viewId, api);
  return () => {
    if (views.get(viewId) === api) views.delete(viewId);
  };
}

export function saveFileView(
  viewId: string,
): Promise<{ saved: boolean; reason?: string }> | undefined {
  return views.get(viewId)?.save();
}
