// 범용 스케줄러 capability(app.schedule) — "절대 시각 `at` 에 registry 명령 `command`(params)를 한 번
// 발화한다." 단 하나의 개념만 갖는다. 반복·간격·리마인더 같은 정책은 호출자(스케줄링 플러그인, JS·Date
// 보유)가 조합한다 — 반복은 발화 후 재무장, 리마인더는 예약된 notify.show. 코어는 타이밍 프리미티브만
// (R: 단일 개념·관심사 분리). 발화는 CmdBridge(ipc::request_command)로 프론트 registry 에 위임한다.
//
// 발화 스레드는 다음 due 까지 정확히 잔다(고정 간격 폴링 아님 — R3). 새 일정/취소는 Condvar 로 스레드를
// 깨워 재계산한다. 단발이므로 발화한 일정은 제거한다(반복은 호출자가 schedule.set 으로 재무장).
//
// 영속은 코어가 갖지 않는다 — 플러그인이 자기 일정(예: runbook schedule 명령 레코드)을 app.data 에
// 보관하고 activate 시 재무장한다. 그래서 코어 스케줄러는 인메모리 타이머다(재시작 후 플러그인이 채움).

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

#[derive(Clone, serde::Serialize)]
pub struct Schedule {
    pub id: String,
    pub at: u64,         // 절대 ms 발화 시각.
    pub command: String, // registry 명령 이름.
    pub params: Value,
}

#[derive(Default)]
struct Inner {
    items: HashMap<String, Schedule>,
    seq: u64,
    started: bool,
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

// 순수 — now 기준 발화 대상 id 들 + 다음 due 시각(없으면 None). 스레드가 이 결과로 발화·대기 시간을 정한다.
// (HashMap 순서 무관 — 호출자가 id 집합으로 처리.)
fn select_due(items: &HashMap<String, Schedule>, now: u64) -> (Vec<String>, Option<u64>) {
    let fire: Vec<String> = items
        .values()
        .filter(|s| s.at <= now)
        .map(|s| s.id.clone())
        .collect();
    let next = items.values().filter(|s| s.at > now).map(|s| s.at).min();
    (fire, next)
}

impl ScheduleState {
    fn set(&self, id: Option<String>, at: u64, command: String, params: Value) -> String {
        let mut inner = self.inner.lock().unwrap();
        let id = id.unwrap_or_else(|| {
            inner.seq += 1;
            format!("sch-{}", inner.seq)
        });
        inner.items.insert(
            id.clone(),
            Schedule {
                id: id.clone(),
                at,
                command,
                params,
            },
        );
        drop(inner);
        self.cv.notify_all(); // 새 일정 → 스레드 재계산(더 이른 due 일 수 있음).
        id
    }

    fn cancel(&self, id: &str) -> bool {
        let mut inner = self.inner.lock().unwrap();
        let removed = inner.items.remove(id).is_some();
        drop(inner);
        if removed {
            self.cv.notify_all();
        }
        removed
    }

    fn list(&self) -> Vec<Schedule> {
        let inner = self.inner.lock().unwrap();
        let mut v: Vec<Schedule> = inner.items.values().cloned().collect();
        v.sort_by_key(|s| s.at);
        v
    }
}

// 발화 스레드 1회 기동(lazy — 첫 schedule.set 에서). 다음 due 까지 자고, 도달분을 락 밖에서 발화한다.
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
        let due: Vec<Schedule> = {
            let state = app.state::<ScheduleState>();
            let mut inner = state.inner.lock().unwrap();
            loop {
                let now = now_ms();
                let (fire_ids, next) = select_due(&inner.items, now);
                if !fire_ids.is_empty() {
                    break fire_ids.iter().filter_map(|id| inner.items.remove(id)).collect();
                }
                // 다음 due 까지 대기(없으면 60s 캡 — 주기적 재평가). 1ms 하한(busy-wait 방지).
                let wait = match next {
                    Some(at) => Duration::from_millis(at.saturating_sub(now).clamp(1, 60_000)),
                    None => Duration::from_secs(60),
                };
                let (g, _timeout) = state.cv.wait_timeout(inner, wait).unwrap();
                inner = g;
            }
        };
        // 락 밖에서 발화 — request_command 는 프론트 응답까지 블록(이 스레드만 영향).
        for s in due {
            let _ = ipc::request_command(&app, s.command, s.params, 30_000);
        }
    });
}

#[tauri::command]
pub fn schedule_set(
    app: AppHandle,
    state: State<ScheduleState>,
    at: u64,
    command: String,
    params: Option<Value>,
    id: Option<String>,
) -> Result<String, String> {
    if command.is_empty() {
        return Err("command 필요".into());
    }
    ensure_started(&app);
    Ok(state.set(id, at, command, params.unwrap_or(Value::Object(Default::default()))))
}

#[tauri::command]
pub fn schedule_cancel(state: State<ScheduleState>, id: String) -> Result<bool, String> {
    Ok(state.cancel(&id))
}

#[tauri::command]
pub fn schedule_list(state: State<ScheduleState>) -> Result<Vec<Schedule>, String> {
    Ok(state.list())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sched(id: &str, at: u64) -> Schedule {
        Schedule {
            id: id.into(),
            at,
            command: "x".into(),
            params: json!({}),
        }
    }

    fn map(items: Vec<Schedule>) -> HashMap<String, Schedule> {
        items.into_iter().map(|s| (s.id.clone(), s)).collect()
    }

    // (a) now 이하만 발화 대상, 미래 최소가 next.
    #[test]
    fn select_due_splits_past_and_future() {
        let items = map(vec![sched("a", 100), sched("b", 200), sched("c", 300)]);
        let (fire, next) = select_due(&items, 200);
        assert_eq!(fire.len(), 2); // a(100), b(200) 발화(<=now)
        assert!(fire.contains(&"a".to_string()) && fire.contains(&"b".to_string()));
        assert_eq!(next, Some(300)); // 다음 due = c
    }

    // (b) 전부 미래면 발화 0, next = 최소.
    #[test]
    fn select_due_all_future() {
        let items = map(vec![sched("a", 500), sched("b", 800)]);
        let (fire, next) = select_due(&items, 100);
        assert!(fire.is_empty());
        assert_eq!(next, Some(500));
    }

    // (c) 비어있으면 발화 0, next None.
    #[test]
    fn select_due_empty() {
        let (fire, next) = select_due(&HashMap::new(), 100);
        assert!(fire.is_empty());
        assert_eq!(next, None);
    }

    // (d) set → id 발급·조회, cancel → 제거. list 는 at 오름차순.
    #[test]
    fn set_list_cancel() {
        let st = ScheduleState::default();
        let id1 = st.set(None, 300, "cmd1".into(), json!({})); // 자동 id
        let _id2 = st.set(Some("fixed".into()), 100, "cmd2".into(), json!({"k": 1}));
        let list = st.list();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].at, 100); // 오름차순
        assert_eq!(list[0].id, "fixed");
        assert!(st.cancel(&id1));
        assert!(!st.cancel(&id1)); // 이미 없음
        assert_eq!(st.list().len(), 1);
    }
}
