// 활동 허브(A1) — 앱에서 일어나는 실행 사실의 단일 스트림(P12 실행 가시성의 본체).
// 공급자는 둘: ① 프론트 이벤트(command.started/finished·turn.ended·view.activated —
// activityFeed.ts) ② 커맨드 레지스트리 execute 계측(registry.ts — 오케스트레이터가 내리는
// 모든 명령이 이 경로다). 소비자는 셋: 오케스트레이터 창(listen "activity"), 소켓 구독
// (events.subscribe — A2), 조회 커맨드(activity.recent).
//
// 구조: Rust 싱글톤 링버퍼(크로스윈도우 단일진실, cap 초과 시 오래된 것 탈락) + 창 무관
// app.emit("activity") 브로드캐스트 + app.data records(core/activity) 영속(retention trim).
// seq 는 단조 증가 — since 커서(재접속 백필)·소비자 읽음 커서(kv 영속)의 기준이므로 앱
// 재시작을 넘어 단조여야 한다: 부트에서 영속 최댓값으로 재개(resume_from). 런마다 0 재시작이면
// 영속 커서가 미래를 가리켜 소비자(낭독 등)가 전면 침묵하는 잠복 결함(실측).

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

const RING_CAP: usize = 2000;
// 구독자 큐 상한 — 느린 소켓 소비자가 발행을 막지 못한다(bounded). 초과 시 오래된 것부터
// 버린다(drop-oldest — 최신이 진실, 유실 구간은 seq gap 으로 드러나 since 백필로 메꾼다).
const SUB_CAP: usize = 256;
// records 영속 상한 — 링보다 넉넉히(재시작 후 recent 백필의 원천).
const PERSIST_CAP: i64 = 5000;
const NS: &str = "core";
const COLL: &str = "activity";
const SCOPE: &str = "app";

pub struct ActivityHub {
    inner: Mutex<HubInner>,
    subs: Mutex<Vec<Arc<Subscriber>>>,
}

struct HubInner {
    ring: VecDeque<Value>,
    seq: u64,
}

/// 소켓 스트리밍 구독자(A2) — bounded 큐 + 알림. 소비는 pop_wait(블로킹, 소켓 쓰기 스레드).
pub struct Subscriber {
    queue: Mutex<VecDeque<Value>>,
    cv: Condvar,
    closed: AtomicBool,
}

impl Subscriber {
    fn push(&self, entry: Value) {
        let mut q = self.queue.lock().unwrap();
        q.push_back(entry);
        while q.len() > SUB_CAP {
            q.pop_front(); // drop-oldest
        }
        self.cv.notify_one();
    }

    /// 다음 항목(블로킹, 주기적 타임아웃으로 closed 재확인). None = 구독 종료.
    pub fn pop_wait(&self) -> Option<Value> {
        let mut q = self.queue.lock().unwrap();
        loop {
            if let Some(v) = q.pop_front() {
                return Some(v);
            }
            if self.closed.load(Ordering::Relaxed) {
                return None;
            }
            let (g, _) = self.cv.wait_timeout(q, Duration::from_secs(1)).unwrap();
            q = g;
        }
    }

    pub fn close(&self) {
        self.closed.store(true, Ordering::Relaxed);
        self.cv.notify_all();
    }
}

impl Default for ActivityHub {
    fn default() -> Self {
        Self {
            inner: Mutex::new(HubInner { ring: VecDeque::new(), seq: 0 }),
            subs: Mutex::new(Vec::new()),
        }
    }
}

impl ActivityHub {
    /// 항목 발행 — seq/ts 를 부여해 링에 넣고 부여된 entry 를 돌려준다(emit/영속은 호출측).
    pub fn push(&self, kind: &str, source: &str, payload: Value) -> Value {
        let mut g = self.inner.lock().unwrap();
        g.seq += 1;
        let entry = json!({
            "seq": g.seq,
            "ts": now_ms(),
            "kind": kind,
            "source": source,
            "payload": payload,
        });
        g.ring.push_back(entry.clone());
        while g.ring.len() > RING_CAP {
            g.ring.pop_front();
        }
        entry
    }

    /// 스트리밍 구독 등록(A2) — 이후 publish 가 이 구독자 큐로도 흐른다. 해지는 unsubscribe.
    pub fn subscribe(&self) -> Arc<Subscriber> {
        let sub = Arc::new(Subscriber {
            queue: Mutex::new(VecDeque::new()),
            cv: Condvar::new(),
            closed: AtomicBool::new(false),
        });
        self.subs.lock().unwrap().push(sub.clone());
        sub
    }

    pub fn unsubscribe(&self, sub: &Arc<Subscriber>) {
        sub.close();
        self.subs.lock().unwrap().retain(|s| !Arc::ptr_eq(s, sub));
    }

    fn fan_out(&self, entry: &Value) {
        for s in self.subs.lock().unwrap().iter() {
            s.push(entry.clone());
        }
    }

    /// seq 재개(부트 1회) — 영속 최댓값 위에서 이어간다(단조 보존, 뒤로는 절대 안 감).
    pub fn resume_from(&self, last: u64) {
        let mut g = self.inner.lock().unwrap();
        if last > g.seq {
            g.seq = last;
        }
    }

