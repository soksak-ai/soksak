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
pub mod crypto;
pub mod integrity;
pub mod ring;
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
// SOKSAK_DATA_DIR 오버라이드(debug 빌드 전용): 있으면 DB(+WAL/SHM/FTS)가 이 디렉토리에 산다. e2e·도구가
// 홈의 설치본 플러그인·사이드카는 그대로 쓰면서 DB 만 disposable temp 로 격리하는 오픈-테스트 메커니즘
// (SOKSAK_VAULT_PATH 의 DB 대칭, home.rs SOKSAK_HOME 과 동형 debug-gate). DB 위치를 옮기는 env 는 새
// 프로덕션 표면이라 release 엔 이 분기를 컴파일하지 않는다.
fn data_dir_from(data_dir_env: Option<&str>, home: &Path) -> PathBuf {
    #[cfg(debug_assertions)]
    if let Some(d) = data_dir_env.filter(|s| !s.is_empty()) {
        return PathBuf::from(d);
    }
    #[cfg(not(debug_assertions))]
    let _ = data_dir_env;
    home.join("data")
}

pub fn db_path() -> Result<PathBuf, String> {
    let dir = data_dir_from(
        std::env::var("SOKSAK_DATA_DIR").ok().as_deref(),
        &crate::home::soksak_home(),
    );
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("soksak.db"))
}

