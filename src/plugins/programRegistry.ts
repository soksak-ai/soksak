// 프로그램 레지스트리 — 새 탭(+) 메뉴 항목과 동작 spec 의 단일 저장소(§2.6).
// 내장 프로그램은 "terminal" 하나뿐이고, 에이전트/브라우저류는 플러그인이 기여한다.
// 메뉴(ProgramMenu)·설정(기본 프로그램)·명령(view.open program=)이 전부 여기를
// 소비한다 — 프로그램 전용 호출 경로를 만들지 않는다(§0-1).

import { create } from "zustand";
import type { ContributedProgram } from "./spec";

// 프로그램 동작 spec(선언적 — 플러그인 코드가 뷰를 직접 만들지 않는다).
//   kind "terminal": 터미널 뷰 + command 자동 실행(생략 = 맨 터미널).
//   kind "browser": 브라우저 뷰(url 생략 = 홈).
export interface ProgramSpec {
  kind: "terminal" | "browser";
  command?: string; // kind=terminal: 자동 실행할 셸 명령
  url?: string; // kind=browser: 시작 URL
  // kind=terminal 한정 — 선행 바이너리 보장: 미설치면 공식 설치 명령을 그
  // 터미널에서 가시 실행한다(설치 과정 은폐 금지 — 전체신뢰 모델의 정직성).
  ensure?: {
    bin: string; // 사용자 셸 PATH 에서 확인할 실행 파일명
    install: Partial<Record<"darwin" | "linux" | "win32", string>>;
  };
}

export interface RegisteredProgram {
  pluginId: string;
  decl: ContributedProgram; // 매니페스트 선언(표시 정보의 단일진실)
  spec: ProgramSpec;
}

interface ProgramRegistryState {
  programs: Record<string, RegisteredProgram>; // key = 전역 프로그램 id(평탄)
  order: string[]; // 등록 순서(메뉴 표시 순)
  version: number; // 등록/해제마다 증가 — 소비자(UI) 재구성 신호
  register: (
    pluginId: string,
    decl: ContributedProgram,
    spec: ProgramSpec,
  ) => () => void;
}

export const useProgramRegistry = create<ProgramRegistryState>((set, get) => ({
  programs: {},
  order: [],
  version: 0,

  register: (pluginId, decl, spec) => {
    const id = decl.id;
    if (get().programs[id]) {
      // §0-3 침묵 실패 금지 — 전역 id 충돌은 등록 시점 에러.
      throw new Error(`이미 등록된 프로그램: ${id}`);
    }
    if (spec.kind !== "terminal" && spec.kind !== "browser") {
      throw new Error(`프로그램 kind 는 terminal|browser: ${String(spec.kind)}`);
    }
    if (spec.ensure && spec.kind !== "terminal") {
      throw new Error("ensure 는 kind=terminal 프로그램만 가능");
    }
    set((s) => ({
      programs: { ...s.programs, [id]: { pluginId, decl, spec } },
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

// 프로그램의 터미널 자동 실행 명령. ensure 가 있으면 사용자 셸에서 바이너리를
// 확인하고 미설치면 공식 설치 명령을 실행하는 한 줄로 감싼다 — 셸 자체의 PATH
// 기준이라 GUI 앱의 좁은 PATH 문제가 없고, 설치 과정이 터미널에 그대로 보인다.
export function autorunCommandOf(spec: ProgramSpec): string | undefined {
  if (spec.kind !== "terminal") return undefined;
  if (!spec.ensure) return spec.command;
  const plat = navigator.platform.toLowerCase();
  const key = plat.includes("mac")
    ? "darwin"
    : plat.includes("win")
      ? "win32"
      : "linux";
  const install = spec.ensure.install[key];
  if (!install) return spec.command; // 이 플랫폼 설치 명령 미제공 — 그냥 실행
  const bin = spec.ensure.bin;
  const run = spec.command ?? bin;
  if (key === "win32") {
    // PowerShell 문법(Get-Command). 미설치 → 설치 후 재실행 안내.
    return `if (Get-Command ${bin} -ErrorAction SilentlyContinue) { ${run} } else { Write-Host "[soksak] ${bin} 미설치 - 공식 설치를 시작합니다"; ${install}; Write-Host "[soksak] 설치 완료 - 새 탭에서 다시 열어주세요" }`;
  }
  return `if command -v ${bin} >/dev/null 2>&1; then ${run}; else echo "[soksak] ${bin} 미설치 — 공식 설치를 시작합니다"; ${install}; echo "[soksak] 설치 종료 — 새 탭에서 다시 열어주세요"; fi`;
}