    /// since(exclusive) 이후 항목 — 재접속 백필 커서. None = 최신 limit 개.
    pub fn recent(&self, since: Option<u64>, limit: usize) -> Vec<Value> {
        let g = self.inner.lock().unwrap();
        let it = g.ring.iter().filter(|e| {
            since.is_none_or(|s| e.get("seq").and_then(Value::as_u64).unwrap_or(0) > s)
        });
        let v: Vec<Value> = it.cloned().collect();
        let skip = v.len().saturating_sub(limit);
        v.into_iter().skip(skip).collect()
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 발행 본체 — 링 + 전 창 브로드캐스트 + 영속. 프론트(activityFeed·registry 계측)와
/// 코어 내부가 공용하는 단일 진입점.
pub fn publish(app: &AppHandle, kind: &str, source: &str, payload: Value) -> Value {
    let hub = app.state::<ActivityHub>();
    let entry = hub.push(kind, source, payload);
    hub.fan_out(&entry); // 소켓 스트리밍 구독자(A2)
    let _ = app.emit("activity", entry.clone());
    // 영속(retention trim) — 실패는 스트림을 막지 않는다(라이브 우선, 콘솔 보고).
    let st = app.state::<crate::data::DbState>();
    if let Ok(guard) = st.conn.lock() {
        if let Some(conn) = guard.as_ref() {
            let id = entry.get("seq").and_then(Value::as_u64).map(|s| format!("a{s:016}"));
            if let Err(e) = crate::data::store::put(conn, NS, COLL, SCOPE, id, &entry) {
                eprintln!("[activity] 영속 실패: {e}");
            } else {
                let _ = crate::data::store::retention_trim(conn, NS, COLL, SCOPE, PERSIST_CAP);
            }
        }
    }
    entry
}

/// 활동 컬렉션 정의(부트 1회, 멱등) — kind 인덱스(필터 조회).
pub fn init_collection(conn: &rusqlite::Connection) {
    let _ = crate::data::store::define(conn, NS, COLL, &["kind".into(), "seq".into()], &[]);
}

/// 부트 1회 — 영속 최댓값에서 seq 재개(재시작을 넘는 단조). 레코드 없음(신선 설치) = 0 유지.
pub fn resume_seq(app: &AppHandle, conn: &rusqlite::Connection) {
    let last = crate::data::store::query(
        conn,
        NS,
        COLL,
        Some(SCOPE),
        None,
        Some("seq"),
        true,
        Some(1),
        None,
        None,
    )
    .ok()
    .and_then(|rows| rows.first().and_then(|e| e.get("seq").and_then(Value::as_u64)))
    .unwrap_or(0);
    app.state::<ActivityHub>().resume_from(last);
}

// 프론트 공급자 진입점 — activityFeed.ts / registry.ts 계측이 invoke.
#[tauri::command]
pub fn activity_publish(
    app: AppHandle,
    kind: String,
    source: String,
    payload: Value,
) -> Value {
    publish(&app, &kind, &source, payload)
}

// 조회 — activity.recent 커맨드 핸들러(창 무관 단일진실이라 어느 창에서 물어도 같다).
#[tauri::command]
pub fn activity_recent(app: AppHandle, since: Option<u64>, limit: Option<usize>) -> Vec<Value> {
    app.state::<ActivityHub>().recent(since, limit.unwrap_or(200).min(RING_CAP))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seq_monotonic_and_ring_trims() {
        let hub = ActivityHub::default();
        for i in 0..(RING_CAP + 50) {
            let e = hub.push("t", "test", json!({ "i": i }));
            assert_eq!(e["seq"].as_u64().unwrap(), (i + 1) as u64);
        }
        let g = hub.inner.lock().unwrap();
        assert_eq!(g.ring.len(), RING_CAP);
        // 앞이 잘리고 뒤가 남는다(오래된 것 탈락).
        assert_eq!(g.ring.front().unwrap()["seq"].as_u64().unwrap(), 51);
    }

    #[test]
    fn resume_keeps_seq_monotonic_across_restart() {
        let hub = ActivityHub::default();
        hub.resume_from(500); // 부트: 영속 최댓값에서 재개
        let e = hub.push("t", "test", json!({}));
        assert_eq!(e["seq"].as_u64().unwrap(), 501);
        hub.resume_from(10); // 뒤로는 절대 안 감(단조)
        let e = hub.push("t", "test", json!({}));
        assert_eq!(e["seq"].as_u64().unwrap(), 502);
    }

    #[test]
    fn recent_since_cursor_and_limit() {
        let hub = ActivityHub::default();
        for i in 0..10 {
            hub.push("t", "test", json!({ "i": i }));
        }
        // since=7 → 8,9,10
        let v = hub.recent(Some(7), 100);
        assert_eq!(
            v.iter().map(|e| e["seq"].as_u64().unwrap()).collect::<Vec<_>>(),
            vec![8, 9, 10]
        );
        // limit 은 최신 우선(꼬리 유지)
        let v = hub.recent(None, 2);
        assert_eq!(
            v.iter().map(|e| e["seq"].as_u64().unwrap()).collect::<Vec<_>>(),
            vec![9, 10]
        );
    }
}