// 연결 + PRAGMA + 기본 스키마. 테스트는 임시 경로를 주입(plugins.rs 패턴).
pub fn open(path: &Path) -> Result<Connection, String> {
    let conn = Connection::open(path).map_err(|e| e.to_string())?;
    // 로컬 사용자 전용(0600) — DB 는 봉투 키·레코드를 담는 data-at-rest 저장소라 group/other 접근을
    // 차단한다(ipc.rs 소켓 0600 선례와 동형). best-effort: :memory:·권한 미지원 FS 는 조용히 무시.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    // WAL: 읽기-쓰기 비차단(사이드바 읽기 중 CLI 쓰기 → 락 스톨 회피). NORMAL: WAL 에서 안전·고성능.
    // execute_batch 는 sqlite3_exec 라 journal_mode 가 돌려주는 행을 버린다(pragma_update 보다 안전).
    conn.execute_batch(
        // [R5] auto_vacuum=INCREMENTAL — retention 의 logical delete 후 incremental_vacuum 으로 free 페이지를
        // bounded 반환(physical reclaim, #8835 의 '삭제해도 파일 안 줄어듦' 방지). 첫 CREATE 전에 설정해야
        // 효과 — 기존 DB(auto_vacuum=NONE 으로 생성됨)는 변경이 무시되고 다음 풀 VACUUM(backup) 에 정리된다.
        // secure_delete=ON — 삭제·덮어쓴 셀 내용을 0 으로 채운다. 봉인 전환(convert 의 in-place UPDATE)이
        // 남기는 옛 평문 셀·FTS 텀이 freelist·WAL 에 잔존해 파일-carve 로 키 없이 복원되는 걸 막는다
        // (도난-디스크 위협모델). 봉인 데이터의 at-rest 안전 전제.
        "PRAGMA auto_vacuum=INCREMENTAL;\
         PRAGMA secure_delete=ON;\
         PRAGMA journal_mode=WAL;\
         PRAGMA synchronous=NORMAL;\
         PRAGMA busy_timeout=5000;\
         PRAGMA foreign_keys=ON;\
         PRAGMA temp_store=MEMORY;",
    )
    .map_err(|e| e.to_string())?;
    // [P0] 깊은 손상 게이트 — 헤더는 멀쩡하나 내부 페이지가 손상된 DB 는 Connection::open·DDL·부분
    // 조회가 통과해 부분 유실을 성공으로 오인한다(비헤더 손상 무음 통과). quick_check(integrity_check
    // 경량판)로 페이지 무결성을 부팅 개방에서 확인해 손상을 복구 경로(open_or_recover)로 넘긴다. 정상
    // DB 는 "ok" 단행 반환. 비용은 부팅 개방 1회(DDL 이전에 확인 — 손상본에 스키마 변경을 얹지 않는다).
    let integrity: String = conn
        .query_row("PRAGMA quick_check", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    if integrity != "ok" {
        return Err(format!("integrity check failed: {integrity}"));
    }
    init_base(&conn)?;
    // [M0] 부팅 시 FTS 정합 backstop(과거 비원자 put crash 의 orphan 청소). 멱등·저비용.
    store::reconcile_fts(&conn)?;
    Ok(conn)
}

// 부팅 개방 실패 — detail 은 원인, quarantined 는 복구가 손상본을 옮긴 경로(재개방까지 실패했어도
// 이 값을 실어 호출 측이 사람에게 고지한다). None=격리 이전에 실패(파일 부재·복구 자체 실패).
// 무음 drop 금지 — recover 가 격리를 마친 뒤 재개방이 실패해도 격리 경로를 잃지 않는다.
#[derive(Debug)]
pub struct OpenError {
    pub detail: String,
    pub quarantined: Option<PathBuf>,
}

// 부팅 개방 — 정상이면 그대로, 손상이면 백업 슬롯에서 복구 후 재개방한다. 반환 Ok((conn, None))=정상,
// Ok((conn, Some(rec)))=복구 발생(호출 측이 activity 로 고지). 파일 부재는 실패가 아니다(open 이 신규 생성)
// → 개방 실패 후 파일이 있을 때만 손상으로 보고 복구한다. 복구 후에도 개방 실패면 격리 경로를 실어
// 전파한다(무음 drop 금지).
pub fn open_or_recover(path: &Path) -> Result<(Connection, Option<backup::Recovery>), OpenError> {
    open_or_recover_with(path, open)
}

// open_or_recover 의 검증 가능한 심 — opener 를 주입해 재개방 실패 경로를 결정적으로 재현한다(R2).
fn open_or_recover_with(
    path: &Path,
    opener: impl Fn(&Path) -> Result<Connection, String>,
) -> Result<(Connection, Option<backup::Recovery>), OpenError> {
    match opener(path) {
        Ok(conn) => Ok((conn, None)),
        Err(open_err) => {
            if !path.exists() {
                return Err(OpenError {
                    detail: open_err,
                    quarantined: None,
                });
            }
            let rec = backup::recover(path).map_err(|detail| OpenError {
                detail,
                quarantined: None,
            })?;
            match opener(path) {
                Ok(conn) => Ok((conn, Some(rec))),
                // 재개방 실패 — 격리 경로를 실어 전파한다(호출 측 notify 의 재료).
                Err(detail) => Err(OpenError {
                    detail,
                    quarantined: Some(rec.quarantined),
                }),
            }
        }
    }
}

// 기본 테이블(멱등). 컬렉션별 FTS/인덱스는 define() 이 동적 생성.
// (테스트 픽스처에서 in-memory 스키마 초기화에 재사용 — window.rs prune 유닛)
pub(crate) fn init_base(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS kv (\
            ns TEXT NOT NULL, k TEXT NOT NULL, v TEXT NOT NULL, updated INTEGER NOT NULL,\
            PRIMARY KEY(ns, k)\
         ) WITHOUT ROWID;\
         CREATE TABLE IF NOT EXISTS records (\
            ns TEXT NOT NULL, coll TEXT NOT NULL, scope TEXT NOT NULL, id TEXT NOT NULL,\
            doc TEXT NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL,\
            enc INTEGER NOT NULL DEFAULT 0, keyId TEXT,\
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
    .map_err(|e| e.to_string())?;
    migrate_records(conn)?;
    // [M0] retention FIFO 는 created 정렬(updated 금지 — 변환 UPDATE 가 updated 를 바꾸면 순서 비결정, R5).
    // enc 부분 인덱스 = 변환 재개를 O(pending) 으로(미변환 enc=0 만, R17). 둘 다 멱등.
    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS records_created ON records(ns, coll, scope, created);\
         CREATE INDEX IF NOT EXISTS records_pending ON records(ns, coll) WHERE enc=0;",
    )
    .map_err(|e| e.to_string())?;
    // [단계②] scope 별 봉투 키 메타(encryption_keys). active 행 존재 = 암호화 트리거(fail-closed).
    crypto::init_keys_table(conn)
}

// [M0] 기존 DB(enc/keyId 없는) 멱등 마이그레이션 — CREATE TABLE IF NOT EXISTS 는 기존 테이블에 컬럼을
// 추가하지 않으므로, pragma_table_info 로 부재 확인 후 ALTER ADD. 신규 DB 는 위 CREATE 에 이미 포함(no-op).
fn migrate_records(conn: &Connection) -> Result<(), String> {
    let has_enc: bool = conn
        .prepare("SELECT 1 FROM pragma_table_info('records') WHERE name='enc'")
        .map_err(|e| e.to_string())?
        .exists([])
        .map_err(|e| e.to_string())?;
    if !has_enc {
        conn.execute_batch(
            "ALTER TABLE records ADD COLUMN enc INTEGER NOT NULL DEFAULT 0;\
             ALTER TABLE records ADD COLUMN keyId TEXT;",
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
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
    format!(
        "{:013}-{}-{}",
        now_millis(),
        std::process::id(),
        nanos % 1_000_000
    )
}

// ns = 호출 pluginId(또는 "core"). 경로/식별자 안전 문자만(plugins.rs sanitize_id 와 동형).
pub fn validate_ns(ns: &str) -> Result<(), String> {
    let mut chars = ns.chars();
    let head = chars
        .next()
        .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit());
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
    let head = chars
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_');
    let rest = chars.all(|c| c.is_ascii_alphanumeric() || c == '_');
    if head && rest {
        Ok(())
    } else {
        Err(format!("잘못된 필드명: {field:?}"))
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::{now_millis, open};
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn open_creates_db_file_with_owner_only_mode() {
        // DB 는 봉투 키·레코드를 담는 data-at-rest 저장소 — group/other 접근을 0600 으로 차단한다.
        let dir = std::env::temp_dir().join(format!(
            "soksak-dbperm-{}-{}",
            std::process::id(),
            now_millis()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("soksak.db");
        let conn = open(&path).unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(mode, 0o600, "soksak.db 는 0600 이어야 한다(실제 {mode:o})");
    }

    // SOKSAK_DATA_DIR(debug 전용)이 데이터 디렉토리를 지정 — e2e 가 홈의 설치본 플러그인·사이드카는 그대로
    // 두고 DB 만 disposable temp 로 격리한다. 빈 값·부재는 홈/data 폴백. release 엔 이 분기가 없어
    // (cfg debug_assertions) 이 계약도 debug 에서만 검증한다(새 프로덕션 DB-override 표면 부재의 대칭).
    #[cfg(debug_assertions)]
    #[test]
    fn data_dir_env_overrides_data_dir_in_debug() {
        use super::data_dir_from;
        use std::path::{Path, PathBuf};
        assert_eq!(
            data_dir_from(Some("/tmp/e2e-data"), Path::new("/home/max/.soksak-debug")),
            PathBuf::from("/tmp/e2e-data"),
            "SOKSAK_DATA_DIR 이 데이터 디렉토리를 그대로 지정"
        );
        assert_eq!(
            data_dir_from(Some(""), Path::new("/home/max/.soksak-debug")),
            PathBuf::from("/home/max/.soksak-debug/data"),
            "빈 값은 무시 → 홈/data 폴백"
        );
        assert_eq!(
            data_dir_from(None, Path::new("/home/max/.soksak-debug")),
            PathBuf::from("/home/max/.soksak-debug/data"),
            "부재 → 홈/data 폴백"
        );
    }

    #[test]
    fn overwritten_plaintext_is_scrubbed_from_db_file() {
        // 봉인 전환(convert 의 in-place UPDATE)이 남기는 옛 평문이 secure_delete=ON + VACUUM 으로 파일에서
        // 사라짐을 증명한다 — 라이브 DB 를 훔친 자가 전환 이전 평문을 키 없이 carve 하는 경로(적대 프로브
        // 앵글2)를 닫는다. 수정 전(secure_delete 부재·VACUUM 부재)엔 옛 평문이 freelist·WAL 에 잔존.
        let dir = std::env::temp_dir().join(format!(
            "soksak-scrub-{}-{}",
            std::process::id(),
            now_millis()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("soksak.db");
        let secret = "SCRUB-SECRET-a1b2c3d4e5f6-do-not-leak";
        {
            let conn = open(&path).unwrap();
            conn.execute(
                "INSERT INTO kv(ns,k,v,updated) VALUES('t','k',?1,0)",
                rusqlite::params![format!("{{\"body\":\"{secret}\"}}")],
            )
            .unwrap();
            // 봉인 전환처럼 그 값을 암호문 자리표시자로 덮어쓴 뒤, data_encrypt_convert 완료와 동형으로 scrub.
            conn.execute(
                "UPDATE kv SET v='SEALED-CIPHERTEXT-PLACEHOLDER-0123456789abcdef' WHERE ns='t' AND k='k'",
                [],
            )
            .unwrap();
            conn.execute_batch("VACUUM; PRAGMA wal_checkpoint(TRUNCATE);")
                .unwrap();
        }
        let mut hay = std::fs::read(&path).unwrap();
        if let Ok(wal) = std::fs::read(format!("{}-wal", path.to_string_lossy())) {
            hay.extend_from_slice(&wal);
        }
        let _ = std::fs::remove_dir_all(&dir);
        let leaked = hay.windows(secret.len()).any(|w| w == secret.as_bytes());
        assert!(
            !leaked,
            "덮어쓴 평문이 DB 파일에 잔존한다(secure_delete/VACUUM 미작동)"
        );
    }

    #[test]
    fn fts_residual_is_scrubbed_after_convert() {
        // 봉인 변환 후 FTS 그림자테이블(%_data)에 남던 봉인 필드의 옛 트라이그램이 purge_fts_residual
        // ('rebuild') + VACUUM 으로 파일에서 사라짐을 증명한다 — sync_fts 의 DELETE 가 FTS5 tombstone 이라
        // 트라이그램이 살아남아 파일-carve 로 키 없이 복원되던 적대검증 구멍(residual-carve)을 막는다.
        use super::store;
        let dir = std::env::temp_dir().join(format!(
            "soksak-ftsscrub-{}-{}",
            std::process::id(),
            now_millis()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("soksak.db");
        // 희귀 트라이그램 단어 — 정상 DB(스키마·sqlite 헤더)엔 안 나와 위양성 배제.
        let secret = "qzvxwkjfby";
        {
            let conn = open(&path).unwrap();
            // fts 전용 필드(idx 아님) — 봉인 대상이면서 평문 시점에 FTS 색인됨(누출 후보).
            store::define(&conn, "t", "notes", &[], &["body".into()]).unwrap();
            store::put(&conn, "t", "notes", "proj-a", None, &serde_json::json!({ "body": secret }))
                .unwrap();
            // 암호화 활성 후 변환 — 레코드 봉인, FTS 엔트리 DELETE(tombstone).
            let (_s, p) = crate::secrets::gen_asym_keypair();
            super::crypto::register_active_key(&conn, "proj-a", "key-1", &p, 50).unwrap();
            assert_eq!(
                store::convert_pending(&conn, "t", "notes", "proj-a", 100).unwrap(),
                1,
                "평문 1건 봉인 변환"
            );
            store::purge_fts_residual(&conn, "t", "notes").unwrap();
            conn.execute_batch("VACUUM; PRAGMA wal_checkpoint(TRUNCATE);")
                .unwrap();
        }
        let mut hay = std::fs::read(&path).unwrap();
        if let Ok(wal) = std::fs::read(format!("{}-wal", path.to_string_lossy())) {
            hay.extend_from_slice(&wal);
        }
        let _ = std::fs::remove_dir_all(&dir);
        // 봉인된 fts 필드 값의 어떤 트라이그램도 파일에 남지 않아야 한다(평문 잔존 0).
        let present = secret
            .as_bytes()
            .windows(3)
            .filter(|w| hay.windows(3).any(|h| h == *w))
            .count();
        assert_eq!(
            present, 0,
            "봉인된 FTS 필드의 트라이그램이 DB 파일에 잔존(rebuild/VACUUM 미작동)"
        );
    }
}
