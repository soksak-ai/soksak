// 백업 링 — app.data(soksak.db)의 자동 백업. 트리거는 쓰기 사실뿐이다: data 커맨드의
// emit_change(commands.rs)가 on_write 를 부른다 — 폴링 0, 쓰기가 없으면 백업도 없다.
// 게이트는 최신 슬롯(.bak.0) mtime 1시간(now 주입 → 결정적 유닛 테스트). 스냅샷은 별도
// read-only 커넥션의 VACUUM INTO(쓰기 커넥션 비블로킹) → .bak.tmp → 성공 시에만 회전
// (.bak.3→4 … .bak.0→1) → rename 원자 편입. 슬롯 5개 고정(soksak.db.bak.0=최신 … .bak.4).
// 경로는 전부 db_path()(home::soksak_home() 파생)에서 나와 identity 홈 3종이 자동 분리된다.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use std::time::{Duration, SystemTime};

use rusqlite::{Connection, OpenFlags};
use tauri::AppHandle;

/// 링 슬롯 수 — .bak.0(최신) ~ .bak.4(최고령).
pub const SLOTS: usize = 5;

/// 백업 간 최소 간격 — 최신 슬롯 mtime 게이트.
const MIN_INTERVAL: Duration = Duration::from_secs(3600);

/// i번째 슬롯 경로 — `<db>.bak.<i>`.
pub fn slot_path(db_path: &Path, i: usize) -> PathBuf {
    PathBuf::from(format!("{}.bak.{i}", db_path.to_string_lossy()))
}

/// 게이트(순수) — 최신 슬롯 mtime 과 now 주입으로 결정적. 슬롯 없음=즉시 due,
/// 1시간 경과=due, 미래 mtime(시계 역행)=보류.
pub fn due(slot0_mtime: Option<SystemTime>, now: SystemTime) -> bool {
    match slot0_mtime {
        None => true,
        Some(m) => now
            .duration_since(m)
            .map(|d| d >= MIN_INTERVAL)
            .unwrap_or(false),
    }
}

fn slot0_mtime(db_path: &Path) -> Option<SystemTime> {
    std::fs::metadata(slot_path(db_path, 0))
        .ok()
        .and_then(|m| m.modified().ok())
}

/// 쓰기 신호 1회 처리 — 게이트 통과 시 스냅샷+회전. 반환=수행 여부.
pub fn tick(db_path: &Path, now: SystemTime) -> Result<bool, String> {
    if !due(slot0_mtime(db_path), now) {
        return Ok(false);
    }
    snapshot_rotate(db_path)?;
    Ok(true)
}

/// 스냅샷+회전 — read-only 커넥션의 VACUUM INTO 가 .bak.tmp 를 만들고, 성공 쓰기
/// 이후에만 회전(.bak.3→4 … .bak.0→1) 뒤 tmp→.bak.0 rename 으로 원자 편입한다.
fn snapshot_rotate(db_path: &Path) -> Result<(), String> {
    let tmp = PathBuf::from(format!("{}.bak.tmp", db_path.to_string_lossy()));
    // 크래시 잔재 정리 — VACUUM INTO 는 기존 파일을 거부한다.
    let _ = std::fs::remove_file(&tmp);
    {
        let conn = Connection::open_with_flags(db_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|e| e.to_string())?;
        conn.busy_timeout(Duration::from_secs(5)).map_err(|e| e.to_string())?;
        let p = tmp.to_string_lossy().replace('\'', "''");
        conn.execute_batch(&format!("VACUUM INTO '{p}';"))
            .map_err(|e| e.to_string())?;
    }
    let _ = std::fs::remove_file(slot_path(db_path, SLOTS - 1));
    for i in (0..SLOTS - 1).rev() {
        let from = slot_path(db_path, i);
        if from.exists() {
            std::fs::rename(&from, slot_path(db_path, i + 1)).map_err(|e| e.to_string())?;
        }
    }
    std::fs::rename(&tmp, slot_path(db_path, 0)).map_err(|e| e.to_string())
}

