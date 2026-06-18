// OS 알림 capability — tauri-plugin-notification 위. reminder·발화 알림을 띄운다(비포커스 시 모바일식
// 푸시 동급 1급 객체). notify.show registry 가 이 실행기를 부르고, 스케줄러 reminder 도 show() 를 부른다
// (Rust 내부 공용). 클릭→명령 라우팅은 딥링크(soksak://)가 담당한다 — 데스크톱 알림은 per-notification
// 클릭 액션을 플랫폼이 지원하지 않으므로 딥링크가 그 자리를 메운다(deeplink.rs).

use tauri::AppHandle;
use tauri_plugin_notification::NotificationExt;

/// 알림 표시(Rust 내부 공용 — 스케줄러 reminder/발화). 권한/표시 실패는 Err 로 전파(조용한 실패 0).
pub fn show(app: &AppHandle, title: &str, body: &str) -> Result<(), String> {
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn notify_show(app: AppHandle, title: String, body: String) -> Result<(), String> {
    show(&app, &title, &body)
}
