// 앱 본체 원격 자동 업데이트 — release 채널만. tauri-plugin-updater 가 gh release 의 latest.json 을
// 조회하고 서명 검증된 새 .app 번들을 설치한다. 설치는 재기동과 분리한다: 오케스트레이터(update.apply)가
// 다른 핫 축(플러그인·사이드카·ptyd)을 먼저 무중단 반영한 뒤, 앱 본체를 최후에 relaunch 한다(HS1 순서).
// debug/dev 앱은 원격 updater 가 없다(HOME: 앱 본체는 로컬 빌드) — 채널 게이트가 available:false 로 막는다.
use serde_json::{json, Value};
use tauri_plugin_updater::UpdaterExt;

/// 이 홈이 원격 앱 본체 업데이트를 받는 채널인지 — release 만 참(HOME 정책).
fn remote_channel() -> bool {
    crate::home::is_release()
}

#[tauri::command]
pub async fn update_check(app: tauri::AppHandle) -> Result<Value, String> {
    if !remote_channel() {
        // debug/dev — 앱 본체는 로컬 빌드라 원격 조회 자체가 성립하지 않는다.
        return Ok(json!({ "available": false, "channel": "local" }));
    }
    let updater = app.updater().map_err(|e| e.to_string())?;
    match updater.check().await.map_err(|e| e.to_string())? {
        Some(u) => Ok(json!({
            "available": true,
            "channel": "release",
            "version": u.version,
            "currentVersion": u.current_version,
            "notes": u.body,
        })),
        None => Ok(json!({ "available": false, "channel": "release" })),
    }
}

#[tauri::command]
pub async fn update_apply(app: tauri::AppHandle) -> Result<Value, String> {
    if !remote_channel() {
        return Err("app-body remote update is release-channel only".to_string());
    }
    let updater = app.updater().map_err(|e| e.to_string())?;
    let Some(update) = updater.check().await.map_err(|e| e.to_string())? else {
        return Ok(json!({ "installed": false }));
    };
    let version = update.version.clone();
    update
        .download_and_install(|_chunk, _total| {}, || {})
        .await
        .map_err(|e| e.to_string())?;
    // 설치 완료. 재기동은 오케스트레이터가 app_relaunch 로 마지막에 부른다(HS1: 앱 본체 relaunch 가 최후,
    // 복원 사다리가 창·터미널 세션을 되살려 끊김 없는 재시작).
    Ok(json!({ "installed": true, "version": version }))
}

#[tauri::command]
pub fn app_relaunch(app: tauri::AppHandle) -> Result<(), String> {
    // app.restart() 는 반환하지 않는다 — 프로세스를 새 판으로 교체한다.
    app.restart();
}
