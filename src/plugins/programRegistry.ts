// 프로그램 레지스트리 — 새 탭(+) 메뉴 항목의 단일 저장소(§2.6).
// 프로그램은 완전 선언형(매니페스트 contributes.programs)이라 활성화 시
// loader 가 자동 등록한다 — 명령형 등록 API 는 없다(선언 = 단일진실, 동의
// 화면이 동작 전체를 명령 그대로 고지). 메뉴(ProgramMenu)·설정(기본
// 프로그램)·명령(view.open program=)이 전부 여기를 소비한다(§0-1).

import { create } from "zustand";
import type { ContributedProgram } from "./spec";

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

// 프로그램의 터미널 자동 실행 명령. ensure 가 있으면 사용자 셸에서 바이너리를
// 확인하고 미설치면 공식 설치 명령을 실행하는 한 줄로 감싼다 — 셸 자체의 PATH
// 기준이라 GUI 앱의 좁은 PATH 문제가 없고, 설치 과정이 터미널에 그대로 보인다.
// platform 인자는 테스트 주입용(기본 = 실행 환경 판정).
export function autorunCommandOf(
  decl: ContributedProgram,
  platform: PlatformKey = detectPlatform(),
): string | undefined {
  if (decl.kind !== "terminal") return undefined;
  if (!decl.ensure) return decl.command;
  const install = decl.ensure.install[platform];
  if (!install) return decl.command; // 이 플랫폼 설치 명령 미제공 — 그냥 실행
  const bin = decl.ensure.bin;
  const run = decl.command ?? bin;
  if (platform === "win32") {
    // PowerShell 문법(Get-Command). 미설치 → 설치 후 재실행 안내.
    return `if (Get-Command ${bin} -ErrorAction SilentlyContinue) { ${run} } else { Write-Host "[soksak] ${bin} 미설치 - 공식 설치를 시작합니다"; ${install}; Write-Host "[soksak] 설치 완료 - 새 탭에서 다시 열어주세요" }`;
  }
  return `if command -v ${bin} >/dev/null 2>&1; then ${run}; else echo "[soksak] ${bin} 미설치 — 공식 설치를 시작합니다"; ${install}; echo "[soksak] 설치 종료 — 새 탭에서 다시 열어주세요"; fi`;
}
