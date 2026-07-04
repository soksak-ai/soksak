// 프로젝트 전역 단일 오픈 레지스트리 — workspace P6 의 시행 지점(단일 진실).
// 하나의 프로젝트(정규화 root)는 전 창을 통틀어 최대 1곳에만 열린다. 정체성=root(P4)라
// "같은 폴더 다른 프로젝트"는 정의상 불가 — 이 레지스트리가 그 전역 시행이다.
//
// in-memory 싱글톤(프로세스 수명): 재기동 = 빈 레지스트리라 crash-stale claim 이 없다.
// 변이는 app.emit("project-registry-change") 로 전 창에 브로드캐스트(크로스윈도우 상태
// 규칙 — Rust 싱글톤 + emit). 프론트 가드(sessions P5, 창-로컬 dedup)는 UX 보조일 뿐
// 시행이 아니다. 충돌 응답은 소유 창 label — 호출측은 그 창을 포커스한다(중복 창 생성 금지).

use std::collections::HashMap;
use std::sync::Mutex;

#[derive(Default)]
pub struct ProjectRegistry {
    // 정규화 root 경로 → 소유 창 label. 정규화는 호출부(validate_project_root) 책임.
    map: Mutex<HashMap<String, String>>,
}

impl ProjectRegistry {
    /// root 를 label 창이 점유. 이미 다른 창이 점유 중이면 Err(그 창 label).
    /// 같은 창의 재청구는 멱등 Ok(복원·재시도 경로가 안전하도록).
    pub fn claim(&self, root: &str, label: &str) -> Result<(), String> {
        let mut m = self.map.lock().unwrap();
        match m.get(root) {
            Some(owner) if owner != label => Err(owner.clone()),
            _ => {
                m.insert(root.to_string(), label.to_string());
                Ok(())
            }
        }
    }

    /// root 해제 — 소유 창(label)의 요청일 때만 제거. 반환 = 실제로 제거됐는가.
    pub fn release(&self, root: &str, label: &str) -> bool {
        let mut m = self.map.lock().unwrap();
        match m.get(root) {
            Some(owner) if owner == label => {
                m.remove(root);
                true
            }
            _ => false,
        }
    }

    /// 창 파괴 시 그 창의 모든 점유 해제. 반환 = 해제된 root 목록.
    pub fn release_window(&self, label: &str) -> Vec<String> {
        let mut m = self.map.lock().unwrap();
        let roots: Vec<String> = m
            .iter()
            .filter(|(_, v)| v.as_str() == label)
            .map(|(k, _)| k.clone())
            .collect();
        for r in &roots {
            m.remove(r);
        }
        roots
    }

    /// root 의 현재 소유 창 label.
    pub fn owner(&self, root: &str) -> Option<String> {
        self.map.lock().unwrap().get(root).cloned()
    }

    /// 전체 스냅샷(진단·list 커맨드용).
    pub fn snapshot(&self) -> Vec<(String, String)> {
        let mut v: Vec<(String, String)> = self
            .map
            .lock()
            .unwrap()
            .iter()
            .map(|(k, val)| (k.clone(), val.clone()))
            .collect();
        v.sort();
        v
    }
}

// ── Tauri 커맨드 계층 ─────────────────────────────────────────────────────────
// 변이는 전 창 브로드캐스트("project-registry-change") — 크로스윈도우 반응(픽커 최근목록
// 비활성화 표시 등)은 이 신호를 listen 한다(폴링 금지).

fn emit_change<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    use tauri::Emitter;
    let _ = app.emit("project-registry-change", ());
}

/// root 점유 시도. 성공 {ok:true}, 충돌 {ok:false, ownedBy:<label>}.
/// window = 호출 창(자동 인지 — 프론트 label 전달 불요).
#[tauri::command]
pub fn project_claim(
    app: tauri::AppHandle,
    window: tauri::Window,
    state: tauri::State<'_, ProjectRegistry>,
    root: String,
) -> serde_json::Value {
    match state.claim(&root, window.label()) {
        Ok(()) => {
            emit_change(&app);
            serde_json::json!({ "ok": true })
        }
        Err(owner) => serde_json::json!({ "ok": false, "ownedBy": owner }),
    }
}

