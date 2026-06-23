// 원격 confirm **dev 전용** mock 트리거 — 라이브 폰/페어링 없이 RemoteConfirmModal 을 띄워 시각
// 검증(window.snapshot)을 가능케 한다. import.meta.env.DEV 게이트로 **개발 빌드에서만** 설치되고,
// 프로덕션 번들(DEV=false)에선 no-op(아무 전역도 안 단다 — 무발자국).
//
// 안전: 이건 표현층 큐에 mock 요청을 **넣기만** 한다 — Rust 권위(remote::confirm)를 건드리지 않는다.
// Approve/Deny 를 눌러도 sink 가 mock request_id 로 remote_confirm_resolve 를 부르는데, Rust 엔 그
// pending 이 없어 false(무해). 즉 dev 트리거는 모달 **표시**만 흉내내고 실행 권위엔 0 영향(폰 우회
// 경로가 아니다 — 데스크톱 dev 콘솔에서만 도달).
import { useRemoteConfirm, type RemoteConfirmRequest } from "./remoteConfirm";

// window.__soksakMockRemoteConfirm 의 타입(선택 인자로 표시값 덮어쓰기).
type MockFn = (overrides?: Partial<RemoteConfirmRequest>) => void;

declare global {
  interface Window {
    __soksakMockRemoteConfirm?: MockFn;
  }
}

let nextMockId = 900000; // Rust request_id(1부터)와 겹치지 않게 높은 대역 — mock 임이 분명.

// 앱 부팅 1회 호출 — DEV 면 window.__soksakMockRemoteConfirm 을 설치, 아니면 no-op. 반환 = 해지 함수.
export function installRemoteConfirmDevTrigger(): () => void {
  if (!import.meta.env.DEV) return () => {};
  if (typeof window === "undefined") return () => {};

  const mock: MockFn = (overrides) => {
    const req: RemoteConfirmRequest = {
      request_id: nextMockId++,
      device_id: "iPhone-mock-7F3A",
      command: "panel.close",
      params: '{ "side": "left" }',
      danger: true,
      ttl_secs: 120,
      ...overrides,
    };
    useRemoteConfirm.getState().enqueue(req);
  };

  window.__soksakMockRemoteConfirm = mock;
  return () => {
    if (window.__soksakMockRemoteConfirm === mock) {
      delete window.__soksakMockRemoteConfirm;
    }
  };
}
