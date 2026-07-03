// 활동 허브(A1) — 앱에서 일어나는 실행 사실의 단일 스트림(P12 실행 가시성의 본체).
// 공급자는 둘: ① 프론트 이벤트(command.started/finished·turn.ended·view.activated —
// activityFeed.ts) ② 커맨드 레지스트리 execute 계측(registry.ts — 오케스트레이터가 내리는
// 모든 명령이 이 경로다). 소비자는 셋: 오케스트레이터 창(listen "activity"), 소켓 구독
// (events.subscribe — A2), 조회 커맨드(activity.recent).
//
// 구조: Rust 싱글톤 링버퍼(크로스윈도우 단일진실, cap 초과 시 오래된 것 탈락) + 창 무관
// app.emit("activity") 브로드캐스트 + app.data records(core/activity) 영속(retention trim).
// seq 는 단조 증가 — since 커서(재접속 백필)의 기준. ts 는 epoch ms.

use std::collections::VecDeque;
use std::sync::Mutex;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

const RING_CAP: usize = 2000;
// records 영속 상한 — 링보다 넉넉히(재시작 후 recent 백필의 원천).
const PERSIST_CAP: i64 = 5000;
const NS: &str = "core";
const COLL: &str = "activity";
const SCOPE: &str = "app";

pub struct ActivityHub {
    inner: Mutex<HubInner>,
}

struct HubInner {
    ring: VecDeque<Value>,
    seq: u64,
}

impl Default for ActivityHub {
    fn default() -> Self {
        Self { inner: Mutex::new(HubInner { ring: VecDeque::new(), seq: 0 }) }
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
