// 범용 스케줄러 capability(app.scheduler) — 모든 플러그인이 공유하는 코어 인프라(칸반 전용 아님:
// 회의 알림 등 타 플러그인도 등록해 쓴다). 한 작업(Job)은 트리거 하나에 registry 명령 하나를 묶는다.
//
// 트리거 종류:
//   At        — 절대 ms 1회 발화(과거면 즉시).
//   Every     — 고정 간격 주기(anchor 격자 기준, 발화 후 자동 re-arm).
//   Cron      — 5필드 cron 주기(UTC 평가, 자동 re-arm).
//   Reconcile — 타이머 없는 순수 이벤트: 등록 시 1회(부팅 스캔) + poke 시(완료 트리거·외부 변화).
//
// 견고성(cron 급):
//   영속    — 시간 기반(At/Every/Cron)만 app.data(SQLite, ns="core", key="schedule:<id>")에 발화
//             '언제'를 보관해 crash 후 복구한다. Reconcile 은 무상태 — 칸반이 단일 진실이라 영속 0,
//             부팅 1회 스캔으로 자연 복구한다.
//   lease   — 한 작업은 자기 자신과 동시에 두 번 돌지 않는다(running 플래그). 발화 중 다음 슬롯/poke 가
//             도착하면 완료까지 미루고 1회로 합친다(coalesce).
//   backoff — 발화 명령이 {"ok":false} 면 지수 backoff 로 재시도(retry.max 까지). 소진 후 정상 일정 복귀.
//
// 발화 스레드는 다음 due 까지 정확히 잔다(고정 간격 폴링 아님). 새 일정/취소/poke 는 Condvar 로 깨워
// 재계산한다. 발화는 락 밖 단명 스레드에서 CmdBridge(ipc::request_command)로 프론트 registry 에 위임해
// 긴 명령이 타이밍 루프를 막지 않게 한다.
//
// 폴링 비선호 — 정공법(sleep-until-due·완료 트리거·이벤트 poke)이 메인이다. 주기 틱/안전망 폴링은 두지
// 않는다(Reconcile 은 watch 유실해도 완료 트리거·부팅 스캔이 복구한다).

use serde_json::Value;
use std::collections::HashMap;
use std::sync::{Condvar, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, State};

use crate::ipc;

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ── 트리거·정책 ──────────────────────────────────────────────────────────────

#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Trigger {
    At { at: u64 },
    Every {
        every_ms: u64,
        #[serde(default)]
        anchor: Option<u64>,
    },
    Cron { expr: String },
    Reconcile,
}

impl Trigger {
    fn is_time_based(&self) -> bool {
        !matches!(self, Trigger::Reconcile)
    }
}

#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Retry {
    pub max: u32,      // 최대 재시도 횟수(0=재시도 없음).
    pub base_ms: u64,  // backoff 기준(첫 재시도 지연).
    pub max_ms: u64,   // backoff 상한.
}

