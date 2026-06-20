// 파일 뷰어 레지스트리 — 파일을 콘텐츠로 열 때 확장자로 라우팅되는 렌더러의 단일 저장소.
// 엔진 중립(계약 A13): 코어는 매칭·호스팅만 한다. 렌더 엔진(CodeMirror/Monaco/미디어 등)은 전적으로
// 플러그인 소유 — provider.mount 가 컨테이너에 직접 그린다(viewRegistry 와 동형). version 은 UI 재구성 신호.

import { create } from "zustand";
import { qualifiedViewId, type ContributedFileViewer } from "./spec";

// 파일 뷰어가 받는 컨텍스트. 코어가 넘기는 유일한 채널(계약 A2) — 스토어/레이아웃 노출 없음.
export interface FileViewerContext {
  viewId: string; // 이 파일 뷰의 안정 id(인스턴스 키 — 분할/멀티창 구분)
  path: string; // 열 파일 절대경로
  projectId: string;
  root: string | null;
  // 미저장 변경 상태를 코어 탭(dirty 표시)에 보고. 편집 가능한 뷰어만 의미.
  setDirty: (dirty: boolean) => void;
}

// 플러그인이 구현하는 파일 뷰어. React 비요구 — 컨테이너 DOM 에 직접 그린다(PluginViewProvider 와 동형).
export interface FileViewerProvider {
  mount(container: HTMLElement, ctx: FileViewerContext): void;
  unmount?(container: HTMLElement): void;
}

export interface RegisteredFileViewer {
  pluginId: string;
  decl: ContributedFileViewer; // 매니페스트 선언(확장자/priority) — 매칭의 단일진실
  provider: FileViewerProvider;
}

interface FileViewerRegistryState {
  viewers: Record<string, RegisteredFileViewer>; // key = "<pluginId>.<id>"
  version: number; // 등록/해제마다 증가 — 소비자(파일 뷰 호스트) 재평가 신호
  register: (
    pluginId: string,
    decl: ContributedFileViewer,
    provider: FileViewerProvider,
  ) => () => void;
}

export const useFileViewerRegistry = create<FileViewerRegistryState>(
  (set, get) => ({
    viewers: {},
    version: 0,

    register: (pluginId, decl, provider) => {
      const key = qualifiedViewId(pluginId, decl.id);
      if (get().viewers[key]) {
        // §0-3 침묵 실패 금지 — 중복 등록은 버그(해제 없이 재활성화).
        throw new Error(`이미 등록된 파일 뷰어: ${key}`);
      }
      set((s) => ({
        viewers: { ...s.viewers, [key]: { pluginId, decl, provider } },
        version: s.version + 1,
      }));
      return () => {
        set((s) => {
          if (!s.viewers[key]) return s; // 이미 해제됨 — 멱등
          const viewers = { ...s.viewers };
          delete viewers[key];
          return { viewers, version: s.version + 1 };
        });
      };
    },
  }),
);

// 파일명 끝의 확장자(소문자). 'Makefile'/'.zshrc' 처럼 없으면 "".
function extOf(path: string): string {
  const name = path.split("/").pop() ?? path;
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return "";
  return name.slice(dot + 1).toLowerCase();
}

// 등록 순서를 보존하는 후보 정렬(priority desc, 동률은 등록 순서). Object 삽입 순서 = 등록 순서.
function best(
  candidates: RegisteredFileViewer[],
): RegisteredFileViewer | null {
  if (candidates.length === 0) return null;
  return candidates.reduce((a, b) =>
    (b.decl.priority ?? 0) > (a.decl.priority ?? 0) ? b : a,
  );
}

// path 확장자에 맞는 최적 뷰어. 정확 확장자 매칭(priority)이 폴백("*")보다 항상 우선.
// 없으면 null(코어는 "이 파일형 뷰어 없음" 빈 상태를 렌더 — 순수 스켈레톤).
export function resolveFileViewer(path: string): RegisteredFileViewer | null {
  const ext = extOf(path);
  const all = Object.values(useFileViewerRegistry.getState().viewers);
  const exact = all.filter((v) => v.decl.extensions.includes(ext));
  const hit = best(exact);
  if (hit) return hit;
  return best(all.filter((v) => v.decl.extensions.includes("*")));
}
