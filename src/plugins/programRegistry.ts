// 프로그램 레지스트리 — 새 탭(+) 메뉴 항목의 단일 저장소(§2.6).
// 프로그램은 완전 선언형(매니페스트 contributes.programs)이라 활성화 시
// loader 가 자동 등록한다 — 명령형 등록 API 는 없다(선언 = 단일진실, 동의
// 화면이 동작 전체를 명령 그대로 고지). 메뉴(ProgramMenu)·설정(기본
// 프로그램)·명령(view.open program=)이 전부 여기를 소비한다(§0-1).

import { create } from "zustand";
import type { ContributedProgram, LibraryDep } from "./spec";

export interface RegisteredProgram {
  pluginId: string;
  decl: ContributedProgram; // 매니페스트 선언 = 표시·동작 정보의 단일진실
}

interface ProgramRegistryState {
  programs: Record<string, RegisteredProgram>; // key = 전역 프로그램 id(평탄)
  order: string[]; // 등록 순서(메뉴 표시 순)
  version: number; // 등록/해제마다 증가 — 소비자(UI) 재구성 신호
  register: (pluginId: string, decl: ContributedProgram) => () => void;
}

export const useProgramRegistry = create<ProgramRegistryState>((set, get) => ({
  programs: {},
  order: [],
  version: 0,

  register: (pluginId, decl) => {
    const id = decl.id;
    if (get().programs[id]) {
      // §0-3 침묵 실패 금지 — 전역 id 충돌은 등록 시점 에러.
      throw new Error(`이미 등록된 프로그램: ${id}`);
    }
    set((s) => ({
      programs: { ...s.programs, [id]: { pluginId, decl } },
      order: [...s.order, id],
      version: s.version + 1,
    }));
    return () => {
      set((s) => {
        if (!s.programs[id]) return s; // 이미 해제됨 — 멱등
        const programs = { ...s.programs };
        delete programs[id];
        return {
          programs,
          order: s.order.filter((x) => x !== id),
          version: s.version + 1,
        };
      });
    };
  },
}));

export function getRegisteredProgram(id: string): RegisteredProgram | null {
  return useProgramRegistry.getState().programs[id] ?? null;
}

// 메뉴/설정 표시용 목록(등록 순서 유지).
export function listPrograms(): RegisteredProgram[] {
  const s = useProgramRegistry.getState();
  return s.order.map((id) => s.programs[id]).filter(Boolean);
}

export type PlatformKey = "darwin" | "linux" | "win32";

// 실행 플랫폼 판정(설치 명령 분기용). platform 이 빈 환경(테스트)은 UA 폴백.
export function detectPlatform(): PlatformKey {
  const s = `${navigator.platform} ${navigator.userAgent}`.toLowerCase();
  if (s.includes("mac")) return "darwin";
  if (s.includes("win")) return "win32";
  return "linux";
}

// 프로그램의 자동 실행 명령 — 실행은 깨끗하게 command 그대로다(래핑 금지).
// 프로그램은 전부 kind:"view"(코어 터미널 제거) — 명령은 연 뷰(터미널 뷰)에 흘러가
// 마운트 시 1회 실행된다. ensure(미설치 시 설치)는 실행 시점이 아니라 **플러그인
// 활성화 시점**에 처리된다(state/plugins.ensureProgramBinaries) — 동의 화면에서
// 설치 명령을 고지받고 "동의하고 활성화"한 그 시점이 설치의 정당한 자리다.
export function autorunCommandOf(
  decl: ContributedProgram,
): string | undefined {
  return decl.command;
}

// 이 플랫폼의 설치 명령(ensure 선언) — 활성화 시점 설치 흐름이 소비.
export function installCommandFor(
  decl: ContributedProgram,
  platform: PlatformKey = detectPlatform(),
): string | undefined {
  return decl.ensure?.install[platform];
}

// 이 플랫폼의 라이브러리 설치 명령(libraries 선언) — 동의 후 강제 설치 흐름이 소비.
// 동의 화면이 이 명령을 원문 그대로 고지하고, 사람이 동의한 그 시점이 설치의 정당한 자리다.
export function libraryInstallFor(
  lib: LibraryDep,
  platform: PlatformKey = detectPlatform(),
): string | undefined {
  return lib.install[platform];
}
