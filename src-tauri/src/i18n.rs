// Rust 사람 표면 — 프론트가 뜨기 전이나 밖에서 앱이 사람에게 내보내는 문장(OS 알림·부팅 고지)을
// 여기서 해소한다. 프론트는 자기 i18n 키 테이블(src/i18n.ts)을 소유하지만 Rust 는 그 테이블에
// 닿지 못한다 — 부팅 복구 알림은 어떤 창도 로드되기 전에 뜨기 때문이다. 그래서 Rust 발원 사람
// 표면은 이 모듈이 단일 소유한다. LLM 발화·로그·식별자는 영어이고 이 모듈을 지나지 않는다.
//
// 로케일 단일 소스 = 프론트가 영속하는 설정(app.data kv: ns "core", key "settings", 필드
// "language"). 프론트 기본값과 맞춰 부재·판독 실패 시 "ko" 로 해소한다. 메시지 생성 시점 1회
// 조회 — 폴링 없음.

use rusqlite::Connection;
use serde_json::Value;
use soksak_spec_socket::Lang;
use tauri::{AppHandle, Manager};

use crate::data;

// 영속된 설정 블롭에서 사람 언어를 뽑는다(순수). "language" 필드가 없거나 설정이 아예 없으면
// 프론트 기본값과 같은 Korean 으로 해소한다 — 필드가 있으면 그 태그를 해석한다.
pub fn language_from_settings(settings: Option<&Value>) -> Lang {
    settings
        .and_then(|s| s.get("language"))
        .and_then(Value::as_str)
        .map(Lang::from_tag)
        .unwrap_or(Lang::Ko)
}

// 열린 커넥션에서 사람 언어를 조회한다 — kv(core/settings)를 읽어 순수 해소기에 넘긴다.
// 판독 실패(손상·부재)는 Korean 으로 떨어진다. 부팅 복구가 복원한 DB 든 빈 DB 든 같은 규칙이다.
pub fn app_language_from_conn(conn: &Connection) -> Lang {
    let settings = data::store::kv_get(conn, "core", "settings").ok().flatten();
    language_from_settings(settings.as_ref())
}

// 앱 핸들에서 사람 언어를 조회한다 — DbState 의 단일 쓰기 커넥션을 잠깐 잠근다. 커넥션이 아직
// 없거나(부팅 극초기) 락이 오염됐으면 Korean.
pub fn app_language(app: &AppHandle) -> Lang {
    match app.state::<data::DbState>().conn.lock() {
        Ok(guard) => match guard.as_ref() {
            Some(conn) => app_language_from_conn(conn),
            None => Lang::Ko,
        },
        Err(_) => Lang::Ko,
    }
}

// 부팅 복구 알림 제목 — 해소된 언어 한 벌.
pub fn recovery_title(lang: Lang) -> &'static str {
    match lang {
        Lang::En => "Data recovery",
        Lang::Ko => "데이터 복구",
    }
}

// 부팅 복구 알림 본문 — 복원 슬롯이 있으면 그 번호를, 전 슬롯 실패면 빈 저장소 시작을 고지한다.
pub fn recovery_body(lang: Lang, restored_slot: Option<usize>) -> String {
    match (lang, restored_slot) {
        (Lang::En, Some(i)) => format!("Recovered corrupted data from backup slot {i}."),
        (Lang::En, None) => {
            "No backup was available to recover the corrupted data — starting with an empty store."
                .to_string()
        }
        (Lang::Ko, Some(i)) => format!("손상된 데이터를 백업 슬롯 {i}에서 복원했습니다."),
        (Lang::Ko, None) => {
            "손상된 데이터를 복원할 백업이 없어 빈 저장소로 시작합니다.".to_string()
        }
    }
}

// 백업 링 실패 고지 — 런타임 자동 백업 스냅샷을 기록하지 못했음을 사람에게 알린다. 상세(에러)는
// activity data.backup.failed 에 실리고, 이 문장은 OS 알림용 요약이다.
pub fn backup_failed_title(lang: Lang) -> &'static str {
    match lang {
        Lang::En => "Backup failed",
        Lang::Ko => "백업 실패",
    }
}

pub fn backup_failed_body(lang: Lang) -> &'static str {
    match lang {
        Lang::En => {
            "An automatic data backup could not be written. See the activity log for details."
        }
        Lang::Ko => "자동 데이터 백업을 기록하지 못했습니다. 자세한 내용은 활동 로그를 확인하세요.",
    }
}

// 복구 후 재개방 실패 고지 — 손상본은 격리했으나 데이터 저장소를 열지 못했다. 격리 경로를 알려
// 사후 조사·수동 복구를 돕는다(무음 drop 금지).
pub fn open_failed_title(lang: Lang) -> &'static str {
    match lang {
        Lang::En => "Data could not be opened",
        Lang::Ko => "데이터를 열 수 없음",
    }
}