// 등록 명세(영속 직렬화 단위이기도 하다 — 시간 기반만 저장).
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct JobSpec {
    #[serde(default)]
    pub id: Option<String>,
    pub trigger: Trigger,
    pub command: String,
    #[serde(default)]
    pub params: Value,
    #[serde(default)]
    pub retry: Option<Retry>,
    #[serde(default = "default_concurrency")]
    pub concurrency: u32,
    // 발화 1회당 명령 응답 대기 상한(ms). LLM exec(예: GLM 529 복구)은 길게 잡아야 — 너무 짧으면 명령이
    // 아직 도는데 TIMEOUT=실패로 보고 backoff 재시도하다 중복 실행된다. 미지정 시 30s(route 가 [1s,3600s] 클램프).
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

fn default_concurrency() -> u32 {
    1
}

const DEFAULT_TIMEOUT_MS: u64 = 30_000;

// ── 순수 스케줄 계산 ─────────────────────────────────────────────────────────

// recurring 트리거의 `after` 직후 다음 발화 시각. At/Reconcile 은 주기가 없으므로 None.
fn next_after(trigger: &Trigger, after: u64) -> Option<u64> {
    match trigger {
        Trigger::At { .. } => None,
        Trigger::Reconcile => None,
        Trigger::Every { every_ms, anchor } => {
            let e = (*every_ms).max(1);
            let base = anchor.unwrap_or(0);
            if after < base {
                return Some(base);
            }
            let k = (after - base) / e + 1;
            Some(base + k * e)
        }
        Trigger::Cron { expr } => cron::cron_next(expr, after),
    }
}

// 등록 직후 첫 발화 시각. At=그 시각(과거면 즉시), recurring=now 이후 첫 슬롯, Reconcile=None(타이머 없음).
fn first_fire(trigger: &Trigger, now: u64) -> Option<u64> {
    match trigger {
        Trigger::At { at } => Some(*at),
        Trigger::Reconcile => None,
        _ => next_after(trigger, now),
    }
}

// 발화(due=last_due) 후 재무장 시각. At=None(1회), recurring=last_due 이후 다음 슬롯(드리프트 없음),
// Reconcile=None. 실행이 한 주기보다 길었으면 다음 슬롯이 과거라 즉시 1회 catch-up(running 게이트가 중첩 차단).
fn rearm(trigger: &Trigger, last_due: u64) -> Option<u64> {
    next_after(trigger, last_due)
}

// 지수 backoff — attempt 1부터. base*2^(attempt-1), max_ms 상한. 시프트 포화로 overflow 방지.
fn backoff_delay(attempt: u32, base_ms: u64, max_ms: u64) -> u64 {
    let shift = (attempt.saturating_sub(1)).min(20);
    base_ms.saturating_mul(1u64 << shift).min(max_ms)
}

// ── cron 평가(5필드, UTC) ────────────────────────────────────────────────────
mod cron {
    // "분 시 일 월 요일". 표준 Vixie 의미 — 일·요일이 둘 다 제한되면 OR 매칭. 평가는 UTC(결정적·DST 무관).
    pub struct Fields {
        min: u64,  // bit i (0..59)
        hour: u64, // bit i (0..23)
        dom: u64,  // bit i (1..31)
        mon: u64,  // bit i (1..12)
        dow: u64,  // bit i (0..6, 0=일)
        dom_star: bool,
        dow_star: bool,
    }

    // 한 필드를 비트마스크로. "*" | "*/s" | "a" | "a-b" | "a-b/s" 의 콤마 리스트. 범위 밖이면 None.
    fn parse_field(spec: &str, lo: u64, hi: u64) -> Option<(u64, bool)> {
        let mut mask: u64 = 0;
        let mut is_star = false;
        for tok in spec.split(',') {
            let tok = tok.trim();
            if tok.is_empty() {
                return None;
            }
            // step 분리(a-b/s 또는 */s).
            let (range_part, step) = match tok.split_once('/') {
                Some((r, s)) => (r, s.parse::<u64>().ok().filter(|&v| v >= 1)?),
                None => (tok, 1),
            };
            let (start, end) = if range_part == "*" {
                if step == 1 {
                    is_star = true;
                }
                (lo, hi)
            } else if let Some((a, b)) = range_part.split_once('-') {
                (a.parse::<u64>().ok()?, b.parse::<u64>().ok()?)
            } else {
                let v = range_part.parse::<u64>().ok()?;
                (v, v)
            };
            if start < lo || end > hi || start > end {
                return None;
            }
            let mut v = start;
            while v <= end {
                mask |= 1u64 << v;
                v += step;
            }
        }
        if mask == 0 {
            return None;
        }
        Some((mask, is_star))
    }

    pub fn parse(expr: &str) -> Option<Fields> {
        let parts: Vec<&str> = expr.split_whitespace().collect();
        if parts.len() != 5 {
            return None;
        }
        let (min, _) = parse_field(parts[0], 0, 59)?;
        let (hour, _) = parse_field(parts[1], 0, 23)?;
        let (dom, dom_star) = parse_field(parts[2], 1, 31)?;
        let (mon, _) = parse_field(parts[3], 1, 12)?;
        // 요일은 0·7 둘 다 일요일 — 7 비트를 0 으로 접는다.
        let (mut dow, dow_star) = parse_field(parts[4], 0, 7)?;
        if dow & (1 << 7) != 0 {
            dow = (dow & !(1 << 7)) | 1;
        }
        Some(Fields {
            min,
            hour,
            dom,
            mon,
            dow,
            dom_star,
            dow_star,
        })
    }

    // Howard Hinnant civil_from_days — 1970-01-01 기준 일수 → (월, 일). 연도는 불필요.
    fn month_day(days: i64) -> (u32, u32) {
        let z = days + 719_468;
        let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
        let doe = (z - era * 146_097) as u64; // [0,146096]
        let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0,399]
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0,365]
        let mp = (5 * doy + 2) / 153; // [0,11]
        let d = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1,31]
        let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32; // [1,12]
        (m, d)
    }

    // 1970-01-01 = 목(4). 0=일.
    fn weekday(days: i64) -> u32 {
        (((days % 7) + 4).rem_euclid(7)) as u32
    }

    fn day_match(f: &Fields, d: u32, wd: u32) -> bool {
        let dom_hit = (f.dom >> d) & 1 == 1;
        let dow_hit = (f.dow >> wd) & 1 == 1;
        match (f.dom_star, f.dow_star) {
            (true, true) => true,
            (false, true) => dom_hit,
            (true, false) => dow_hit,
            (false, false) => dom_hit || dow_hit, // Vixie OR
        }
    }

    // after_ms 직후(strictly) 다음 발화 ms. 파싱 실패/5년 내 매칭 없음이면 None.
    pub fn cron_next(expr: &str, after_ms: u64) -> Option<u64> {
        let f = parse(expr)?;
        let start_min = after_ms / 60_000 + 1; // 다음 분 경계(엄격히 이후).
        let mut em = start_min as i64;
        let cap = em + 366 * 5 * 24 * 60; // ~5년 상한(불가능 spec 보호).
        while em < cap {
            let days = em.div_euclid(1440);
            let tod = em.rem_euclid(1440);
            let (mo, d) = month_day(days);
            let wd = weekday(days);
            if (f.mon >> mo) & 1 == 0 || !day_match(&f, d, wd) {
                em += 1440 - tod; // 다음 날 00:00 으로 점프.
                continue;
            }
            let h = (tod / 60) as u32;
            if (f.hour >> h) & 1 == 0 {
                em += 60 - (tod % 60); // 다음 시 :00 으로 점프.
                continue;
            }
            let mi = (tod % 60) as u32;
            if (f.min >> mi) & 1 == 1 {
                return Some(em as u64 * 60_000);
            }
            em += 1;
        }
        None
    }
}

