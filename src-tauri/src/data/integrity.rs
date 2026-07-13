// 저장소의 자기 무결성 — 볼 수 있어야 고칠 수 있다.
//
// 부팅 개방은 `PRAGMA quick_check` 로 페이지 무결성을 본다(mod.rs). 그런데 quick_check 는 설계상
// **인덱스와 테이블을 대조하지 않는다** — 인덱스에서 행이 빠진 손상은 그 게이트를 그냥 통과한다.
// 그 상태의 저장소는 읽기는 멀쩡하고 쓰기만 무너진다: 실측(2026-07-13)에서 SQLite 가 그 손상 위의
// 삽입에 `out of memory` 를 돌려줬고, 앱은 자기 저장소가 아프다는 것도, 어디가 아픈지도 말하지 못했다.
//
// 그래서 두 표면을 둔다. 진단(check)은 전수 대조(integrity_check)를, 치유(repair)는 REINDEX 를
// 쓴다 — 인덱스는 테이블에서 다시 만들 수 있으므로 이 치유는 데이터를 만들지도 지우지도 않는다.
// 치유 후에는 다시 진단해서 나은 것을 증명한다(고쳤다고 말만 하지 않는다).

use rusqlite::Connection;

/// 전수 무결성 진단 — 문제 목록(빈 목록 = 정상). SQLite 는 정상일 때 "ok" 단행을 돌려주므로
/// 그 한 줄은 문제로 세지 않는다.
pub fn check(conn: &Connection) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare("PRAGMA integrity_check")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        let line = row.map_err(|e| e.to_string())?;
        if line != "ok" {
            out.push(line);
        }
    }
    Ok(out)
}

/// 치유 결과 — 전후 문제 목록. after 가 비지 않았다면 REINDEX 로는 낫지 않는 손상이다(테이블 자체의
/// 손상 등) — 나았다고 주장하지 않고 남은 문제를 그대로 실어 보낸다.
#[derive(Debug, serde::Serialize)]
pub struct Repair {
    pub before: Vec<String>,
    pub after: Vec<String>,
}

/// 인덱스를 테이블에서 다시 만든다(REINDEX). 데이터 행은 건드리지 않는다.
pub fn repair(conn: &Connection) -> Result<Repair, String> {
    let before = check(conn)?;
    conn.execute_batch("REINDEX").map_err(|e| e.to_string())?;
    let after = check(conn)?;
    Ok(Repair { before, after })
}

/// 저장소 실황 — 앱 **안의** SQLite 가 자기 상태를 답한다. 밖에서 파일을 열어 보는 것은 판이 달라
/// 답이 갈리고(표현식 인덱스), 한도·메모리는 프로세스 안에서만 알 수 있다. `out of memory` 가 났을 때
/// 무엇이 굶겼는지는 이 값들로만 가려진다: 힙 한도(누군가 sqlite3_soft/hard_heap_limit 을 걸었는가),
/// 지금 쓰는 메모리와 최고치, 페이지 캐시 설정, 그리고 SQLite 판(밖의 CLI 와 다르다).
#[derive(Debug, serde::Serialize)]
pub struct Stats {
    pub sqlite_version: String,
    pub soft_heap_limit: i64,
    pub hard_heap_limit: i64,
    pub memory_used: i64,
    pub memory_highwater: i64,
    pub cache_size: i64,
    pub page_size: i64,
    pub page_count: i64,
    pub freelist_count: i64,
    pub records_indexes: i64,
}