pub fn open_failed_body(lang: Lang, quarantined: &str) -> String {
    match lang {
        Lang::En => format!(
            "The data store could not be opened after recovery. The damaged file was set aside at {quarantined}."
        ),
        Lang::Ko => format!(
            "복구 이후에도 데이터 저장소를 열지 못했습니다. 손상된 파일은 {quarantined}에 격리했습니다."
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // 설정 블롭 → 언어: 필드가 있으면 해석하고, 없거나 설정 부재면 Korean 기본.
    #[test]
    fn language_from_settings_reads_field_else_defaults_ko() {
        assert_eq!(
            language_from_settings(Some(&json!({"language": "en"}))),
            Lang::En
        );
        assert_eq!(
            language_from_settings(Some(&json!({"language": "ko"}))),
            Lang::Ko
        );
        // 다른 키만 있고 language 부재 → 기본 ko.
        assert_eq!(
            language_from_settings(Some(&json!({"iconSet": "lucide"}))),
            Lang::Ko
        );
        // 설정 자체가 없음(부팅 극초기·빈 DB) → 기본 ko.
        assert_eq!(language_from_settings(None), Lang::Ko);
    }

    // 실 DB 왕복: 설정 language=en 을 kv 에 넣으면 조회가 영어로 해소한다 — 사람 표면이 설정을
    // 실제로 존중함을 증명한다. 설정 부재면 ko(빈 DB 부팅과 같은 규칙).
    #[test]
    fn app_language_from_conn_honors_persisted_setting() {
        let conn = Connection::open_in_memory().expect("in-memory db");
        data::init_base(&conn).expect("base schema");
        // 설정 부재 = 프론트 기본(ko).
        assert_eq!(app_language_from_conn(&conn), Lang::Ko);
        // 프론트가 영어로 바꾸면 사람 표면도 영어.
        data::store::kv_set(&conn, "core", "settings", &json!({"language": "en"}))
            .expect("persist settings");
        assert_eq!(app_language_from_conn(&conn), Lang::En);
    }

    // 복구 고지는 해소된 언어로 갈린다 — 슬롯 번호는 언어 독립(같은 자리).
    #[test]
    fn recovery_body_splits_by_language() {
        let en = recovery_body(Lang::En, Some(2));
        assert!(en.contains("backup slot 2"), "en 본문: {en}");
        assert!(!en.contains('손'), "en 본문에 한글이 새면 안 된다: {en}");
        let ko = recovery_body(Lang::Ko, Some(2));
        assert!(ko.contains("백업 슬롯 2"), "ko 본문: {ko}");
        assert!(
            !ko.contains("backup"),
            "ko 본문에 영어가 새면 안 된다: {ko}"
        );
        // 전 슬롯 실패(빈 DB)도 두 언어로 갈린다.
        assert!(
            recovery_body(Lang::En, None).contains("empty store"),
            "en 빈저장소"
        );
        assert!(
            recovery_body(Lang::Ko, None).contains("빈 저장소"),
            "ko 빈저장소"
        );
    }

    #[test]
    fn recovery_title_splits_by_language() {
        assert_eq!(recovery_title(Lang::En), "Data recovery");
        assert_eq!(recovery_title(Lang::Ko), "데이터 복구");
    }

    // 백업 실패 고지는 언어로 갈리고 서로의 언어가 새지 않는다.
    #[test]
    fn backup_failed_splits_by_language() {
        assert_eq!(backup_failed_title(Lang::En), "Backup failed");
        assert_eq!(backup_failed_title(Lang::Ko), "백업 실패");
        assert!(backup_failed_body(Lang::En).contains("backup"), "en 본문");
        assert!(
            !backup_failed_body(Lang::En).contains('백'),
            "en 본문에 한글 누출 금지"
        );
        assert!(backup_failed_body(Lang::Ko).contains("백업"), "ko 본문");
        assert!(
            !backup_failed_body(Lang::Ko).contains("backup"),
            "ko 본문에 영어 누출 금지"
        );
    }

    // 열기 실패 고지는 언어로 갈리고 격리 경로를 그대로 싣는다.
    #[test]
    fn open_failed_carries_quarantine_path() {
        let en = open_failed_body(Lang::En, "/x/soksak.db.corrupt-42");
        assert!(en.contains("/x/soksak.db.corrupt-42"), "en 격리 경로: {en}");
        assert!(!en.contains('격'), "en 본문에 한글 누출 금지");
        let ko = open_failed_body(Lang::Ko, "/x/soksak.db.corrupt-42");
        assert!(ko.contains("/x/soksak.db.corrupt-42"), "ko 격리 경로: {ko}");
        assert!(!ko.contains("recovery"), "ko 본문에 영어 누출 금지");
        assert_eq!(open_failed_title(Lang::En), "Data could not be opened");
        assert_eq!(open_failed_title(Lang::Ko), "데이터를 열 수 없음");
    }
}
