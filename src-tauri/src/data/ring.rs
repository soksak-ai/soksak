// 백업 링 — app.data(soksak.db)의 자동 백업. 트리거는 쓰기 사실뿐이다: data 커맨드의
// emit_change(commands.rs)가 on_write 를 부른다 — 폴링 0, 쓰기가 없으면 백업도 없다.
// 게이트는 최신 슬롯(.bak.0) mtime 1시간(now 주입 → 결정적 유닛 테스트). 스냅샷은 별도
// read-only 커넥션의 VACUUM INTO(쓰기 커넥션 비블로킹) → .bak.tmp → 성공 시에만 회전
// (.bak.3→4 … .bak.0→1) → rename 원자 편입. 슬롯 5개 고정(soksak.db.bak.0=최신 … .bak.4).
// 경로는 전부 db_path()(home::soksak_home() 파생)에서 나와 identity 홈 3종이 자동 분리된다.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

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
    let _ = (slot0_mtime, now);
    false // 현행 재현: 앱은 어떤 쓰기에도 자동 백업하지 않는다.
}

/// 쓰기 신호 1회 처리 — 게이트 통과 시 스냅샷+회전. 반환=수행 여부.
pub fn tick(db_path: &Path, now: SystemTime) -> Result<bool, String> {
    let _ = (db_path, now);
    Ok(false) // 현행 재현: 쓰기가 백업을 만들지 않는다.
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
