// remote::confirm 테스트 — 데스크톱 단일 confirm 권위(park/resolve/TTL/list)의 RED→GREEN.
// 스위트 C("destructive→desktop confirm 요구 / confirm 거부·timeout→미실행") + 매트릭스 행
// "danger 우회(폰)" / "confirm 거부·timeout→미실행" / "도난폰 offline-grace".
//
// 각 테스트: 한 속성을 단언하고 RED(방어 전엔 통과=취약)를 주석에 못박는다. 기준 약화 0 —
// 실패하면 구현을 고친다(RULE 2). serve_connection 위 통합(approve-dispatch / deny·timeout-no-
// dispatch / phone-cannot-self-approve)은 transport/tests.rs 가 진짜 소켓으로 추가 검증한다.

use super::*;

// ===========================================================================
// park/resolve — 데스크톱 결정이 oneshot 으로 정확히 전달된다(이벤트-우선).
// ===========================================================================

#[tokio::test]
async fn park_then_resolve_approve_delivers_decision_on_oneshot() {
    // park ⇒ (request_id, rx). resolve(approve=true) ⇒ rx 가 Approve 를 즉시(폴링 0) 받는다.
    // RED(방어 전): resolve 가 oneshot 에 안 보내면 rx 가 영원히 pending(hang). GREEN: 즉시 Approve.
    let confirms = PendingConfirms::new(60);
    let (id, rx) = confirms.park("phone", "panel.close", 100);
    assert_eq!(confirms.pending_count(), 1, "park 후 미해결 1건");

    let delivered = confirms.resolve(id, true);
    assert!(delivered, "resolve 가 살아있는 수신측에 전달");
    let decision = rx.await.expect("oneshot 수신");
    assert_eq!(decision, ConfirmDecision::Approve, "Approve 결정 전달");
    assert_eq!(confirms.pending_count(), 0, "resolve 가 entry 소비(remove)");
}

#[tokio::test]
async fn park_then_resolve_deny_delivers_deny() {
    // resolve(approve=false) ⇒ rx 가 Deny. dispatch 0 의 권위 신호(serve loop 가 finish_denied).
    let confirms = PendingConfirms::new(60);
    let (id, rx) = confirms.park("phone", "rm -rf", 100);
    assert!(confirms.resolve(id, false), "deny 전달");
    assert_eq!(rx.await.unwrap(), ConfirmDecision::Deny, "Deny 결정");
}

// ===========================================================================
// 미상/중복 resolve — stale resolve 가 다른 request 를 건드리지 못한다(idempotent 경계).
// ===========================================================================

#[tokio::test]
async fn resolve_unknown_request_id_returns_false_no_effect() {
    // 미상 request_id 를 resolve ⇒ false(noop). RED: 미상 id 가 임의 entry 를 건드리면 위험.
    let confirms = PendingConfirms::new(60);
    let (id, _rx) = confirms.park("phone", "panel.close", 100);
    assert!(!confirms.resolve(id + 999, true), "미상 id ⇒ false");
    assert_eq!(confirms.pending_count(), 1, "미상 resolve 는 기존 entry 무영향");
}

#[tokio::test]
async fn double_resolve_second_is_false() {
    // 같은 request_id 를 두 번 resolve ⇒ 두 번째 false(entry 가 첫 resolve 에서 소비됨).
    // RED: entry 가 remove 안 되면 두 번째 resolve 가 또 send(이미 떠난 수신측에 패닉/중복).
    let confirms = PendingConfirms::new(60);
    let (id, rx) = confirms.park("phone", "panel.close", 100);
    assert!(confirms.resolve(id, true), "첫 resolve true");
    assert!(!confirms.resolve(id, true), "둘째 resolve false(이미 소비)");
    assert_eq!(rx.await.unwrap(), ConfirmDecision::Approve);
}

// ===========================================================================
// TTL/만료 — 미해결 confirm 은 AUTO-DENY(matrix "confirm timeout→미실행").
// ===========================================================================

#[tokio::test]
async fn expire_due_drops_stale_and_wakes_receiver_as_denied() {
    // park(created_at=100, ttl=10) ⇒ expires_at=110. expire_due(now=110) 가 만료분 제거.
    // 송신 끝 drop ⇒ 수신측이 RecvError 로 깨어남(serve loop 가 AUTO-DENY 로 환원). RED: 만료
    // 청소가 없으면 미해결 confirm 이 영구 누수(또는 stale resolve 로 늦은 dispatch).
    let confirms = PendingConfirms::new(10);
    let (_id, rx) = confirms.park("phone", "panel.close", 100);
    let removed = confirms.expire_due(110);
    assert_eq!(removed, 1, "만료 1건 제거");
    assert_eq!(confirms.pending_count(), 0, "만료 후 미해결 0");
    // 송신 끝 drop ⇒ 수신은 Err(serve loop 가 이걸 Deny 로 본다).
    assert!(rx.await.is_err(), "만료 ⇒ 수신측 RecvError(AUTO-DENY)");
}