// ── Job 상태 ─────────────────────────────────────────────────────────────────

struct Job {
    id: String,
    trigger: Trigger,
    command: String,
    params: Value,
    retry: Option<Retry>,
    concurrency: u32,
    timeout_ms: u64, // 발화 1회당 명령 응답 대기 상한.
    // 런타임:
    next_at: Option<u64>, // 다음 예정 발화(None=대기/완료).
    last_due: u64,        // 마지막으로 claim 된 예정 시각(드리프트 없는 re-arm 기준).
    running: bool,        // lease 보유 중(중첩 차단).
    pending: bool,        // 실행 중 다음 발화 요청 도착(완료 후 1회로 합침).
    attempt: u32,         // 현재 backoff 재시도 회차.
}

// 발화 대상(락 밖 dispatch 용).
#[derive(Clone)]
struct Fire {
    id: String,
    command: String,
    params: Value,
    timeout_ms: u64,
}

// 완료 후 후처리 결과 — removed 면 영속에서도 제거해야 한다(At 1회 종료).
pub struct Completion {
    pub removed: bool,
}

// list 노출 형태 — 트리거·런타임 포함.
#[derive(serde::Serialize)]
pub struct JobView {
    pub id: String,
    pub trigger: Trigger,
    pub command: String,
    pub params: Value,
    pub next_at: Option<u64>,
    pub running: bool,
    pub concurrency: u32,
}

#[derive(Default)]
struct Inner {
    jobs: HashMap<String, Job>,
    seq: u64,
    started: bool,
}

// 다음 깨울 시각 — running 작업은 제외(완료가 notify 로 깨운다). None=대기 중 타이머 없음.
fn earliest_wake(jobs: &HashMap<String, Job>) -> Option<u64> {
    jobs.values()
        .filter(|j| !j.running)
        .filter_map(|j| j.next_at)
        .min()
}

pub struct ScheduleState {
    inner: Mutex<Inner>,
    cv: Condvar,
}

impl Default for ScheduleState {
    fn default() -> Self {
        Self {
            inner: Mutex::new(Inner::default()),
            cv: Condvar::new(),
        }
    }
}

