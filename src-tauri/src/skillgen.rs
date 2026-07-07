// 스킬 자동 재생성 스폰 — 레지스트리(플러그인 활성 집합)가 변하면 프런트가 이 명령을 부르고,
// 여기서는 identity 홈의 skill-refresh.json(설치 시 CLI 가 기록)대로 그 CLI 를 `skill refresh` 로
// 분리 스폰한다. 렌더 로직의 단일 진실은 CLI — 앱은 방아쇠만 소유한다(P8 쓰기-스루).
use std::process::{Command, Stdio};

#[tauri::command]
pub fn skill_refresh_spawn() -> Result<bool, String> {
    let home = crate::home::soksak_home();
    let manifest = home.join("skill-refresh.json");
    let Ok(txt) = std::fs::read_to_string(&manifest) else {
        return Ok(false); // 설치 전 — 재생성할 스킬이 없다(오류 아님).
    };
    let v: serde_json::Value = serde_json::from_str(&txt).map_err(|e| e.to_string())?;
    let cli = v["cli"].as_str().ok_or("매니페스트에 cli 없음")?;
    // 환경은 바이너리의 정체성(P9) — 매니페스트의 cli 가 이름별 실물이라 환경 전달이 없다.
    Command::new(cli)
        .args(["skill", "refresh"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("스킬 재생성 스폰 실패: {e}"))?;
    Ok(true)
}
