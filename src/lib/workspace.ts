// 프로젝트 루트 헌법 — 새 프로젝트 모달·project.create 명령·부트가 공유하는
// 단일진실:
//   P1 루트 필수: 모든 프로젝트는 루트 디렉토리를 가진다(타입 강제 —
//      ProjectTab.root: string). 루트 없는 프로젝트는 존재 불가.
//   P2 금지 루트: 홈(~)과 파일시스템 루트(/)는 프로젝트 루트 불가 — 루트
//      초기화 정책 플러그인(git init 등, project.created 1회)이 루트 전체를
//      대상으로 동작하므로. 하위 디렉토리는 자유.
//   P3 자동 루트: 폴더 미지정 시 ~/.soksak/projects/<폴더명> 생성·사용(앱이
//      만든 폴더는 앱 관리 영역). 첫 프로젝트는 부트 시 projects/project1.
//   P4 정체성 = 루트 경로: 영속 id 필드 없음(이중화 금지). 자동 모드의
//      입력은 만들 "폴더명"(슬러그)일 뿐 저장되지 않는다. 별칭 = 표시명
//      (비면 폴더명 폴백).
//   P5 중복 금지: 같은 루트(정규화 비교)의 프로젝트는 둘일 수 없다 — 중복
//      생성 시도는 기존 프로젝트 활성화 + existing 반환. (창-로컬 가드)
//   P6 전역 단일 오픈: 하나의 루트는 전 창을 통틀어 최대 1곳에만 열린다 —
//      P4(정체성=루트)의 전역 시행. 시행 지점은 코어 레지스트리
//      (project_registry.rs, Rust 싱글톤)가 단일 진실이고, 모든 열기/닫기
//      경로는 projectRegistry.ts 유틸을 지난다. 충돌 시 새로 열지 않고
//      소유 창을 포커스한다. 창 파괴 시 점유는 코어가 해제한다.

import { invoke } from "@tauri-apps/api/core";

export const FOLDER_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

// ~/.soksak/projects/<폴더명> 생성(멱등) 후 절대경로 반환. 검증은 Rust 재확인.
export function ensureDefaultWorkspace(folder: string): Promise<string> {
  return invoke<string>("ensure_workspace_dir", { folder });
}

// P1/P2 검증 + 정규화 경로 반환(P5 중복 비교의 기준). 위반 시 사유로 reject.
export function validateProjectRoot(path: string): Promise<string> {
  return invoke<string>("validate_project_root", { path });
}