/// root 해제(소유 창만). 반환 { released }.
#[tauri::command]
pub fn project_release(
    app: tauri::AppHandle,
    window: tauri::Window,
    state: tauri::State<'_, ProjectRegistry>,
    root: String,
) -> serde_json::Value {
    let released = state.release(&root, window.label());
    if released {
        emit_change(&app);
    }
    serde_json::json!({ "released": released })
}

/// 전역 점유 스냅샷 { owners: [{root,window}] } — 픽커의 "다른 창에 열림" 표시용.
#[tauri::command]
pub fn project_owners(
    app: tauri::AppHandle,
    state: tauri::State<'_, ProjectRegistry>,
) -> serde_json::Value {
    use tauri::Manager;
    // 자가치유: 살아있는 창의 점유만 보고한다. Destroyed 이벤트를 못 받는 경로(SIGKILL·라벨
    // 재사용 레이스)가 남긴 유령 점유가 픽커/오케스트레이터에 "열림"으로 표면화되는 것을
    // 구조적으로 차단(실측: 닫힌 프로젝트가 열림+선택으로 표시).
    let owners: Vec<serde_json::Value> = state
        .snapshot()
        .into_iter()
        .filter(|(_, window)| app.get_window(window).is_some())
        .map(|(root, window)| serde_json::json!({ "root": root, "window": window }))
        .collect();
    serde_json::json!({ "owners": owners })
}

/// 창 파괴 시 정리(lib.rs WindowEvent::Destroyed 에서 호출).
pub fn on_window_destroyed<R: tauri::Runtime>(app: &tauri::AppHandle<R>, label: &str) {
    let st = {
        use tauri::Manager;
        app.state::<ProjectRegistry>()
    };
    if !st.release_window(label).is_empty() {
        emit_change(app);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 중복_claim_은_소유_창을_알린다() {
        let r = ProjectRegistry::default();
        assert!(r.claim("/a", "main").is_ok());
        assert_eq!(r.claim("/a", "win-1"), Err("main".to_string()));
        assert_eq!(r.owner("/a").as_deref(), Some("main"));
    }

    #[test]
    fn 같은_창의_재청구는_멱등() {
        let r = ProjectRegistry::default();
        assert!(r.claim("/a", "main").is_ok());
        assert!(r.claim("/a", "main").is_ok());
    }

    #[test]
    fn release_후_재claim_성공() {
        let r = ProjectRegistry::default();
        assert!(r.claim("/a", "main").is_ok());
        assert!(r.release("/a", "main"));
        assert!(r.claim("/a", "win-1").is_ok());
        assert_eq!(r.owner("/a").as_deref(), Some("win-1"));
    }

    #[test]
    fn 비소유_창의_release_는_무효() {
        let r = ProjectRegistry::default();
        assert!(r.claim("/a", "main").is_ok());
        assert!(!r.release("/a", "win-1")); // 남의 점유는 못 푼다
        assert_eq!(r.owner("/a").as_deref(), Some("main"));
    }

    #[test]
    fn 창_파괴는_그_창의_점유만_전부_해제() {
        let r = ProjectRegistry::default();
        assert!(r.claim("/a", "win-1").is_ok());
        assert!(r.claim("/b", "win-1").is_ok());
        assert!(r.claim("/c", "main").is_ok());
        let mut freed = r.release_window("win-1");
        freed.sort();
        assert_eq!(freed, vec!["/a".to_string(), "/b".to_string()]);
        assert_eq!(r.owner("/a"), None);
        assert_eq!(r.owner("/c").as_deref(), Some("main"));
    }
}
