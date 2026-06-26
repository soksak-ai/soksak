// 백업/복원/이식 — 쉬운 백업/복원(사용자 요구). 전체 스냅샷은 VACUUM INTO(단일 .db, WAL 사이드카
// 흡수). 복원은 검증 후 원자 스왑(현재본 안전복사). JSONL export/import 는 네임스페이스 단위 이식용
// (id/doc/scope 보존, created/updated 는 재스탬프 — 정확한 스냅샷은 backup/restore 사용).

use std::path::{Path, PathBuf};

use rusqlite::Connection;
use serde_json::{json, Value};

use super::store;

// VACUUM INTO — 일관된 단일 파일 스냅샷(WAL 체크포인트 포함). 경로는 작은따옴표 이스케이프.
pub fn backup(conn: &Connection, dest: &Path) -> Result<(), String> {
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let p = dest.to_string_lossy().replace('\'', "''");
    conn.execute_batch(&format!("VACUUM INTO '{p}';"))
        .map_err(|e| e.to_string())
}

// 후보 .db 가 우리 스키마의 정상 SQLite 인지 검증(integrity_check + records/kv 존재).
pub fn validate(src: &Path) -> Result<(), String> {
    if !src.is_file() {
        return Err(format!("백업 파일 없음: {}", src.display()));
    }
    let conn = Connection::open(src).map_err(|e| e.to_string())?;
    let ok: String = conn
        .query_row("PRAGMA integrity_check", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    if ok != "ok" {
        return Err(format!("무결성 검사 실패: {ok}"));
    }
    let has: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('records','kv','meta_collections')",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if has < 3 {
        return Err("soksak 데이터 스키마가 아님(records/kv/meta_collections 누락)".to_string());
    }
    Ok(())
}

// 원자 복원 — 검증 → 현재본 안전복사 → 스왑(현재 .db 덮기 + 스테일 WAL 제거). 호출 측에서
// 기존 Connection 을 드롭(파일 잠금 해제·체크포인트)한 뒤 호출해야 한다.
pub fn restore_into(db_path: &Path, src: &Path) -> Result<PathBuf, String> {
    validate(src)?;
    let backup_copy = db_path.with_extension(format!("bak-{}.db", super::now_millis()));
    if db_path.exists() {
        std::fs::copy(db_path, &backup_copy).map_err(|e| e.to_string())?;
    }
    std::fs::copy(src, db_path).map_err(|e| e.to_string())?;
    // 스테일 WAL/SHM 제거(새 본문과 불일치 방지).
    for ext in ["-wal", "-shm"] {
        let side = PathBuf::from(format!("{}{ext}", db_path.to_string_lossy()));
        let _ = std::fs::remove_file(side);
    }
    Ok(backup_copy)
}

// ── JSONL export/import ───────────────────────────────────────────────────────

