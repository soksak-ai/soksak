// webview 렌더러 프로세스 종료(process-gone) 감지·복구의 서킷 브레이커 — 순수 코어.
//
// [R1 동기] 핀 tauri rev(a370f653)의 tauri-runtime-wry(lib.rs:5022-5049)는 앱이
// on_web_content_process_terminate 핸들러를 등록하지 않으면 macOS 에서 무조건·무한·무고지
// 자동 reload 기본 핸들러를 설치한다. 이 모듈이 그 자리를 명시 브레이커로 대체한다.
//
// 상태기계(per-label): Closed → Recovering(n) → Open.
// - 지수 백오프 250·500·1000ms(고정 지연 금지).
// - 롤링 60s 윈도우 상한 3회 — 4번째 크래시에 Open(자동 복구 중단, 수동 복구 유도).
// - 모든 판정은 now(ms) 주입 순수 함수 — 시계·스레드·webview 없이 단위검증한다.
// - 로드 성공은 윈도우를 리셋하지 않는다: 크래시 루프는 매 사이클 정상 렌더 후 죽으므로
//   로드 기준 리셋이면 브레이커가 영원히 안 열린다. 윈도우 축소는 자연 만료만.
//
// 분류기: "기록 여부"(records_crash)와 "복구 여부"(recoverable)는 별개 순수 함수다.
// - expected-teardown(의도된 reload·창/뷰 닫기 파괴 계약 진행 중) = 크래시가 아니다 —
//   consume-on-read 1회 마킹 + 만료(스테일 마크가 뒤늦은 실크래시를 삼키지 않게).
// - 무결성/기동 실패 = 기록하되 재시도하지 않는다(재시도 = 무한 루프). WKWebView 는
//   종료 사유를 주지 않으므로 사유는 Option — None 은 "사유 미제공"이며 복구 대상이다.

use std::collections::VecDeque;

/// 지수 백오프(ms) — attempt 1·2·3 이 각각 250·500·1000.
pub const BACKOFF_MS: [u64; 3] = [250, 500, 1000];
/// 롤링 윈도우 폭(ms).
pub const WINDOW_MS: u64 = 60_000;
/// 윈도우 내 자동 복구 상한 — 초과(4번째)에 Open.
pub const WINDOW_CAP: usize = 3;
/// expected-teardown 마크 유효기간(ms) — 닫기/의도된 reload 가 terminate 를 안 내면
/// 마크가 썩는데, 그 스테일 마크가 다음 실크래시를 삼키지 않도록 여기서 만료된다.
pub const EXPECTED_TEARDOWN_MS: u64 = 5_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BreakerState {
    /// 정상 — 복구 진행 없음.
    Closed,
    /// n번째 자동 복구가 예약/진행 중(n = 윈도우 내 크래시 수, 1..=WINDOW_CAP).
    Recovering(u32),
    /// 상한 소진 또는 복구 불가 사유 — 자동 복구 중단(수동 recover 만).
    Open,
}

/// 종료 사유 — WKWebView(macOS)는 사유를 주지 않으므로 항상 None 으로 들어온다.
/// Windows(ProcessFailed kind)·Linux(web-process-terminated 사유 3종) 배선 시 채워진다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TerminateReason {
    /// 렌더러 크래시(일반) — 복구 대상.
    Crash,
    /// OS 가 죽임(메모리 압박 등) — 복구 대상.
    Killed,
    /// 무결성 실패 — 재시도해도 같은 이유로 죽는다: 기록만, 복구 제외.
    IntegrityFailure,
    /// 기동 실패(프로세스가 뜨지 못함) — 재시도 = 무한 루프: 기록만, 복구 제외.
    BootFailure,
}

impl TerminateReason {
    pub fn as_str(&self) -> &'static str {
        match self {
            TerminateReason::Crash => "crash",
            TerminateReason::Killed => "killed",
            TerminateReason::IntegrityFailure => "integrity-failure",
            TerminateReason::BootFailure => "boot-failure",
        }
    }
}

/// terminate 1건에 대한 판정 결과 — 배선부는 이 값만 보고 행동한다(행동/판정 분리).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    /// 의도된 파괴/reload 진행 중 — 크래시가 아니다(기록도 복구도 없음).
    ExpectedTeardown,
    /// n번째 자동 복구 — delay_ms 후 제자리 reload.
    Recover { attempt: u32, delay_ms: u64 },
    /// 윈도우 상한 소진 — Open 진입(자동 복구 중단).
    Exhausted { crashes_in_window: usize },
    /// 복구 불가 사유 — 기록만 하고 Open(재시도 금지).
    NoRecover { reason: TerminateReason },
}

