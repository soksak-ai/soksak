// term.* 의 단일 pane 해석 경로 — 전부 PTY substrate(ptyObservationStore)로 해석한다.
// 코어는 터미널 뷰를 소유하지 않는다(터미널도 플러그인 뷰) — 따라서 term.read/send/exec/cwd 는
// app.pty 로 구동되는 플러그인 터미널에만 닿는다(코어 락인 0). paneId 키 = 플러그인 터미널의 view.id
// (registerIo(viewId)). 같은 키로 IO(읽기/쓰기)와 관찰(cwd)이 묶인다.
//
// [불변식] paneId 하나당 producer 는 하나(substrate IO). 명시 pane 이 관찰을 가지면 그 pane,
// 아니면 컨텍스트(활성 체인의 터미널 뷰)를 substrate 술어로 찾는다.

import {
  getObservedCwd,
  getPtyIo,
  hasPtyObservation,
} from "../terminal/ptyObservationStore";
import type { CommandContext } from "./registry";

// 해석된 터미널 대상 — paneId + substrate IO.
export interface TermTarget {
  paneId: string;
  /** 화면+스크롤백 텍스트(끝에서 lines 줄). 준비 안 됐으면 undefined. */
  readBuffer: (lines?: number) => string | undefined;
  /** PTY 에 raw 입력 주입. 준비 안 됐으면 false. */
  sendInput: (data: string) => boolean;
  /** 현재 작업 디렉토리(셸 통합 OSC). 미확인이면 undefined. */
  getCwd: () => string | undefined;
}

// 컨텍스트(활성 체인) 기반 터미널 pane 해석기 — 명시 pane 이 없을 때 쓴다. catalog 가
// sessions+substrate 술어로 구현해 주입한다(순환 import 회피). null 이면 컨텍스트에 터미널 없음.
export type ContextResolve = (
  params: Record<string, unknown>,
  ctx: CommandContext,
) => { paneId: string } | null;

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
 * term.* 의 대상 pane 을 단일 경로로 해석한다(전부 substrate).
 *   1) 명시 pane 이 substrate 관찰을 가지면(hasPtyObservation) 그 pane.
 *   2) 명시 pane 이 없으면 contextResolve(활성 체인의 터미널 뷰)로 찾는다.
 * 둘 다 아니면 null(→ 호출처가 TARGET_NOT_FOUND).
 *
 * contextResolve 생략(단위 테스트 등) 시 명시 pane 경로만 시도한다.
 */
export function resolveTermPane(
  params: Record<string, unknown>,
  ctx: CommandContext,
  contextResolve?: ContextResolve,
): TermTarget | null {
  const explicit = params.pane as string | undefined;
  if (explicit) {
    return hasPtyObservation(explicit) ? substrateTarget(explicit) : null;
  }
  const ctxPane = contextResolve?.(params, ctx);
  if (ctxPane && hasPtyObservation(ctxPane.paneId)) {
    return substrateTarget(ctxPane.paneId);
  }
  return null;
}