// 백업 실패 고지 대상 — 무음 폴백 금지(전 폴백은 activity 고지). tick 실패(특히 손상 신호)를
// 삼키지 않고 여기로 흘려 관찰 가능하게 만든다. 테스트는 기록형 double 을 주입해 발행 사실을
// 단언한다(AppHandle 불요 — 이 seam 이 실패 보고를 검증 가능하게 만든다).
pub trait BackupReporter {
    fn failed(&self, detail: &str);
}

/// 백업 1주기 — 게이트 통과 시 스냅샷하고, 실패는 reporter 로 고지한다(삼킴 금지).
pub fn run_cycle(db_path: &Path, now: SystemTime, reporter: &dyn BackupReporter) {
    if let Err(e) = tick(db_path, now) {
        reporter.failed(&e);
    }
}

// 앱 발원 고지 reporter — 실패를 activity(data.backup.failed, 영속·스트림)로 발행하고 OS 알림을
// 띄운다. 상세(에러)는 activity payload 에, 사람용 요약은 알림에 실린다.
struct AppReporter {
    app: AppHandle,
}

impl BackupReporter for AppReporter {
    fn failed(&self, detail: &str) {
        crate::activity::publish(
            &self.app,
            "data.backup.failed",
            "core",
            serde_json::json!({ "error": detail }),
        );
        let lang = crate::i18n::app_language(&self.app);
        if let Err(e) = crate::notify::show(
            &self.app,
            crate::i18n::backup_failed_title(lang),
            crate::i18n::backup_failed_body(lang),
        ) {
            eprintln!("[data] 백업 실패 알림 표시 실패: {e}");
        }
    }
}

// 앱 핸들 미설정(부팅 극초기) 대비 — 최소한 로그로 남긴다(무음 아님, 알림/activity 는 핸들 필요).
struct LogReporter;

impl BackupReporter for LogReporter {
    fn failed(&self, detail: &str) {
        eprintln!("[data] 백업 링 스냅샷 실패: {detail}");
    }
}

// 부팅 1회(lib.rs setup)에 심는 앱 핸들 — on_write 스냅샷 스레드가 실패 고지에 쓴다. dockmenu 와
// 동형(OnceLock<AppHandle>). 발견 가능한 seam 이라 숨은 상태가 아니다.
static APP: OnceLock<AppHandle> = OnceLock::new();

/// 부팅에서 앱 핸들을 심는다 — 이후 백업 실패가 activity/알림으로 드러난다.
pub fn set_app(app: &AppHandle) {
    let _ = APP.set(app.clone());
}

// 스냅샷 동시 수행 방지 — 진행 중이면 신규 쓰기 신호는 그냥 지나간다(다음 쓰기가 다시 신호).
static IN_FLIGHT: AtomicBool = AtomicBool::new(false);