// ── 분류기(순수) ─────────────────────────────────────────────────────────────

/// 이 terminate 를 크래시로 "기록"하는가 — expected-teardown 만 제외한다.
pub fn records_crash(expected_teardown_active: bool) -> bool {
    !expected_teardown_active
}

/// 이 사유가 자동 "복구" 대상인가 — 무결성/기동 실패만 제외. None(사유 미제공)은 복구 대상.
pub fn recoverable(reason: Option<TerminateReason>) -> bool {
    !matches!(
        reason,
        Some(TerminateReason::IntegrityFailure) | Some(TerminateReason::BootFailure)
    )
}

// ── per-label 브레이커(순수 상태기계) ────────────────────────────────────────

#[derive(Debug, Default)]
pub struct LabelBreaker {
    state: BreakerState,
    /// 롤링 윈도우 내 크래시 시각(ms) — 자연 만료만 제거한다(로드 성공 리셋 금지).
    crash_times: VecDeque<u64>,
    /// 수명 누적 크래시 수(reset 에도 보존 — 텔레메트리).
    total_crashes: u64,
    last_crash_ms: Option<u64>,
    last_reason: Option<TerminateReason>,
    /// expected-teardown 마크 만료 시각(consume-on-read 1회).
    expected_teardown_until: Option<u64>,
}

impl Default for BreakerState {
    fn default() -> Self {
        BreakerState::Closed
    }
}

impl LabelBreaker {
    /// 윈도우 자연 만료 — now-WINDOW_MS 이전 크래시를 버린다.
    fn prune(&mut self, now_ms: u64) {
        let cutoff = now_ms.saturating_sub(WINDOW_MS);
        while self.crash_times.front().is_some_and(|t| *t < cutoff) {
            self.crash_times.pop_front();
        }
    }

    /// 의도된 파괴/reload 를 예고한다 — 다음 terminate 1건(EXPECTED_TEARDOWN_MS 내)을
    /// 크래시로 오분류하지 않는다.
    pub fn mark_expected_teardown(&mut self, now_ms: u64) {
        self.expected_teardown_until = Some(now_ms + EXPECTED_TEARDOWN_MS);
    }

    /// terminate 1건 판정 — 기록(records_crash)과 복구(recoverable)를 분류기로 가른다.
    pub fn on_terminate(&mut self, now_ms: u64, reason: Option<TerminateReason>) -> Decision {
        // consume-on-read: 마크는 유효하든 만료됐든 1회 소거된다(스테일 잔존 금지).
        if let Some(until) = self.expected_teardown_until.take() {
            let mark_active = now_ms < until;
            if !records_crash(mark_active) {
                return Decision::ExpectedTeardown;
            }
        }
        self.prune(now_ms);
        self.total_crashes += 1;
        self.last_crash_ms = Some(now_ms);
        self.last_reason = reason;
        self.crash_times.push_back(now_ms);
        if !recoverable(reason) {
            self.state = BreakerState::Open;
            return Decision::NoRecover {
                reason: reason.expect("복구 불가 판정은 사유 있는 경우만"),
            };
        }
        let n = self.crash_times.len();
        if n > WINDOW_CAP {
            self.state = BreakerState::Open;
            return Decision::Exhausted {
                crashes_in_window: n,
            };
        }
        self.state = BreakerState::Recovering(n as u32);
        Decision::Recover {
            attempt: n as u32,
            delay_ms: BACKOFF_MS[n - 1],
        }
    }

    /// 로드 성공 — Recovering/Open → Closed. 윈도우는 절대 리셋하지 않는다(자연 만료만).
    /// Recovering 에서 닫혔으면 그 attempt 를 돌려준다(복구 완료 고지용).
    pub fn on_load_finished(&mut self) -> Option<u32> {
        match self.state {
            BreakerState::Recovering(n) => {
                self.state = BreakerState::Closed;
                Some(n)
            }
            BreakerState::Open | BreakerState::Closed => {
                self.state = BreakerState::Closed;
                None
            }
        }
    }