impl ScheduleState {
    // 등록(멱등 — id 지정 시 교체). 첫 발화 시각 계산해 무장. 반환=id. 영속은 호출 명령층이 담당.
    fn register(&self, spec: JobSpec, now: u64) -> String {
        let mut inner = self.inner.lock().unwrap();
        let id = spec.id.unwrap_or_else(|| {
            inner.seq += 1;
            format!("sch-{}", inner.seq)
        });
        let next_at = first_fire(&spec.trigger, now);
        inner.jobs.insert(
            id.clone(),
            Job {
                id: id.clone(),
                trigger: spec.trigger,
                command: spec.command,
                params: spec.params,
                retry: spec.retry,
                concurrency: spec.concurrency.max(1),
                timeout_ms: spec.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS),
                next_at,
                last_due: 0,
                running: false,
                pending: false,
                attempt: 0,
            },
        );
        drop(inner);
        self.cv.notify_all();
        id
    }

    fn cancel(&self, id: &str) -> bool {
        let mut inner = self.inner.lock().unwrap();
        let removed = inner.jobs.remove(id).is_some();
        drop(inner);
        if removed {
            self.cv.notify_all();
        }
        removed
    }

    fn list(&self) -> Vec<JobView> {
        let inner = self.inner.lock().unwrap();
        let mut v: Vec<JobView> = inner
            .jobs
            .values()
            .map(|j| JobView {
                id: j.id.clone(),
                trigger: j.trigger.clone(),
                command: j.command.clone(),
                params: j.params.clone(),
                next_at: j.next_at,
                running: j.running,
                concurrency: j.concurrency,
            })
            .collect();
        // next_at 오름차순(None=뒤). 안정적 표시.
        v.sort_by(|a, b| match (a.next_at, b.next_at) {
            (Some(x), Some(y)) => x.cmp(&y).then(a.id.cmp(&b.id)),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => a.id.cmp(&b.id),
        });
        v
    }

    // 즉시 발화 요청 — id 지정 시 그 작업, 미지정 시 모든 Reconcile 작업. running 이면 pending(완료 후 합침).
    fn poke(&self, id: Option<&str>, now: u64) {
        let mut inner = self.inner.lock().unwrap();
        let mut woke = false;
        for job in inner.jobs.values_mut() {
            let target = match id {
                Some(t) => job.id == t,
                None => matches!(job.trigger, Trigger::Reconcile),
            };
            if !target {
                continue;
            }
            if job.running {
                job.pending = true;
            } else {
                job.next_at = Some(now);
            }
            woke = true;
        }
        drop(inner);
        if woke {
            self.cv.notify_all();
        }
    }

    // due(next_at<=now·!running) 작업을 claim — running 표시, next_at 비움(완료 시 재계산), last_due 기록.
    fn claim_due(&self, now: u64) -> Vec<Fire> {
        let mut inner = self.inner.lock().unwrap();
        let mut fires = vec![];
        for job in inner.jobs.values_mut() {
            if job.running {
                continue;
            }
            if let Some(at) = job.next_at {
                if at <= now {
                    job.running = true;
                    job.last_due = at;
                    job.next_at = None; // 실행 중 재claim 차단(완료에서 재무장).
                    fires.push(Fire {
                        id: job.id.clone(),
                        command: job.command.clone(),
                        params: job.params.clone(),
                        timeout_ms: job.timeout_ms,
                    });
                }
            }
        }
        fires
    }

    // 다음 깨울 시각(테스트 핀) — running 작업 제외 불변식을 고정. park_until_due 와 같은 헬퍼를 쓴다.
    #[cfg(test)]
    fn next_wake(&self, _now: u64) -> Option<u64> {
        earliest_wake(&self.inner.lock().unwrap().jobs)
    }

    // 다음 due 까지 park — due 판정과 wait 를 한 번의 락 보유로 묶어 missed-wakeup 을 막는다(완료/poke/
    // register 는 같은 락으로 next_at 을 세팅하므로, 우리 판정 전이면 즉시 재루프, 후면 notify 가 깨운다).
    // 이미 due 면 즉시 반환(루프가 claim). 타이머 없으면 1시간 캡 후 깬다(notify 가 정상 경로).
    fn park_until_due(&self) {
        let inner = self.inner.lock().unwrap();
        let now = now_ms();
        let any_due = inner
            .jobs
            .values()
            .any(|j| !j.running && j.next_at.is_some_and(|a| a <= now));
        if any_due {
            return;
        }
        let wait = match earliest_wake(&inner.jobs) {
            Some(at) => Duration::from_millis(at.saturating_sub(now).clamp(1, 3_600_000)),
            None => Duration::from_secs(3_600),
        };
        let _ = self.cv.wait_timeout(inner, wait);
    }

    // 발화 완료 후처리 — lease 해제 + 재시도/재무장/coalesce + At 종료 정리.
    fn complete(&self, id: &str, ok: bool, now: u64) -> Completion {
        let mut inner = self.inner.lock().unwrap();
        let Some(job) = inner.jobs.get_mut(id) else {
            return Completion { removed: false };
        };
        job.running = false;
        // 실패 + 재시도 여력 → backoff 재시도 예약(정상 일정 대신 우선).
        if !ok {
            if let Some(retry) = job.retry.clone() {
                if job.attempt < retry.max {
                    job.attempt += 1;
                    let d = backoff_delay(job.attempt, retry.base_ms, retry.max_ms);
                    job.next_at = Some(now + d);
                    drop(inner);
                    self.cv.notify_all();
                    return Completion { removed: false };
                }
            }
        }
        // 성공/재시도 소진 → 재무장(recurring=다음 슬롯, At=None). last_due 기준이라 드리프트 없음.
        job.attempt = 0;
        job.next_at = rearm(&job.trigger, job.last_due);
        // 실행 중 도착한 발화 요청 합침(reconcile poke 등) — 1회로.
        if job.pending {
            job.pending = false;
            job.next_at = Some(now);
        }
        // At 1회 종료(재무장 없음·대기 없음) → 제거(영속도 제거 대상).
        let removed = job.next_at.is_none() && matches!(job.trigger, Trigger::At { .. });
        if removed {
            inner.jobs.remove(id);
        }
        drop(inner);
        self.cv.notify_all();
        Completion { removed }
    }
}