pub fn stats(conn: &Connection) -> Result<Stats, String> {
    let one = |sql: &str| -> i64 {
        conn.query_row(sql, [], |r| r.get::<_, i64>(0)).unwrap_or(-1)
    };
    let version: String = conn
        .query_row("SELECT sqlite_version()", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    Ok(Stats {
        sqlite_version: version,
        soft_heap_limit: one("PRAGMA soft_heap_limit"),
        hard_heap_limit: one("PRAGMA hard_heap_limit"),
        memory_used: unsafe { rusqlite::ffi::sqlite3_memory_used() },
        memory_highwater: unsafe { rusqlite::ffi::sqlite3_memory_highwater(0) },
        cache_size: one("PRAGMA cache_size"),
        page_size: one("PRAGMA page_size"),
        page_count: one("PRAGMA page_count"),
        freelist_count: one("PRAGMA freelist_count"),
        records_indexes: one(
            "SELECT count(*) FROM sqlite_master WHERE type='index' AND tbl_name='records'",
        ),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // 실제로 만난 손상의 모양 — **논리적 불일치**다: 인덱스 안의 항목이 테이블의 현재 내용과
    // 맞지 않는다("row N missing from index"). 페이지를 깨는 것과 다르다 — 페이지는 멀쩡해서
    // quick_check 는 통과하고, 인덱스↔테이블 대조를 하는 전수 진단만 그것을 본다.
    // 재현: 인덱스 항목은 k 로 채워 두고 선언만 j 로 바꾼다(writable_schema).
    fn desync_index(path: &std::path::Path) {
        let conn = Connection::open(path).unwrap();
        conn.execute_batch(
            "PRAGMA writable_schema=ON;
             UPDATE sqlite_schema SET sql='CREATE INDEX idx_k ON t(j)' WHERE name='idx_k';
             PRAGMA writable_schema=OFF;",
        )
        .unwrap();
    }

    // 테스트 DB — ring.rs 와 같은 규약(temp_dir + pid). 호출마다 다른 이름으로 격리한다.
    fn scratch() -> std::path::PathBuf {
        use std::sync::atomic::{AtomicU32, Ordering};
        static N: AtomicU32 = AtomicU32::new(0);
        let n = N.fetch_add(1, Ordering::Relaxed);
        let p = std::env::temp_dir().join(format!(
            "soksak-integrity-{}-{n}.db",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&p);
        p
    }

    fn seeded(path: &std::path::Path) {
        let conn = Connection::open(path).unwrap();
        conn.execute_batch(
            "CREATE TABLE t(id INTEGER PRIMARY KEY, k TEXT, j TEXT);
             CREATE INDEX idx_k ON t(k);",
        )
        .unwrap();
        for i in 0..200 {
            conn.execute(
                "INSERT INTO t(k, j) VALUES (?1, ?2)",
                [format!("key-{i}"), format!("other-{i}")],
            )
            .unwrap();
        }
    }

    #[test]
    fn healthy_store_reports_no_problems() {
        let db = scratch();
        seeded(&db);
        let conn = Connection::open(&db).unwrap();
        assert_eq!(check(&conn).unwrap(), Vec::<String>::new());
    }

    // 부팅 게이트가 이 손상을 못 본다는 것이 이 결함의 핵심 — quick_check 는 통과하고
    // integrity_check 만 문제를 본다. 그래서 진단 표면은 전수 대조여야 한다.
    #[test]
    fn a_broken_index_is_invisible_to_quick_check_and_visible_to_the_full_check() {
        let db = scratch();
        seeded(&db);
        desync_index(&db);

        let conn = Connection::open(&db).unwrap();
        let quick: String = conn
            .query_row("PRAGMA quick_check", [], |r| r.get(0))
            .unwrap();
        assert_eq!(quick, "ok", "부팅 게이트는 이 손상을 통과시킨다");
        assert!(
            !check(&conn).unwrap().is_empty(),
            "전수 진단은 이 손상을 본다"
        );
    }

    #[test]
    fn repair_rebuilds_the_index_and_proves_it() {
        let db = scratch();
        seeded(&db);
        desync_index(&db);

        let conn = Connection::open(&db).unwrap();
        let r = repair(&conn).unwrap();
        assert!(!r.before.is_empty(), "치유 전에는 문제가 있었다");
        assert_eq!(r.after, Vec::<String>::new(), "치유 후에는 없다");

        // 행은 하나도 잃지 않았다 — 인덱스만 다시 만든 것이다.
        let n: i64 = conn
            .query_row("SELECT count(*) FROM t", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 200);
    }
}