    /// 수동 복구(webview.recover) — 상태·윈도우·사유·마크를 전부 지운다.
    /// total_crashes 는 수명 텔레메트리라 보존.
    pub fn reset(&mut self) {
        self.state = BreakerState::Closed;
        self.crash_times.clear();
        self.last_crash_ms = None;
        self.last_reason = None;
        self.expected_teardown_until = None;
    }

    pub fn state(&self) -> BreakerState {
        self.state
    }

    /// 윈도우 내 크래시 수(now 기준 자연 만료 반영).
    pub fn crashes_in_window(&self, now_ms: u64) -> usize {
        let cutoff = now_ms.saturating_sub(WINDOW_MS);
        self.crash_times.iter().filter(|t| **t >= cutoff).count()
    }

    pub fn total_crashes(&self) -> u64 {
        self.total_crashes
    }

    pub fn last_crash_ms(&self) -> Option<u64> {
        self.last_crash_ms
    }

    pub fn last_reason(&self) -> Option<TerminateReason> {
        self.last_reason
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── 분류기 ──────────────────────────────────────────────────────────────

    #[test]
    fn classifier_records_and_recovery_are_separate() {
        // 기록: expected-teardown 만 제외.
        assert!(records_crash(false));
        assert!(!records_crash(true));
        // 복구: 사유 미제공(None)·일반 크래시·킬은 복구, 무결성/기동 실패는 제외.
        assert!(recoverable(None));
        assert!(recoverable(Some(TerminateReason::Crash)));
        assert!(recoverable(Some(TerminateReason::Killed)));
        assert!(!recoverable(Some(TerminateReason::IntegrityFailure)));
        assert!(!recoverable(Some(TerminateReason::BootFailure)));
    }

    // ── 백오프 + 상한 초과 → Open ───────────────────────────────────────────

    #[test]
    fn exponential_backoff_then_open_on_cap_exceeded() {
        let mut b = LabelBreaker::default();
        // 1·2·3번째 크래시(60s 윈도우 내) — 지수 백오프로 복구.
        assert_eq!(
            b.on_terminate(1_000, None),
            Decision::Recover { attempt: 1, delay_ms: 250 }
        );
        assert_eq!(b.state(), BreakerState::Recovering(1));
        assert_eq!(
            b.on_terminate(2_000, None),
            Decision::Recover { attempt: 2, delay_ms: 500 }
        );
        assert_eq!(
            b.on_terminate(3_000, None),
            Decision::Recover { attempt: 3, delay_ms: 1000 }
        );
        // 4번째 = 상한 초과 → Open(자동 복구 중단).
        assert_eq!(
            b.on_terminate(4_000, None),
            Decision::Exhausted { crashes_in_window: 4 }
        );
        assert_eq!(b.state(), BreakerState::Open);
        assert_eq!(b.total_crashes(), 4);
    }

    // ── 로드 성공은 윈도우를 리셋하지 않는다 ────────────────────────────────

    #[test]
    fn load_success_does_not_reset_window() {
        let mut b = LabelBreaker::default();
        // 크래시 루프 시나리오: 매 사이클 정상 렌더(로드 성공) 후 다시 죽는다.
        assert!(matches!(b.on_terminate(1_000, None), Decision::Recover { attempt: 1, .. }));
        assert_eq!(b.on_load_finished(), Some(1)); // 복구 완료 → Closed
        assert_eq!(b.state(), BreakerState::Closed);
        assert!(matches!(b.on_terminate(2_000, None), Decision::Recover { attempt: 2, .. }));
        assert_eq!(b.on_load_finished(), Some(2));
        assert!(matches!(b.on_terminate(3_000, None), Decision::Recover { attempt: 3, .. }));
        assert_eq!(b.on_load_finished(), Some(3));
        // 로드 성공이 윈도우를 리셋했다면 여기서 attempt 1 로 영원히 돌았을 것 —
        // 4번째는 Open 이어야 한다.
        assert!(matches!(b.on_terminate(4_000, None), Decision::Exhausted { .. }));
        assert_eq!(b.state(), BreakerState::Open);
    }

    // ── 윈도우 자연 만료 → 복구 재개 ────────────────────────────────────────

    #[test]
    fn window_expiry_resumes_recovery() {
        let mut b = LabelBreaker::default();
        b.on_terminate(1_000, None);
        b.on_terminate(2_000, None);
        b.on_terminate(3_000, None);
        assert!(matches!(b.on_terminate(4_000, None), Decision::Exhausted { .. }));
        assert_eq!(b.state(), BreakerState::Open);
        // 60s 경과 — 이전 크래시가 전부 만료되면 다음 terminate 는 attempt 1 부터 재개.
        let later = 4_000 + WINDOW_MS + 1;
        assert_eq!(
            b.on_terminate(later, None),
            Decision::Recover { attempt: 1, delay_ms: 250 }
        );
        assert_eq!(b.state(), BreakerState::Recovering(1));
        assert_eq!(b.crashes_in_window(later), 1);
        // 수명 누적은 보존된다.
        assert_eq!(b.total_crashes(), 5);
    }

    #[test]
    fn partial_window_expiry_counts_only_recent() {
        let mut b = LabelBreaker::default();
        b.on_terminate(1_000, None); // t=1s — 만료될 것
        b.on_terminate(30_000, None); // t=30s — 잔존
        // t=62s: 1s 크래시는 만료, 30s 는 잔존 → 이번이 윈도우 내 2번째.
        assert_eq!(
            b.on_terminate(62_000, None),
            Decision::Recover { attempt: 2, delay_ms: 500 }
        );
    }

    // ── reset(수동 복구) ─────────────────────────────────────────────────────

    #[test]
    fn reset_clears_window_and_state_but_keeps_total() {
        let mut b = LabelBreaker::default();
        b.on_terminate(1_000, None);
        b.on_terminate(2_000, None);
        b.on_terminate(3_000, None);
        b.on_terminate(4_000, None);
        assert_eq!(b.state(), BreakerState::Open);
        b.reset();
        assert_eq!(b.state(), BreakerState::Closed);
        assert_eq!(b.crashes_in_window(4_000), 0);
        assert_eq!(b.last_crash_ms(), None);
        assert_eq!(b.last_reason(), None);
        assert_eq!(b.total_crashes(), 4); // 수명 텔레메트리 보존
        // reset 직후 크래시는 attempt 1 부터.
        assert_eq!(
            b.on_terminate(5_000, None),
            Decision::Recover { attempt: 1, delay_ms: 250 }
        );
    }

    // ── expected-teardown: consume-on-read 1회 + 만료 ───────────────────────

    #[test]
    fn expected_teardown_consumed_once() {
        let mut b = LabelBreaker::default();
        b.mark_expected_teardown(1_000);
        // 마크 유효 — 크래시로 기록하지 않는다.
        assert_eq!(b.on_terminate(1_500, None), Decision::ExpectedTeardown);
        assert_eq!(b.total_crashes(), 0);
        assert_eq!(b.state(), BreakerState::Closed);
        // 1회 소모됨 — 바로 다음 terminate 는 실크래시.
        assert!(matches!(b.on_terminate(1_600, None), Decision::Recover { attempt: 1, .. }));
        assert_eq!(b.total_crashes(), 1);
    }

    #[test]
    fn stale_expected_teardown_does_not_swallow_crash() {
        let mut b = LabelBreaker::default();
        b.mark_expected_teardown(1_000);
        // 마크가 만료(EXPECTED_TEARDOWN_MS 경과)된 뒤의 terminate 는 실크래시로 기록.
        let late = 1_000 + EXPECTED_TEARDOWN_MS + 1;
        assert!(matches!(b.on_terminate(late, None), Decision::Recover { attempt: 1, .. }));
        assert_eq!(b.total_crashes(), 1);
    }

    // ── 복구 불가 사유: 기록하되 재시도하지 않는다 ──────────────────────────

    #[test]
    fn unrecoverable_reason_records_but_never_retries() {
        let mut b = LabelBreaker::default();
        assert_eq!(
            b.on_terminate(1_000, Some(TerminateReason::BootFailure)),
            Decision::NoRecover { reason: TerminateReason::BootFailure }
        );
        assert_eq!(b.state(), BreakerState::Open);
        assert_eq!(b.total_crashes(), 1);
        assert_eq!(b.last_reason(), Some(TerminateReason::BootFailure));
    }

    // ── Open 상태에서 윈도우 미만료 크래시는 계속 Open ──────────────────────

    #[test]
    fn open_stays_open_within_window() {
        let mut b = LabelBreaker::default();
        for t in [1_000, 2_000, 3_000, 4_000] {
            b.on_terminate(t, None);
        }
        assert_eq!(b.state(), BreakerState::Open);
        assert!(matches!(b.on_terminate(5_000, None), Decision::Exhausted { .. }));
        assert_eq!(b.state(), BreakerState::Open);
    }
}