pub fn export(conn: &Connection, ns: Option<&str>, coll: Option<&str>) -> Result<String, String> {
    let mut lines: Vec<String> = Vec::new();
    let push = |lines: &mut Vec<String>, v: Value| {
        if let Ok(s) = serde_json::to_string(&v) {
            lines.push(s);
        }
    };

    // meta
    {
        let mut sql = String::from("SELECT ns,coll,idx_fields,fts_fields FROM meta_collections");
        let mut conds = Vec::new();
        if ns.is_some() { conds.push("ns=?1"); }
        if coll.is_some() { conds.push(if ns.is_some() { "coll=?2" } else { "coll=?1" }); }
        if !conds.is_empty() { sql.push_str(&format!(" WHERE {}", conds.join(" AND "))); }
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let map = |r: &rusqlite::Row| {
            Ok(json!({
                "kind":"meta","ns":r.get::<_,String>(0)?,"coll":r.get::<_,String>(1)?,
                "idx":serde_json::from_str::<Value>(&r.get::<_,String>(2)?).unwrap_or(json!([])),
                "fts":serde_json::from_str::<Value>(&r.get::<_,String>(3)?).unwrap_or(json!([])),
            }))
        };
        let rows = bind_query(&mut stmt, ns, coll, map)?;
        for v in rows { push(&mut lines, v); }
    }
    // records
    {
        let mut sql = String::from("SELECT ns,coll,scope,id,doc FROM records");
        let mut conds = Vec::new();
        if ns.is_some() { conds.push("ns=?1"); }
        if coll.is_some() { conds.push(if ns.is_some() { "coll=?2" } else { "coll=?1" }); }
        if !conds.is_empty() { sql.push_str(&format!(" WHERE {}", conds.join(" AND "))); }
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let map = |r: &rusqlite::Row| {
            Ok(json!({
                "kind":"record","ns":r.get::<_,String>(0)?,"coll":r.get::<_,String>(1)?,
                "scope":r.get::<_,String>(2)?,"id":r.get::<_,String>(3)?,
                "doc":serde_json::from_str::<Value>(&r.get::<_,String>(4)?).unwrap_or(json!({})),
            }))
        };
        let rows = bind_query(&mut stmt, ns, coll, map)?;
        for v in rows { push(&mut lines, v); }
    }
    // kv (coll 무관 — coll 지정 시 생략)
    if coll.is_none() {
        let mut stmt = conn
            .prepare(if ns.is_some() { "SELECT ns,k,v FROM kv WHERE ns=?1" } else { "SELECT ns,k,v FROM kv" })
            .map_err(|e| e.to_string())?;
        let map = |r: &rusqlite::Row| {
            Ok(json!({
                "kind":"kv","ns":r.get::<_,String>(0)?,"k":r.get::<_,String>(1)?,
                "v":serde_json::from_str::<Value>(&r.get::<_,String>(2)?).unwrap_or(json!(null)),
            }))
        };
        let rows: Vec<Value> = if let Some(ns) = ns {
            stmt.query_map([ns], map).map_err(|e| e.to_string())?.collect::<Result<_,_>>().map_err(|e| e.to_string())?
        } else {
            stmt.query_map([], map).map_err(|e| e.to_string())?.collect::<Result<_,_>>().map_err(|e| e.to_string())?
        };
        for v in rows { push(&mut lines, v); }
    }
    Ok(lines.join("\n"))
}

// ns/coll 조합에 맞춰 파라미터 바인딩(0/1/2개). 한 분기만 실행 → map 이동 OK.
fn bind_query(
    stmt: &mut rusqlite::Statement,
    ns: Option<&str>,
    coll: Option<&str>,
    map: impl FnMut(&rusqlite::Row) -> rusqlite::Result<Value>,
) -> Result<Vec<Value>, String> {
    let out: Vec<Value> = match (ns, coll) {
        (Some(n), Some(c)) => stmt
            .query_map((n, c), map)
            .map_err(|e| e.to_string())?
            .collect::<Result<_, _>>()
            .map_err(|e: rusqlite::Error| e.to_string())?,
        (Some(n), None) => stmt
            .query_map([n], map)
            .map_err(|e| e.to_string())?
            .collect::<Result<_, _>>()
            .map_err(|e: rusqlite::Error| e.to_string())?,
        (None, Some(c)) => stmt
            .query_map([c], map)
            .map_err(|e| e.to_string())?
            .collect::<Result<_, _>>()
            .map_err(|e: rusqlite::Error| e.to_string())?,
        (None, None) => stmt
            .query_map([], map)
            .map_err(|e| e.to_string())?
            .collect::<Result<_, _>>()
            .map_err(|e: rusqlite::Error| e.to_string())?,
    };
    Ok(out)
}

