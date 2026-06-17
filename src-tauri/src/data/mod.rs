// 범용 임베디드 데이터 스토어 — 모든 플러그인이 쓰는 코어 capability(app.data). 인프로세스 SQLite
// (rusqlite bundled, FTS5 trigram = CJK 부분일치). 단일 진실은 Rust 프로세스 하나뿐이라(멀티윈도우·
// CLI·MCP 가 모두 수렴) DB 를 여기 둔다. 변경은 app.emit("data-change") 로 전 창 브로드캐스트 →
// 프론트 app.data.watch 가 재질의(같은 프로젝트 다중 창 일관, 폴링 0).
//
// 인터페이스는 DB-agnostic(raw SQL 비노출): kv + 컬렉션(define/put/get/delete/query/search/count).
// 네임스페이스(ns=호출 pluginId)와 scope(프로젝트 단위)는 명령층이 강제 — 필터가 못 건드린다.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::Connection;

pub mod backup;
pub mod commands;
pub mod store;

// 단일 쓰기 커넥션(Mutex). SQLite WAL 은 읽기 동시·쓰기 단일 — 이 한 커넥션을 직렬화한다.
// 부팅 setup 에서 open() 결과를 채운다(소켓 서버 기동 이전).
#[derive(Default)]
pub struct DbState {
    pub conn: Mutex<Option<Connection>>,
}

impl DbState {
    pub fn set(&self, conn: Connection) {
        *self.conn.lock().unwrap() = Some(conn);
    }
}

// ~/.soksak/data/soksak.db — 단일 파일(백업=파일 복사/VACUUM INTO).
pub fn db_path() -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|e| format!("HOME 없음: {e}"))?;
    let dir = PathBuf::from(home).join(".soksak").join("data");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("soksak.db"))
}

// 연결 + PRAGMA + 기본 스키마. 테스트는 임시 경로를 주입(plugins.rs 패턴).
pub fn open(path: &Path) -> Result<Connection, String> {
    let conn = Connection::open(path).map_err(|e| e.to_string())?;
    // WAL: 읽기-쓰기 비차단(사이드바 읽기 중 CLI 쓰기 → 락 스톨 회피). NORMAL: WAL 에서 안전·고성능.
    // execute_batch 는 sqlite3_exec 라 journal_mode 가 돌려주는 행을 버린다(pragma_update 보다 안전).
    conn.execute_batch(
        "PRAGMA journal_mode=WAL;\
         PRAGMA synchronous=NORMAL;\
         PRAGMA busy_timeout=5000;\
         PRAGMA foreign_keys=ON;\
         PRAGMA temp_store=MEMORY;",
    )
    .map_err(|e| e.to_string())?;
    init_base(&conn)?;
    Ok(conn)
}

// 기본 테이블(멱등). 컬렉션별 FTS/인덱스는 define() 이 동적 생성.
fn init_base(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS kv (\
            ns TEXT NOT NULL, k TEXT NOT NULL, v TEXT NOT NULL, updated INTEGER NOT NULL,\
            PRIMARY KEY(ns, k)\
         ) WITHOUT ROWID;\
         CREATE TABLE IF NOT EXISTS records (\
            ns TEXT NOT NULL, coll TEXT NOT NULL, scope TEXT NOT NULL, id TEXT NOT NULL,\
            doc TEXT NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL,\
            PRIMARY KEY(ns, coll, id)\
         );\
         CREATE INDEX IF NOT EXISTS records_scope ON records(ns, coll, scope, updated);\
         CREATE TABLE IF NOT EXISTS meta_collections (\
            cid INTEGER PRIMARY KEY AUTOINCREMENT,\
            ns TEXT NOT NULL, coll TEXT NOT NULL,\
            idx_fields TEXT NOT NULL, fts_fields TEXT NOT NULL,\
            UNIQUE(ns, coll)\
         );",
    )
    .map_err(|e| e.to_string())
}

// ── 공용 헬퍼 ────────────────────────────────────────────────────────────────

pub fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// 레코드 id 미지정 시 생성 — 시간(ms)+프로세스+나노 꼬리. 정렬가능·충돌 회피용(uuid 의존 회피).
pub fn gen_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{:013}-{}-{}", now_millis(), std::process::id(), nanos % 1_000_000)
}

// ns = 호출 pluginId(또는 "core"). 경로/식별자 안전 문자만(plugins.rs sanitize_id 와 동형).
pub fn validate_ns(ns: &str) -> Result<(), String> {
    let mut chars = ns.chars();
    let head = chars.next().is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit());
    let rest = chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if head && rest {
        Ok(())
    } else {
        Err(format!("잘못된 ns: {ns:?}"))
    }
}

// 컬렉션명 — [a-z0-9_]. (ns 와 분리된 문자셋이라 메타 키 충돌 없음.)
pub fn validate_coll(coll: &str) -> Result<(), String> {
    if !coll.is_empty()
        && coll
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
    {
        Ok(())
    } else {
        Err(format!("잘못된 컬렉션: {coll:?}"))
    }
}

// 인덱스/FTS/필터 필드명 — JSON 경로($.field)·인덱스명에 직접 쓰이므로 엄격 화이트리스트
// (SQL 주입 차단). created/updated 는 실제 컬럼이라 별도 허용.
pub fn validate_field(field: &str) -> Result<(), String> {
    let mut chars = field.chars();
    let head = chars.next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_');
    let rest = chars.all(|c| c.is_ascii_alphanumeric() || c == '_');
    if head && rest {
        Ok(())
    } else {
        Err(format!("잘못된 필드명: {field:?}"))
    }
}
