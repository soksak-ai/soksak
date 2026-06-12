// 프로젝트 루트 규칙 — 새 프로젝트 모달과 project.create 명령이 공유하는
// 단일진실: 폴더 미지정 시 ~/soksak/<id> 를 생성해 루트로 쓴다. 이름은
// 디렉토리명 계약이므로 자유 별칭이 아니라 id(영문 슬러그)다. 기본 루트가
// 절대 홈(~)이 아닌 이유: 루트 초기화 정책 플러그인(git init 등 —
// project.created 이벤트 구독)이 루트 전체를 대상으로 동작하므로 격리
// 폴더여야 한다.

import { invoke } from "@tauri-apps/api/core";

export const PROJECT_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

// ~/soksak/<id> 생성(멱등) 후 절대경로 반환. id 검증은 Rust 가 재확인한다.
export function ensureDefaultWorkspace(id: string): Promise<string> {
  return invoke<string>("ensure_workspace_dir", { id });
}
