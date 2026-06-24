// remote::confirm — 데스크톱 단일 confirm 권위(RULE 0/6, anti-escalation). destructive 원격
// 액션은 **항상** 데스크톱 사람 결정을 기다린다 — 폰이 우회·자가승인·config-off 할 수 없다.
//
// 모델(이벤트-우선, 폴링 0 — RULE 7): serve_connection 이 destructive grant 를 만나면 그 한
// frame 의 응답을 PARK 하고, 데스크톱 사람 결정을 oneshot 으로 **await** 한다(poll loop 아님).
// 데스크톱(웹뷰 모달)은 resolve(request_id, approve) 단 한 곳으로 결정을 oneshot 에 보낸다.
//   - APPROVE  ⇒ serve loop 가 (device, bound_nonce) 에 대한 DesktopConfirmToken 을 **어댑터
//     안에서 직접** 만들고(폰은 절대 못 만든다 — auth.rs 의 private 생성자 경계), 같은 parked
//     grant 를 토큰과 함께 dispatch 한다.
//   - DENY/TIMEOUT ⇒ dispatch 0, 암호화된 "denied" 회신.
//
// 이 모듈은 PendingConfirms 레지스트리만 소유한다 — 어느 transport 위에서도 동일하게 쓰인다
// (RULE 8 무강결합, Tauri 비의존). resolve 는 **데스크톱 전용** 진입점: 폰이 보낼 수 있는 어떤
// frame/메시지도 resolve 를 호출하지 못한다(serve_connection 은 phone frame 을 resolve 로 라우팅
// 하는 경로가 없다). list_pending 은 데스크톱 UI/감사용(RULE 8 노출).
//
// TTL: 미해결 confirm 은 created_at + ttl 후 만료된다 — serve loop 의 select! timeout 이
// AUTO-DENY 하고(matrix "confirm timeout→미실행"), expire_due/resolve 는 만료분을 unknown 취급
// 한다(stale resolve 가 다른 request 를 건드리지 못함).
#![allow(dead_code)]

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use tokio::sync::oneshot;

/// 데스크톱 사람 결정 — 승인 또는 거부. timeout 은 별도 경로(serve loop 의 select!)에서
/// AUTO-DENY 로 환원되므로 여기엔 명시 변형이 없다(거부와 동치).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConfirmDecision {
    /// 데스크톱 사용자가 승인 — serve loop 가 토큰을 만들어 dispatch.
    Approve,
    /// 데스크톱 사용자가 거부 — dispatch 0.
    Deny,
}

impl ConfirmDecision {
    pub fn approved(self) -> bool {
        matches!(self, ConfirmDecision::Approve)
    }
}

/// 데스크톱 모달/감사가 보는 한 건의 미해결 confirm 요약. 평문 토큰/키는 없다 — 표시 정보만.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingSummary {
    /// 이 confirm 의 불투명 식별자 — resolve 의 키.
    pub request_id: u64,
    /// 어느 원격 기기의 요청인가(표시/감사).
    pub device_id: String,
    /// 사람이 읽을 명령 요약(예: "panel.close"). dispatch 로 가는 raw 바이트가 아니라 표시용.
    pub command: String,
    /// 등록 시각(Unix secs) — TTL 만료 계산 기준.
    pub created_at: u64,
}

/// 한 건의 parked confirm 의 내부 레코드 — oneshot 송신 끝 + 요약 + 만료시각.
struct PendingEntry {
    /// 결정을 serve loop 로 보낼 oneshot 송신 끝. resolve 가 1회 소비한다.
    tx: oneshot::Sender<ConfirmDecision>,
    device_id: String,
    command: String,
    created_at: u64,
    /// created_at + ttl. now >= expires_at 이면 만료(unknown 취급, AUTO-DENY).
    expires_at: u64,
}

/// parked destructive confirm 레지스트리 — request_id ↔ oneshot 송신 끝.
///
/// 단일 권위(데스크톱). 폰은 park 도 resolve 도 호출하지 않는다 — serve loop(park) 와
/// 데스크톱 glue(resolve) 만 접근한다. Clone 은 Arc 공유(여러 연결/Tauri glue 가 한 권위).
#[derive(Clone)]
pub struct PendingConfirms {
    inner: Arc<Mutex<Inner>>,
    /// confirm 의 수명(초). park 시 created_at + ttl_secs 로 만료시각을 박는다.
    ttl_secs: u64,
}

struct Inner {
    /// request_id ↔ 미해결 entry.
    pending: HashMap<u64, PendingEntry>,
    /// 단조 증가 request_id 발급기(충돌 0). 절대 재사용 안 함(stale resolve 격리).
    next_id: u64,
}

impl PendingConfirms {
    /// 주어진 TTL(초)로 빈 레지스트리 생성. ttl=0 은 즉시 만료(테스트/안전 기본 회피용).
    pub fn new(ttl_secs: u64) -> Self {
        PendingConfirms {
            inner: Arc::new(Mutex::new(Inner {
                pending: HashMap::new(),
                next_id: 1,
            })),
            ttl_secs,
        }
    }

