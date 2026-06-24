// 원격 confirm 오케스트레이션(폰-링크 안전모델 — 계획서 "안전 모델"/"폰-링크 보안 모델") — 데스크톱
// 사람 결정의 **표현 상태**만 이 store 가 가진다. 권위는 Rust(remote::confirm)에 있다 — 이 store 는
// 얇은 표현층이고, 결정은 invoke("remote_confirm_resolve", {request_id, approve}) 한 곳으로만 나간다.
//
// 직렬 큐(RULE — Rust serial confirm 큐와 대칭): 여러 destructive 요청이 동시에 와도 사람은 한 번에
// 하나만 결정한다. enqueue 는 요청을 큐에 쌓고, active 는 항상 큐의 머리만 노출한다. resolve(approve)
// 가 머리를 Rust 로 보내고 다음 요청을 승급시킨다. request_id 중복(같은 요청 재emit)은 멱등 무시.
//
// auto-deny 표시(Rust TTL 의 거울): 결정이 없으면 Rust 가 created_at + ttl 후 AUTO-DENY 한다. 이
// store 는 그 TTL 을 사람에게 카운트다운으로 보여줄 뿐 — 실제 차단은 Rust 가 한다(이 타이머가 끊겨도
// destructive 는 절대 실행되지 않는다, Rust 가 단일 권위). 카운트다운이 0 에 닿으면 머리를 큐에서
// 떨어뜨리고(데스크톱 표시 정리) 다음으로 승급한다 — Rust 가 이미 AUTO-DENY 했으므로 resolve 불필요.
import { create } from "zustand";

// Rust app.emit("remote-confirm-request", …) 의 페이로드(transport.rs ConfirmRequest 의 거울).
export interface RemoteConfirmRequest {
  /// resolve 의 키(PendingConfirms 발급). 그대로 remote_confirm_resolve 로 회신한다.
  request_id: number;
  /// 어느 원격 기기의 요청인가(표시/감사).
  device_id: string;
  /// 사람이 읽을 명령 요약(예: "panel.close"). dispatch 바이트가 아니라 표시용.
  command: string;
  /// 항상 true — destructive 만 이 경로에 도달(데스크톱 confirm 필수).
  danger: boolean;
  /// 선택 — 명령 파라미터 요약(표시용). Rust 가 보내면 표시, 없으면 생략.
  params?: string;
  /// 선택 — TTL(초). Rust CONFIRM_TTL_SECS 의 거울(카운트다운 표시용). 없으면 기본값.
  ttl_secs?: number;
}

// resolve 한 결정을 Rust 로 보내는 sink. 실제 앱은 invoke("remote_confirm_resolve", …) 를 넘긴다.
// 테스트는 recorder 를 주입해 Tauri 비의존(순수 큐 로직만 검증).
export type ResolveSink = (requestId: number, approve: boolean) => void;

// 기본 TTL(초) — Rust bridge.rs CONFIRM_TTL_SECS 의 거울. 페이로드에 ttl_secs 가 없을 때만 쓴다.
export const DEFAULT_CONFIRM_TTL_SECS = 120;

interface RemoteConfirmState {
  /// 직렬 큐 — 머리(index 0)만 모달에 노출된다. FIFO(도착 순).
  queue: RemoteConfirmRequest[];
  /// 결정을 Rust 로 보내는 sink. wireRemoteConfirm 이 실제 invoke 를 주입; 미주입 시 no-op.
  sink: ResolveSink | null;
  /// 결정 sink 를 설정(앱 부팅 1회). 테스트는 recorder 를 주입.
  setSink: (sink: ResolveSink | null) => void;
  /// 새 confirm 요청을 큐에 넣는다. 같은 request_id 가 이미 큐에 있으면 멱등 무시(중복 emit 방어).
  enqueue: (req: RemoteConfirmRequest) => void;
  /// 큐 머리를 결정한다 — Rust 로 (request_id, approve) 전송 후 머리를 떨어뜨린다(다음 승급).
  /// 큐가 비었으면 no-op.
  resolve: (approve: boolean) => void;
  /// TTL 만료로 머리를 표시 큐에서 떨어뜨린다(Rust 가 이미 AUTO-DENY — resolve 안 보냄). 다음 승급.
  /// 주어진 request_id 가 현재 머리일 때만 동작(stale 타이머가 새 머리를 못 떨어뜨림).
  expire: (requestId: number) => void;
}

// 현재 모달에 보일 요청(큐 머리). 큐가 비면 null → 모달은 아무것도 렌더 안 함(idle 무발자국).
export function activeRequest(s: RemoteConfirmState): RemoteConfirmRequest | null {
  return s.queue[0] ?? null;
}

export const useRemoteConfirm = create<RemoteConfirmState>((set, get) => ({
  queue: [],
  sink: null,

  setSink: (sink) => set({ sink }),

  enqueue: (req) => {
    const q = get().queue;
    // 멱등 — 같은 request_id 재emit(재연결/중복 브로드캐스트)은 큐를 부풀리지 않는다.
    if (q.some((r) => r.request_id === req.request_id)) return;
    set({ queue: [...q, req] });
  },

  resolve: (approve) => {
    const q = get().queue;
    const head = q[0];
    if (!head) return; // 큐 빔 — 결정할 게 없다.
    // 권위로 결정 전송(데스크톱 단일 진입점). sink 미주입(테스트 외)이면 조용히 큐만 진행.
    get().sink?.(head.request_id, approve);
    set({ queue: q.slice(1) }); // 머리 떨어뜨림 → 다음 요청 승급.
  },

  expire: (requestId) => {
    const q = get().queue;
    const head = q[0];
    // 현재 머리에 대한 만료만 적용(stale 타이머 격리). Rust 가 이미 AUTO-DENY 했으므로 sink 안 부름.
    if (!head || head.request_id !== requestId) return;
    set({ queue: q.slice(1) });
  },
}));