/// 쓰기 신호(emit_change) 진입 — stat 1회 선판정 후에만 백그라운드 스레드 1개가 스냅샷한다.
/// 쓰기 커넥션은 블로킹하지 않는다(WAL 읽기 동시 + 별도 read-only 커넥션).
pub fn on_write() {
    let Ok(db) = super::db_path() else { return };
    if !due(slot0_mtime(&db), SystemTime::now()) {
        return;
    }
    if IN_FLIGHT
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return;
    }
    std::thread::spawn(move || {
        match APP.get() {
            Some(app) => run_cycle(&db, SystemTime::now(), &AppReporter { app: app.clone() }),
            None => run_cycle(&db, SystemTime::now(), &LogReporter),
        }
        IN_FLIGHT.store(false, Ordering::SeqCst);
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data::{self, store};
    use serde_json::json;

    const HOUR: Duration = Duration::from_secs(3600);

    fn temp_root(tag: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("soksak-ring-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    // 기록형 reporter — 발행 사실을 단언하는 test double(AppHandle 불요).
    struct RecordingReporter {
        failures: std::sync::Mutex<Vec<String>>,
    }

    impl BackupReporter for RecordingReporter {
        fn failed(&self, detail: &str) {
            self.failures.lock().unwrap().push(detail.to_string());
        }
    }

    // [defect ①] 손상 DB 스냅샷 실패는 삼키지 않고 정확히 1회 고지된다(무음 폴백 금지). 이전엔
    // on_write 가 eprintln 만 하고 activity/알림 0 — 손상 신호를 쥐고도 무음이었다.
    #[test]
    fn corrupt_snapshot_failure_is_reported_not_swallowed() {
        let root = temp_root("failreport");
        let db = root.join("soksak.db");
        // 슬롯 없음 → due=true → tick 이 스냅샷을 시도한다. 본체는 SQLite 가 아니므로 VACUUM INTO 실패.
        std::fs::write(&db, b"this is not a sqlite database, snapshot must fail").unwrap();
        let reporter = RecordingReporter { failures: std::sync::Mutex::new(Vec::new()) };
        run_cycle(&db, SystemTime::now(), &reporter);
        let failures = reporter.failures.lock().unwrap();
        assert_eq!(failures.len(), 1, "손상 DB 스냅샷 실패는 정확히 1회 고지되어야 한다");
        assert!(!failures[0].is_empty(), "고지에 실패 상세가 실려야 한다: {failures:?}");
        drop(failures);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn gate_is_due_without_slot_and_after_interval() {
        let now = SystemTime::now();
        assert!(due(None, now), "첫 백업(슬롯 없음)은 즉시 due");
        assert!(!due(Some(now - Duration::from_secs(600)), now), "10분 경과는 게이트 미달");
        assert!(due(Some(now - HOUR), now), "1시간 경과는 due");
        assert!(!due(Some(now + HOUR), now), "미래 mtime(시계 역행)은 보류");
    }

    #[test]
    fn write_then_tick_creates_slot_zero() {
        let root = temp_root("first");
        let db = root.join("soksak.db");
        let conn = data::open(&db).unwrap();
        store::kv_set(&conn, "core", "marker", &json!(1)).unwrap();
        // 쓰기 커넥션이 살아있는 채(앱 상태 그대로) tick — 스냅샷은 read-only 커넥션 몫.
        let did = tick(&db, SystemTime::now()).unwrap();
        assert!(did, "쓰기 후 첫 tick 은 백업을 생성해야 한다");
        let slot0 = slot_path(&db, 0);
        assert!(slot0.is_file(), "bak.0 실존");
        data::backup::validate(&slot0).unwrap();
        drop(conn);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn tick_within_interval_skips() {
        let root = temp_root("skip");
        let db = root.join("soksak.db");
        let conn = data::open(&db).unwrap();
        store::kv_set(&conn, "core", "marker", &json!(1)).unwrap();
        assert!(tick(&db, SystemTime::now()).unwrap());
        // 직후 재신호 — 게이트(1h) 미달이므로 수행하지 않고 회전도 없다.
        let did = tick(&db, SystemTime::now()).unwrap();
        assert!(!did, "간격 미달 tick 은 수행하지 않는다");
        assert!(!slot_path(&db, 1).exists(), "회전 없음");
        drop(conn);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn rotation_keeps_five_newest_in_order() {
        let root = temp_root("rot");
        let db = root.join("soksak.db");
        let conn = data::open(&db).unwrap();
        let base = SystemTime::now();
        // 7회 스냅샷(사이마다 marker 갱신, 주입 now 를 2h 씩 전진 → 항상 due).
        for i in 1..=7u32 {
            store::kv_set(&conn, "core", "marker", &json!(i)).unwrap();
            assert!(tick(&db, base + HOUR * 2 * i).unwrap(), "스냅샷 {i} 수행");
        }
        // 슬롯 5개만 남고 bak.0=최신(7) … bak.4=3, 임시 파일 잔재 없음.
        for i in 0..SLOTS {
            let sc = rusqlite::Connection::open(slot_path(&db, i)).unwrap();
            let v: String = sc
                .query_row("SELECT v FROM kv WHERE ns='core' AND k='marker'", [], |r| r.get(0))
                .unwrap();
            assert_eq!(v, (7 - i).to_string(), "bak.{i} 내용");
        }
        assert!(!slot_path(&db, SLOTS).exists(), "슬롯 5개 캡");
        assert!(
            !PathBuf::from(format!("{}.bak.tmp", db.to_string_lossy())).exists(),
            "tmp 는 rename 으로 소진된다"
        );
        drop(conn);
        let _ = std::fs::remove_dir_all(&root);
    }
}