    /// destructive frame 을 park 한다 — 새 request_id 발급 + oneshot 채널 생성. 송신 끝은
    /// 레지스트리에 보관(resolve 가 깨운다), 수신 끝은 serve loop 가 await 한다.
    ///
    /// `now` = 등록 시각(Unix secs) — TTL 만료 기준(호출자가 같은 시계를 쓴다). 반환된
    /// Receiver 는 serve loop 의 select! 한 팔; 다른 팔은 timeout(AUTO-DENY).
    pub fn park(
        &self,
        device_id: &str,
        command: &str,
        now: u64,
    ) -> (u64, oneshot::Receiver<ConfirmDecision>) {
        let (tx, rx) = oneshot::channel();
        let mut inner = self.inner.lock().expect("pending confirms mutex poisoned");
        let request_id = inner.next_id;
        inner.next_id += 1; // 절대 재사용 0 — stale resolve 가 새 request 를 못 건드림.
        inner.pending.insert(
            request_id,
            PendingEntry {
                tx,
                device_id: device_id.to_string(),
                command: command.to_string(),
                created_at: now,
                expires_at: now.saturating_add(self.ttl_secs),
            },
        );
        (request_id, rx)
    }

    /// 데스크톱 권위 진입점 — request_id 에 대한 사람 결정을 oneshot 으로 보낸다.
    ///
    /// 반환: 결정이 전달됐으면 true. request_id 가 미상/이미 해결됨/만료/수신측이 사라짐
    /// (serve loop 가 timeout 으로 떠남)이면 false. **폰은 이 함수에 닿을 경로가 없다** —
    /// serve_connection 은 phone frame 을 resolve 로 라우팅하지 않는다(데스크톱 전용).
    ///
    /// resolve 는 entry 를 **소비**한다(remove) — 중복 resolve 두 번째는 false(idempotent 경계).
    pub fn resolve(&self, request_id: u64, approve: bool) -> bool {
        let mut inner = self.inner.lock().expect("pending confirms mutex poisoned");
        let entry = match inner.pending.remove(&request_id) {
            Some(e) => e,
            None => return false, // 미상/이미 해결/만료 — 조용히 false(stale resolve 무해).
        };
        let decision = if approve {
            ConfirmDecision::Approve
        } else {
            ConfirmDecision::Deny
        };
        // send 는 수신측이 살아있을 때만 Ok. serve loop 가 timeout 으로 이미 떠났으면 Err
        // (그 경우 AUTO-DENY 가 이미 적용됨 — 우리는 false 를 돌려 "전달 안 됨" 보고).
        entry.tx.send(decision).is_ok()
    }

    /// TTL 만료분을 제거한다 — now >= expires_at 인 entry 를 드롭(송신 끝 drop ⇒ 수신측이
    /// RecvError 로 깨어 AUTO-DENY). serve loop 의 timeout 이 1차 방어지만, 외부 호출자가
    /// 주기적으로(또는 resolve 시점에) 호출해 stale entry 누수를 막을 수 있다.
    ///
    /// 반환: 제거된 만료 entry 수. 폴링 아님(상태 갱신은 serve loop 의 oneshot 이 주도) —
    /// 단지 누수 청소(가용성).
    pub fn expire_due(&self, now: u64) -> usize {
        let mut inner = self.inner.lock().expect("pending confirms mutex poisoned");
        let expired: Vec<u64> = inner
            .pending
            .iter()
            .filter(|(_, e)| now >= e.expires_at)
            .map(|(id, _)| *id)
            .collect();
        for id in &expired {
            inner.pending.remove(id); // tx drop ⇒ 수신측 RecvError ⇒ AUTO-DENY.
        }
        expired.len()
    }

    /// 미해결 confirm 들의 요약(데스크톱 UI/감사 — RULE 8 노출). request_id 오름차순.
    /// 평문 토큰/키 0 — 표시 정보만(device_id/command/created_at).
    pub fn list_pending(&self) -> Vec<PendingSummary> {
        let inner = self.inner.lock().expect("pending confirms mutex poisoned");
        let mut out: Vec<PendingSummary> = inner
            .pending
            .iter()
            .map(|(id, e)| PendingSummary {
                request_id: *id,
                device_id: e.device_id.clone(),
                command: e.command.clone(),
                created_at: e.created_at,
            })
            .collect();
        out.sort_by_key(|s| s.request_id);
        out
    }

    /// 현재 미해결 건수(테스트/감사).
    pub fn pending_count(&self) -> usize {
        self.inner
            .lock()
            .expect("pending confirms mutex poisoned")
            .pending
            .len()
    }

    /// 설정된 TTL(초).
    pub fn ttl_secs(&self) -> u64 {
        self.ttl_secs
    }
}

#[cfg(test)]
mod tests;