// import — meta(define) → record(put) → kv(set). 반환=적용 레코드/kv 수.
pub fn import(conn: &Connection, jsonl: &str) -> Result<i64, String> {
    let mut n = 0i64;
    for line in jsonl.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let v: Value = serde_json::from_str(line).map_err(|e| e.to_string())?;
        let kind = v.get("kind").and_then(|k| k.as_str()).unwrap_or("");
        let ns = v.get("ns").and_then(|x| x.as_str()).unwrap_or("");
        match kind {
            "meta" => {
                let coll = v.get("coll").and_then(|x| x.as_str()).unwrap_or("");
                let idx: Vec<String> = v.get("idx").and_then(|x| x.as_array()).map(|a| a.iter().filter_map(|s| s.as_str().map(String::from)).collect()).unwrap_or_default();
                let fts: Vec<String> = v.get("fts").and_then(|x| x.as_array()).map(|a| a.iter().filter_map(|s| s.as_str().map(String::from)).collect()).unwrap_or_default();
                store::define(conn, ns, coll, &idx, &fts)?;
            }
            "record" => {
                let coll = v.get("coll").and_then(|x| x.as_str()).unwrap_or("");
                let scope = v.get("scope").and_then(|x| x.as_str()).unwrap_or("");
                let id = v.get("id").and_then(|x| x.as_str()).map(String::from);
                let doc = v.get("doc").cloned().unwrap_or(json!({}));
                store::put(conn, ns, coll, scope, id, &doc)?;
                n += 1;
            }
            "kv" => {
                let k = v.get("k").and_then(|x| x.as_str()).unwrap_or("");
                let val = v.get("v").cloned().unwrap_or(Value::Null);
                store::kv_set(conn, ns, k, &val)?;
                n += 1;
            }
            _ => {}
        }
    }
    Ok(n)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn mem_file(dir: &Path, name: &str) -> PathBuf {
        std::fs::create_dir_all(dir).unwrap();
        dir.join(name)
    }

    #[test]
    fn backup_restore_roundtrip() {
        let root = std::env::temp_dir().join(format!("soksak-data-bk-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let db = mem_file(&root, "soksak.db");

        let conn = super::super::open(&db).unwrap();
        store::define(&conn, "mailbox", "messages", &[], &["title".into()]).unwrap();
        store::put(&conn, "mailbox", "messages", "p", None, &json!({"title":"백업 한글"})).unwrap();
        let snap = root.join("snap.db");
        backup(&conn, &snap).unwrap();
        drop(conn);

        // 후보 검증.
        validate(&snap).unwrap();
        assert!(validate(&root.join("nope.db")).is_err());

        // 복원 후 동일 데이터 + 검색 동작.
        let bak = restore_into(&db, &snap).unwrap();
        assert!(bak.exists());
        let conn2 = super::super::open(&db).unwrap();
        assert_eq!(store::search(&conn2, "mailbox", "messages", "백업", None, None, None).unwrap().len(), 1);

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn export_import_roundtrip() {
        let c = Connection::open_in_memory().unwrap();
        super::super::init_base(&c).unwrap();
        store::define(&c, "mailbox", "messages", &["read".into()], &["title".into()]).unwrap();
        store::put(&c, "mailbox", "messages", "p", Some("m1".into()), &json!({"title":"이식 테스트","read":false})).unwrap();
        store::kv_set(&c, "mailbox", "cfg", &json!({"on":true})).unwrap();

        let dump = export(&c, Some("mailbox"), None).unwrap();
        assert!(dump.contains("\"kind\":\"meta\""));
        assert!(dump.contains("\"kind\":\"record\""));
        assert!(dump.contains("\"kind\":\"kv\""));

        let c2 = Connection::open_in_memory().unwrap();
        super::super::init_base(&c2).unwrap();
        let n = import(&c2, &dump).unwrap();
        assert_eq!(n, 2); // 1 record + 1 kv
        assert_eq!(store::get(&c2, "mailbox", "messages", "m1", None, None).unwrap().unwrap().get("title").unwrap(), "이식 테스트");
        assert_eq!(store::search(&c2, "mailbox", "messages", "이식", None, None, None).unwrap().len(), 1);
        assert_eq!(store::kv_get(&c2, "mailbox", "cfg").unwrap(), Some(json!({"on":true})));
    }
}