#[tokio::test]
async fn expire_due_keeps_unexpired() {
    // 아직 안 만료된 건(now < expires_at)은 남는다 — 너무 일찍 죽이지 않는다.
    let confirms = PendingConfirms::new(60);
    let (_id, _rx) = confirms.park("phone", "panel.close", 100);
    assert_eq!(confirms.expire_due(120), 0, "120 < 160 ⇒ 미만료(제거 0)");
    assert_eq!(confirms.pending_count(), 1, "미만료 entry 유지");
}

#[tokio::test]
async fn resolve_after_expire_is_false() {
    // 만료 청소된 뒤 resolve ⇒ false(stale resolve 가 dispatch 를 못 되살림 — anti-escalation).
    // RED: 만료 후에도 resolve 가 true 면 timeout 이후 늦은 승인이 destructive 를 실행.
    let confirms = PendingConfirms::new(5);
    let (id, _rx) = confirms.park("phone", "rm -rf", 100);
    confirms.expire_due(105); // 만료(105 >= 105).
    assert!(!confirms.resolve(id, true), "만료 후 resolve ⇒ false(늦은 승인 무력)");
}

// ===========================================================================
// request_id 단조 — 재사용 0(stale resolve 격리).
// ===========================================================================

#[tokio::test]
async fn request_ids_are_monotonic_never_reused() {
    // 연속 park 는 서로 다른 단조 증가 id. resolve 한 id 도 재사용 안 됨. RED: id 재사용이면
    // 한 confirm 의 stale resolve 가 다른 confirm 을 승인(교차오염).
    let confirms = PendingConfirms::new(60);
    let (id1, rx1) = confirms.park("phone", "a", 100);
    let (id2, _rx2) = confirms.park("phone", "b", 100);
    assert!(id2 > id1, "단조 증가");
    confirms.resolve(id1, true);
    let _ = rx1.await;
    let (id3, _rx3) = confirms.park("phone", "c", 100);
    assert!(id3 > id2, "해결된 id 도 재사용 0");
    assert_ne!(id3, id1, "id3 != id1(재사용 0)");
}

// ===========================================================================
// list_pending — 데스크톱 UI/감사 노출(RULE 8). 평문 토큰/키 0.
// ===========================================================================

#[tokio::test]
async fn list_pending_exposes_summaries_sorted_no_secrets() {
    // 미해결 confirm 들을 request_id 오름차순 요약으로 노출(데스크톱 모달). device/command/
    // created_at 만 — 토큰/키 필드 0(타입에 secret 없음, 컴파일이 보증).
    let confirms = PendingConfirms::new(60);
    let (id_a, _ra) = confirms.park("phone-a", "panel.close", 100);
    let (id_b, _rb) = confirms.park("phone-b", "tab.close", 101);
    let list = confirms.list_pending();
    assert_eq!(list.len(), 2);
    assert_eq!(list[0].request_id, id_a, "오름차순(a 먼저)");
    assert_eq!(list[0].device_id, "phone-a");
    assert_eq!(list[0].command, "panel.close");
    assert_eq!(list[0].created_at, 100);
    assert_eq!(list[1].request_id, id_b);
    assert_eq!(list[1].command, "tab.close");
}

#[tokio::test]
async fn resolved_confirm_leaves_list_pending() {
    // resolve 후 그 건은 list_pending 에서 사라진다(소비됨).
    let confirms = PendingConfirms::new(60);
    let (id, rx) = confirms.park("phone", "panel.close", 100);
    confirms.resolve(id, true);
    let _ = rx.await;
    assert!(confirms.list_pending().is_empty(), "해결 후 목록 비어 있음");
}

// ===========================================================================
// 폰은 resolve 경로 없음 — resolve 는 데스크톱 전용 권위(구조적 단언).
// ===========================================================================

#[tokio::test]
async fn phone_has_no_resolve_path_resolve_is_desktop_only_surface() {
    // 폰은 PendingConfirms 핸들도, request_id 도 받지 못한다 — park 가 돌려주는 (id, rx) 는
    // serve loop(데스크톱 측)만 본다. 이 테스트는 "resolve 는 PendingConfirms 를 가진 자만
    // 호출 가능" 이라는 권위 경계를 못박는다: 폰 frame 에는 PendingConfirms 가 없으므로 resolve
    // 호출 자체가 불가능하다. (와이어 레벨 "폰이 resolve frame 위조 불가" 는 transport/tests
    // 의 phone_cannot_self_approve 가 추가 단언.)
    //
    // RED(개념): 만약 resolve 가 phone frame 에서 도달 가능한 표면(예: 특정 request 바이트)이면
    // 폰이 자가승인. GREEN: resolve 는 PendingConfirms 메서드 — 데스크톱 glue(remote_confirm_
    // resolve)만 그 핸들을 쥔다. dispatch 콜백/request 바이트에는 PendingConfirms 가 없다.
    let confirms = PendingConfirms::new(60);
    let (id, _rx) = confirms.park("phone", "rm -rf", 100);
    // 데스크톱(이 핸들 보유자)만 resolve 가능. 폰이 쥘 수 있는 어떤 값(request_id 추정)으로도
    // 핸들 없이는 resolve 를 호출할 수 없다 — 여기서는 핸들 보유 = 데스크톱 권위임을 단언.
    assert_eq!(confirms.pending_count(), 1);
    assert!(confirms.resolve(id, false), "데스크톱(핸들 보유)만 resolve");
}
