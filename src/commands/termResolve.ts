// term.* 의 단일 pane 해석 경로 — 코어 터미널 호스트(host-div) 우선, 없으면 PTY substrate
// (플러그인 터미널) 폴백. 코어 터미널 뷰와 플러그인 터미널(app.pty 구동)이 같은 paneId 키로
// 공존하므로, term.read/send/exec/cwd 가 둘 다에 닿게 한다(코어 락인 0).
//
// [불변식] paneId 하나당 producer 는 하나(코어 host-div 또는 substrate IO). 따라서 코어 호스트가
// 그 pane 을 알면 코어 경로, 모르면 substrate 경로 — 분기는 배타적이고 이중 발화가 없다.
// 코어 호스트가 있는 동안 코어 동작은 기존과 100% 동일(host-div readBuffer/sendInput).

import {
  getCwdOfHost,
  readHostBuffer,
  sendInputToHost,
} from "../terminal/paneHosts";
import {
  getObservedCwd,
  getPtyIo,
  hasPtyObservation,
} from "../terminal/ptyObservationStore";
import type { CommandContext } from "./registry";

// 해석된 터미널 대상 — paneId + 통합 IO(코어/substrate 어느 쪽이든 동일 인터페이스).
export interface TermTarget {
  paneId: string;
  /** 화면+스크롤백 텍스트(끝에서 lines 줄). 준비 안 됐으면 undefined. */
  readBuffer: (lines?: number) => string | undefined;
  /** PTY 에 raw 입력 주입. 준비 안 됐으면 false. */
  sendInput: (data: string) => boolean;
  /** 현재 작업 디렉토리(셸 통합 OSC). 미확인이면 undefined. */
  getCwd: () => string | undefined;
}

// 코어 경로(컨텍스트/활성 체인 포함) 해석기 — catalog 의 resolvePane 을 주입한다(순환 import 회피).
// 반환 paneId 는 코어 터미널 pane(host-div 로 IO). null 이면 코어엔 없음.
export type CoreResolve = (
  params: Record<string, unknown>,
  ctx: CommandContext,
) => { paneId: string } | null;

// 코어 host-div 로 IO 하는 대상(기존 term.* 동작 그대로).
function coreTarget(paneId: string): TermTarget {
  return {
    paneId,
    readBuffer: (lines) => readHostBuffer(paneId, lines),
    sendInput: (data) => sendInputToHost(paneId, data),
    getCwd: () => getCwdOfHost(paneId),
  };
}

// substrate(플러그인 터미널 등 app.pty 구동) IO 로 하는 대상.
function substrateTarget(paneId: string): TermTarget {
  return {
    paneId,
    readBuffer: (lines) => getPtyIo(paneId)?.readBuffer(lines),
    sendInput: (data) => {
      const io = getPtyIo(paneId);
      if (!io) return false;
      io.sendInput(data);
      return true;
    },
    getCwd: () => getObservedCwd(paneId),
  };
}

/**
 * term.* 의 대상 pane 을 단일 경로로 해석한다.
 *   1) 코어 경로(coreResolve): 명시 pane(코어 터미널) > 컨텍스트 pane > 활성 체인의 터미널.
 *      찾으면 코어 host-div IO 로 동작(기존과 동일).
 *   2) 폴백: 명시 pane 이 substrate 관찰을 가지면(hasPtyObservation) — 플러그인 터미널 —
 *      substrate IO(getPtyIo/getObservedCwd)로 동작.
 * 둘 다 아니면 null(→ 호출처가 TARGET_NOT_FOUND).
 *
 * coreResolve 생략(단위 테스트 등) 시 substrate 경로만 시도한다.
 */
export function resolveTermPane(
  params: Record<string, unknown>,
  ctx: CommandContext,
  coreResolve?: CoreResolve,
): TermTarget | null {
  const core = coreResolve?.(params, ctx);
  if (core) return coreTarget(core.paneId);

  const explicit = params.pane as string | undefined;
  if (explicit && hasPtyObservation(explicit)) return substrateTarget(explicit);

  return null;
}