// ── 발화 스레드 ──────────────────────────────────────────────────────────────

// 1회 기동(lazy). due 를 claim→락 밖 단명 스레드에서 발화하고, 다음 wake 까지 Condvar 로 잔다.
pub fn ensure_started(app: &AppHandle) {
    let state = app.state::<ScheduleState>();
    {
        let mut inner = state.inner.lock().unwrap();
        if inner.started {
            return;
        }
        inner.started = true;
    }
    let app = app.clone();
    std::thread::spawn(move || loop {
        let now = now_ms();
        let fires = {
            let st = app.state::<ScheduleState>();
            st.claim_due(now)
        };
        // 락 밖에서 발화 — 각 작업을 단명 스레드로 분리(긴 명령이 루프·서로를 막지 않게). 완료 시 lease 해제.
        for f in fires {
            let app2 = app.clone();
            std::thread::spawn(move || {
                // f.timeout_ms 까지 명령 완료를 기다린다(route 가 [1s,3600s] 클램프). 충분히 길어야 LLM
                // exec 가 도는 동안 lease 가 유지되어 중복 발화가 없다. TIMEOUT/오류는 ok:false → backoff.
                let reply = ipc::request_command(&app2, f.command, f.params, f.timeout_ms);
                let ok = reply.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
                let c = app2.state::<ScheduleState>().complete(&f.id, ok, now_ms());
                if c.removed {
                    persist_delete(&app2, &f.id);
                }
                // 완료가 다음을 깨운다(blockedBy 충족분 reconcile 재평가) — complete 가 이미 notify.
            });
        }
        // 다음 due 까지 park(due 판정+wait 한 락 — missed-wakeup 차단). 발화/완료/poke 가 깨운다.
        app.state::<ScheduleState>().park_until_due();
    });
}

// ── 영속(app.data, ns="core") ────────────────────────────────────────────────

fn persist_key(id: &str) -> String {
    format!("schedule:{id}")
}

// 시간 기반(At/Every/Cron)만 보관 — Reconcile 은 무상태(칸반이 단일 진실).
fn persist_save(app: &AppHandle, spec: &JobSpec) {
    if !spec.trigger.is_time_based() {
        return;
    }
    let Some(id) = spec.id.as_ref() else { return };
    let st = app.state::<crate::data::DbState>();
    let guard = st.conn.lock().unwrap();
    if let Some(conn) = guard.as_ref() {
        if let Ok(v) = serde_json::to_value(spec) {
            let _ = crate::data::store::kv_set(conn, "core", &persist_key(id), &v);
        }
    }
}

fn persist_delete(app: &AppHandle, id: &str) {
    let st = app.state::<crate::data::DbState>();
    let guard = st.conn.lock().unwrap();
    if let Some(conn) = guard.as_ref() {
        let _ = crate::data::store::kv_delete(conn, "core", &persist_key(id));
    }
}

// 부팅/재개 1회 — 영속된 시간 기반 작업을 다시 무장(crash 복구). 과거 At 은 즉시 발화(at-least-once;
// 멱등은 명령이 보장). 무상태 Reconcile 은 플러그인이 activate 시 재등록한다.
pub fn reload_persisted(app: &AppHandle) {
    let specs: Vec<JobSpec> = {
        let st = app.state::<crate::data::DbState>();
        let guard = st.conn.lock().unwrap();
        let Some(conn) = guard.as_ref() else { return };
        let keys = crate::data::store::kv_keys(conn, "core", Some("schedule:")).unwrap_or_default();
        keys.iter()
            .filter_map(|k| crate::data::store::kv_get(conn, "core", k).ok().flatten())
            .filter_map(|v| serde_json::from_value::<JobSpec>(v).ok())
            .collect()
    };
    if specs.is_empty() {
        return;
    }
    let state = app.state::<ScheduleState>();
    let now = now_ms();
    for spec in specs {
        state.register(spec, now);
    }
    ensure_started(app);
}

