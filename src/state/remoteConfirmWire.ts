// 원격 confirm 배선(이벤트-우선, 폴링 0 — RULE 7) — 모달의 결정을 remote.confirm 커맨드의 await 로
// 잇는다. 코어가 remote-iroh 사이드카에서 분리된 뒤: confirm 권위(PendingConfirms·토큰)는 사이드카에
// 있고, 코어는 사람 모달만 렌더한다. 사이드카가 소켓으로 `remote.confirm` 을 부르면 그 핸들러가 요청을
// 큐에 넣고 사람 결정을 await 한다(catalogRemote). 모달의 resolve/deny 가 sink 로 (request_id, approve)
// 를 보내면 이 배선이 deliverDecision 으로 그 await 를 깨운다 — 사이드카는 회신받은 결정으로 자신의
// PendingConfirms 를 resolve 한다.
//
// 권위 경계: 결정은 이 데스크톱 사람 모달에서만 나간다(폰은 닿을 경로 0). 이 배선이 끊겨도 destructive
// 는 실행되지 않는다 — remote.confirm 핸들러의 TTL 이 무결정을 Deny 로 환원하고(fail-closed), 토큰/실행
// 권위는 전적으로 사이드카 floor(remote::*)에 있다.
import { useRemoteConfirm, deliverDecision } from "./remoteConfirm";

// 앱 부팅 1회 호출 — 결정 sink(→ remote.confirm await 해소) 주입. 반환 = 해지 함수(언마운트 정리).
export function wireRemoteConfirm(): () => void {
  // 결정 sink — 데스크톱 단일 진입점. 모달 resolve(approve/deny)가 (request_id, approve)를 보내면
  // 대기 중인 remote.confirm 핸들러의 await 를 깨운다(미상/이미 해결이면 deliverDecision 이 무해 no-op).
  useRemoteConfirm.getState().setSink((requestId, approve) => {
    deliverDecision(requestId, approve);
  });

  return () => {
    useRemoteConfirm.getState().setSink(null);
  };
}