// ── tauri 명령 ───────────────────────────────────────────────────────────────

// app.scheduler.register — 트리거+명령 등록. 시간 기반은 영속(crash 복구). 반환=id.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn schedule_register(
    app: AppHandle,
    state: State<ScheduleState>,
    trigger: Trigger,
    command: String,
    params: Option<Value>,
    id: Option<String>,
    retry: Option<Retry>,
    concurrency: Option<u32>,
    timeout_ms: Option<u64>,
) -> Result<String, String> {
    if command.is_empty() {
        return Err("command 필요".into());
    }
    let spec = JobSpec {
        id,
        trigger,
        command,
        params: params.unwrap_or(Value::Object(Default::default())),
        retry,
        concurrency: concurrency.unwrap_or(1),
        timeout_ms,
    };
    ensure_started(&app);
    let assigned = state.register(spec.clone(), now_ms());
    let mut saved = spec;
    saved.id = Some(assigned.clone());
    persist_save(&app, &saved);
    Ok(assigned)
}

// app.scheduler — 즉시 발화 요청(완료 트리거·외부 변화). id 미지정 시 모든 Reconcile 작업.
#[tauri::command]
pub fn schedule_poke(state: State<ScheduleState>, id: Option<String>) -> Result<(), String> {
    state.poke(id.as_deref(), now_ms());
    Ok(())
}

#[tauri::command]
pub fn schedule_cancel(
    app: AppHandle,
    state: State<ScheduleState>,
    id: String,
) -> Result<bool, String> {
    let removed = state.cancel(&id);
    persist_delete(&app, &id);
    Ok(removed)
}

#[tauri::command]
pub fn schedule_list(state: State<ScheduleState>) -> Result<Vec<JobView>, String> {
    Ok(state.list())
}

// 하위호환 — schedule.set: 절대 ms 1회(At). register 위의 얇은 shim.
#[tauri::command]
pub fn schedule_set(
    app: AppHandle,
    state: State<ScheduleState>,
    at: u64,
    command: String,
    params: Option<Value>,
    id: Option<String>,
) -> Result<String, String> {
    schedule_register(
        app,
        state,
        Trigger::At { at },
        command,
        params,
        id,
        None,
        None,
        None,
    )
}

// ── 테스트 ───────────────────────────────────────────────────────────────────
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // wire 계약 — JS app.scheduler 가 보내고 kv 가 저장하는 JSON 형태를 정확히 역직렬화한다.
    // (kind 태그 lowercase, every_ms 필드명 그대로.) 깨지면 런타임 발화/복구가 조용히 실패.
    #[test]
    fn trigger_wire_format() {
        let at: Trigger = serde_json::from_value(json!({"kind":"at","at":123})).unwrap();
        assert_eq!(at, Trigger::At { at: 123 });
        let ev: Trigger = serde_json::from_value(json!({"kind":"every","every_ms":1000})).unwrap();
        assert_eq!(ev, Trigger::Every { every_ms: 1000, anchor: None });
        let ev2: Trigger =
            serde_json::from_value(json!({"kind":"every","every_ms":1000,"anchor":50})).unwrap();
        assert_eq!(ev2, Trigger::Every { every_ms: 1000, anchor: Some(50) });
        let cr: Trigger = serde_json::from_value(json!({"kind":"cron","expr":"0 0 * * *"})).unwrap();
        assert_eq!(cr, Trigger::Cron { expr: "0 0 * * *".into() });
        let rc: Trigger = serde_json::from_value(json!({"kind":"reconcile"})).unwrap();
        assert_eq!(rc, Trigger::Reconcile);
    }

    // JobSpec 영속 round-trip — kv 저장(serde_json::to_value) → 로드(from_value) 동일.
    #[test]
    fn jobspec_persist_roundtrip() {
        let s = JobSpec {
            id: Some("sch-1".into()),
            trigger: Trigger::Cron { expr: "*/5 * * * *".into() },
            command: "notify.show".into(),
            params: json!({"title":"틱"}),
            retry: Some(Retry { max: 3, base_ms: 1000, max_ms: 60_000 }),
            concurrency: 2,
            timeout_ms: Some(600_000),
        };
        let v = serde_json::to_value(&s).unwrap();
        let back: JobSpec = serde_json::from_value(v).unwrap();
        assert_eq!(back.id.as_deref(), Some("sch-1"));
        assert_eq!(back.trigger, s.trigger);
        assert_eq!(back.command, "notify.show");
        assert_eq!(back.retry, s.retry);
        assert_eq!(back.concurrency, 2);
        assert_eq!(back.timeout_ms, Some(600_000));
    }

    // 발화 timeout — 미지정 시 30s 기본, 지정 시 그 값이 Fire 로 전달(LLM exec 가 길게 잡는 노브).
    #[test]
    fn fire_carries_timeout() {
        let st = ScheduleState::default();
        st.register(spec(Trigger::At { at: 100 }), 0); // timeout 미지정.
        let f = st.claim_due(150);
        assert_eq!(f[0].timeout_ms, DEFAULT_TIMEOUT_MS); // 기본 30s.

        let st2 = ScheduleState::default();
        let mut s = spec(Trigger::At { at: 100 });
        s.timeout_ms = Some(600_000); // GLM exec 류.
        st2.register(s, 0);
        let f2 = st2.claim_due(150);
        assert_eq!(f2[0].timeout_ms, 600_000);
    }

    // 분=15배수 cron, 에폭 0(=1970-01-01T00:00:00Z, 분0 매칭) 직후 → 분15 = 900000.
    #[test]
    fn cron_every_15min() {
        assert_eq!(cron::cron_next("*/15 * * * *", 0), Some(900_000));
        assert_eq!(cron::cron_next("5 * * * *", 0), Some(300_000));
    }

    // 매일 0시 — 0 직후 다음 자정 = 다음 날(86400000).
    #[test]
    fn cron_daily_midnight() {
        assert_eq!(cron::cron_next("0 0 * * *", 0), Some(86_400_000));
    }

    // 매월 1일 0시 — Jan1 직후 Feb1(31일=2678400000).
    #[test]
    fn cron_first_of_month() {
        assert_eq!(cron::cron_next("0 0 1 * *", 0), Some(2_678_400_000));
    }

    // 월요일 0시 — 1970-01-01(목) 직후 첫 월요일 = Jan5(4일=345600000).
    #[test]
    fn cron_weekday_monday() {
        assert_eq!(cron::cron_next("0 0 * * 1", 0), Some(345_600_000));
    }

    // 일·요일 둘 다 제한 → OR. 13일 또는 금요일 — 0 직후 첫 금요일 Jan2(86400000)가 13일보다 빠름.
    #[test]
    fn cron_dom_dow_or() {
        assert_eq!(cron::cron_next("0 0 13 * 5", 0), Some(86_400_000));
    }

    // 요일 7=일요일(0 으로 접힘) — 1970-01-04 가 첫 일요일(3일=259200000).
    #[test]
    fn cron_sunday_seven() {
        assert_eq!(cron::cron_next("0 0 * * 7", 0), Some(259_200_000));
    }

    // 파싱 실패(필드 수·범위 밖) → None.
    #[test]
    fn cron_invalid() {
        assert_eq!(cron::cron_next("* * *", 0), None);
        assert_eq!(cron::cron_next("60 * * * *", 0), None);
        assert_eq!(cron::cron_next("* 24 * * *", 0), None);
    }

    // Every — anchor 격자 기준 strictly-after.
    #[test]
    fn every_grid() {
        let t = Trigger::Every { every_ms: 1000, anchor: None };
        assert_eq!(next_after(&t, 2500), Some(3000));
        assert_eq!(next_after(&t, 3000), Some(4000)); // 경계는 다음 슬롯.
        let a = Trigger::Every { every_ms: 1000, anchor: Some(5000) };
        assert_eq!(next_after(&a, 0), Some(5000)); // anchor 이전이면 anchor 가 첫 슬롯.
        assert_eq!(next_after(&a, 5000), Some(6000));
    }

    // first_fire/rearm — At 1회, recurring 재무장, Reconcile 타이머 없음.
    #[test]
    fn first_fire_and_rearm() {
        let at = Trigger::At { at: 999 };
        assert_eq!(first_fire(&at, 100), Some(999));
        assert_eq!(rearm(&at, 999), None); // At 은 재무장 없음.

        let ev = Trigger::Every { every_ms: 100, anchor: None };
        assert_eq!(rearm(&ev, 500), Some(600)); // last_due 기준 드리프트 없음.

        let rc = Trigger::Reconcile;
        assert_eq!(first_fire(&rc, 100), None);
        assert_eq!(rearm(&rc, 100), None);
    }

    // backoff — 지수 증가·상한.
    #[test]
    fn backoff_caps() {
        assert_eq!(backoff_delay(1, 1000, 60_000), 1000);
        assert_eq!(backoff_delay(2, 1000, 60_000), 2000);
        assert_eq!(backoff_delay(3, 1000, 60_000), 4000);
        assert_eq!(backoff_delay(7, 1000, 60_000), 60_000); // 64000 → 상한.
        assert_eq!(backoff_delay(99, 1000, 60_000), 60_000); // overflow 없음.
    }

    fn spec(trigger: Trigger) -> JobSpec {
        JobSpec {
            id: None,
            trigger,
            command: "x".into(),
            params: json!({}),
            retry: None,
            concurrency: 1,
            timeout_ms: None,
        }
    }

    // register → id 발급·next_at 무장, list 정렬, cancel 제거.
    #[test]
    fn register_list_cancel() {
        let st = ScheduleState::default();
        let id1 = st.register(spec(Trigger::At { at: 300 }), 0);
        let mut s2 = spec(Trigger::At { at: 100 });
        s2.id = Some("fixed".into());
        st.register(s2, 0);
        let list = st.list();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].id, "fixed"); // next_at 100 먼저.
        assert_eq!(list[0].next_at, Some(100));
        assert!(st.cancel(&id1));
        assert!(!st.cancel(&id1));
        assert_eq!(st.list().len(), 1);
    }

    // At 발화 → 성공 완료 → 제거(removed). lease(claim 중 재claim 0).
    #[test]
    fn at_fires_once_then_removed() {
        let st = ScheduleState::default();
        let id = st.register(spec(Trigger::At { at: 100 }), 0);
        let f1 = st.claim_due(150);
        assert_eq!(f1.len(), 1);
        assert!(st.claim_due(150).is_empty()); // running — 재claim 없음.
        let c = st.complete(&id, true, 200);
        assert!(c.removed);
        assert!(st.list().is_empty());
    }

    // recurring 발화 → 완료 시 다음 슬롯 재무장(드리프트 없음·제거 안 됨).
    #[test]
    fn every_rearms_after_complete() {
        let st = ScheduleState::default();
        let id = st.register(spec(Trigger::Every { every_ms: 100, anchor: Some(0) }), 50);
        // first_fire(now=50) → 다음 슬롯 100.
        assert_eq!(st.list()[0].next_at, Some(100));
        let f = st.claim_due(120);
        assert_eq!(f.len(), 1);
        let c = st.complete(&id, true, 130);
        assert!(!c.removed);
        assert_eq!(st.list()[0].next_at, Some(200)); // last_due(100) 기준 → 200, 130 드리프트 없음.
    }

    // 실패 → backoff 재시도 예약, 소진 후 At 종료.
    #[test]
    fn retry_then_give_up() {
        let st = ScheduleState::default();
        let mut s = spec(Trigger::At { at: 100 });
        s.retry = Some(Retry { max: 1, base_ms: 1000, max_ms: 60_000 });
        let id = st.register(s, 0);
        st.claim_due(150);
        let c1 = st.complete(&id, false, 200); // 1회차 실패 → 재시도.
        assert!(!c1.removed);
        assert_eq!(st.list()[0].next_at, Some(1200)); // 200 + backoff(1)=1000.
        st.claim_due(1300);
        let c2 = st.complete(&id, false, 1400); // 재시도 소진 → 종료.
        assert!(c2.removed);
        assert!(st.list().is_empty());
    }

    // Reconcile — 타이머 없음(next_at None), poke 로 즉시 due. 실행 중 poke 는 pending coalesce.
    #[test]
    fn reconcile_poke_and_coalesce() {
        let st = ScheduleState::default();
        let id = st.register(spec(Trigger::Reconcile), 0);
        assert_eq!(st.list()[0].next_at, None); // 타이머 없음.
        st.poke(None, 500); // 모든 reconcile.
        assert_eq!(st.list()[0].next_at, Some(500));
        let f = st.claim_due(500);
        assert_eq!(f.len(), 1);
        st.poke(Some(&id), 600); // 실행 중 poke → pending.
        assert_eq!(st.list()[0].next_at, None); // 아직 running.
        let c = st.complete(&id, true, 700);
        assert!(!c.removed);
        assert_eq!(st.list()[0].next_at, Some(700)); // pending coalesce → 즉시 재발화.
    }

    // next_wake — running 작업 제외(완료 notify 가 깨움). 대기 작업의 최소 next_at.
    #[test]
    fn next_wake_excludes_running() {
        let st = ScheduleState::default();
        st.register(spec(Trigger::At { at: 1000 }), 0);
        st.register(spec(Trigger::At { at: 500 }), 0);
        assert_eq!(st.next_wake(0), Some(500));
        st.claim_due(500); // id2 running.
        assert_eq!(st.next_wake(600), Some(1000)); // running 제외 → 다음 대기.
    }
}
