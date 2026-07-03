// 멀티 윈도우 — 새 OS 창 생성·열거·포커스·닫기. 같은 frontendDist 를 로드해 각 창이 독립
// 작업공간(프로젝트 탭/세션)이 된다(sessions store 는 메모리라 webview 별 JS 컨텍스트가 자연 격리;
// settings/theme/plugins 는 localStorage 공유 — 의도적 전역). 소켓·플러그인·설정은 1 프로세스 공유.
//
// 새 창은 생성 직후 그 label 로 네이티브 hook(레이어 역전·신호등)을 설치해 hole-punch 브라우저가
// 이 창에서도 동작한다(P0 창별 HashMap 덕 — webview.rs layer 참조).

use std::sync::atomic::{AtomicUsize, Ordering};

use tauri::{AppHandle, Manager, WebviewWindowBuilder};

static WIN_SEQ: AtomicUsize = AtomicUsize::new(1);

// 한 창의 네이티브를 설치하는 단일 진입점(MW1) — main(setup)·새 창(window_create)이 같은 함수를
// 호출해 중복·누락을 막는다. 레이어 역전(hole-punch)과 신호등을 그 창에 건다. 앱 전역 모니터
// (클릭·라이브리사이즈)는 창과 무관하게 1회만 설치되므로 여기 포함하지 않는다(lib.rs setup).
// 신호등 inset 좌표(conf trafficLightPosition, 전 창 공통 정책·단일 진실). 미설정 시 (12,20).
// 창별 즉시 적용(install_window_natives)과 앱 전역 유지 옵저버(titlebar::install_global_observers)가 공유.
#[cfg(target_os = "macos")]
pub fn traffic_light_inset(app: &AppHandle) -> (f64, f64) {
    app.config()
        .app
        .windows
        .first()
        .and_then(|w| w.traffic_light_position.as_ref())
        .map(|p| (p.x, p.y))
        .unwrap_or((12.0, 20.0))
}

#[cfg(target_os = "macos")]
pub fn install_window_natives(app: &AppHandle, label: &str) {
    crate::webview::install_layer_inversion(app, label);
    if let Some(window) = app.get_window(label) {
        let (x, y) = traffic_light_inset(app);
        crate::titlebar::install(&window, x, y);
    }
}

// 새 창 생성(소켓 명령 window.new 의 핸들러). 본체는 create_window 가 소유 — Dock 메뉴 등 명령 밖
// 호출처와 공용이다.
#[tauri::command]
pub fn window_create(app: AppHandle, init: Option<String>) -> Result<String, String> {
    create_window_init(&app, init.as_deref())
}

// 새 창 생성(기존 시그니처 유지 — Dock 메뉴 등 init 불요 호출부).
pub fn create_window(app: &AppHandle) -> Result<String, String> {
    create_window_init(app, None)
}

// 새 창 생성 본체. label = "win-<seq>". 같은 앱(index.html)을 로드한다. 반환 = 생성된 창 label.
// 메인 스레드에서 호출해야 안전(WebviewWindowBuilder). 명령(window_create)과 Dock 메뉴(dockmenu)가
// 공유하는 단일 진입점.
//
// init = 새 창 부트 지시 쿼리스트링("root=<enc>" 등, '?' 제외). 새 창의 main.tsx 부트가
// location.search 로 읽는다 — 창 생성자가 프론트 상태에 직접 손대지 않는 유일한 전달 통로
// (창별 JS 컨텍스트 분리 원칙). 코어는 쿼리의 의미를 강제하지 않는다(부트가 해석).
pub fn create_window_init(app: &AppHandle, init: Option<&str>) -> Result<String, String> {
    // 새 창을 트리거한(현재 활성) 창의 위치·배율을 빌드 전에 캡처 — 빌드 후엔 새 창이 포커스를
    // 가져가 활성 창이 바뀐다. 단일 창("main") 하드코딩이 아니라 is_focused 로 동적 판정(MW1).
    // windows()(Window 레지스트리) — 브라우저 연 창도 포함해야 그 창에서 Cmd+N 한 경우 소스로 잡힌다.
    let src = app
        .windows()
        .values()
        .find(|w| w.is_focused().unwrap_or(false))
        .and_then(|w| Some((w.outer_position().ok()?, w.scale_factor().ok()?)));

    let label = format!("win-{}", WIN_SEQ.fetch_add(1, Ordering::Relaxed));
    // 메인 창 설정(tauri.conf.json windows[0])을 통째로 상속하고 label 만 교체한다 — 타이틀·
    // titleBarStyle·hiddenTitle·신호등·decorations·transparent 등 모든 속성이 메인과 정합한다.
    // 수동 빌더로 일부 속성만 옮기면 conf 와 어긋난다(타이틀 "soksak" 고정, 드래그영역/장식 손실).
    // 단일 진실 = conf. 새 창이 늘어도 메인 창 설정을 바꾸면 같이 따라온다.
    let mut cfg = app
        .config()
        .app
        .windows
        .first()
        .cloned()
        .ok_or_else(|| "창 설정 없음(tauri.conf.json windows[0])".to_string())?;
    cfg.label = label.clone();
    if let Some(q) = init {
        // conf url(App("index.html") | External(devUrl))에 부트 지시 쿼리 부여.
        use tauri::WebviewUrl;
        cfg.url = match &cfg.url {
            WebviewUrl::External(u) => {
                let mut u2 = u.clone();
                u2.set_query(Some(q));
                WebviewUrl::External(u2)
            }
            WebviewUrl::App(p) => {
                let s = p.to_string_lossy();
                let joined = if s.contains('?') { format!("{s}&{q}") } else { format!("{s}?{q}") };
                WebviewUrl::App(joined.into())
            }
            other => other.clone(),
        };
    }
    WebviewWindowBuilder::from_config(app, &cfg)
        .map_err(|e| e.to_string())?
        .build()
        .map_err(|e| e.to_string())?;

    // 활성 창에서 가로·세로 ~1cm(28pt) 캐스케이드 — 정확히 겹치면 새 창이 떴는지 눈으로 알 수 없다.
    // 물리 좌표를 배율로 나눠 논리 좌표로 환산 → 어느 DPI 든 시각적 1cm. 소스 창이 없으면 OS 기본 위치.
    if let (Some((pos, scale)), Some(win)) = (src, app.get_window(&label)) {
        const CASCADE_PT: f64 = 28.0; // ~1cm (72pt = 1in = 2.54cm)
        let _ = win.set_position(tauri::LogicalPosition::new(
            pos.x as f64 / scale + CASCADE_PT,
            pos.y as f64 / scale + CASCADE_PT,
        ));
    }

    // 이 창에 네이티브 설치(레이어 역전·신호등) — main 과 동일한 단일 진입점.
    #[cfg(target_os = "macos")]
    install_window_natives(app, &label);
    Ok(label)
}

// 열린 창 label 목록(소켓/CLI introspection — window 명시 타겟 조회). windows()(Window 레지스트리)
// 를 쓴다 — 브라우저 child 를 연 창은 멀티-webview 라 webview_windows() 에서 빠져 목록에 안 잡힌다.
#[tauri::command]
pub fn window_list(app: AppHandle) -> Vec<String> {
    app.windows().keys().cloned().collect()
}

#[tauri::command]
pub fn window_focus(app: AppHandle, label: String) -> Result<(), String> {
    app.get_window(&label)
        .ok_or_else(|| format!("창 없음: {label}"))?
        .set_focus()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn window_close(app: AppHandle, label: String) -> Result<(), String> {
    app.get_window(&label)
        .ok_or_else(|| format!("창 없음: {label}"))?
        .close()
        .map_err(|e| e.to_string())
}

// MW3 — 규칙을 테스트로 강제한다. 창-종속 리소스가 단일 창("main")을 하드코딩하면(MW1 위반) 빌드가
// 실패한다. 부트스트랩(install_window_natives 의 "main", LAST_FOCUSED 기본값)은 get_*("main") 호출이
// 아니라 통과한다.
#[cfg(test)]
mod mw_rules {
    #[test]
    fn no_hardcoded_main_window() {
        const PATS: [&str; 3] = [
            "get_window(\"main\")",
            "get_webview(\"main\")",
            "get_webview_window(\"main\")",
        ];
        for f in [
            "src/webview.rs",
            "src/ipc.rs",
            "src/window.rs",
            "src/lib.rs",
            "src/dockmenu.rs",
        ] {
            let src = std::fs::read_to_string(f).unwrap_or_default();
            for pat in PATS {
                assert!(
                    !src.contains(pat),
                    "MW1 위반({f}): `{pat}` 하드코딩 — 창-종속 리소스는 창 label 로 키잉하라"
                );
            }
        }
    }

    // MW5 — capability(권한) 스코프도 새 창을 덮어야 한다. windows 가 "main" 만이면 새 창(win-*)이
    // 창-종속 권한(start-dragging·set-focus 등)을 못 받아 드래그조차 안 된다. 소스(.rs)만 보던 전수조사가
    // 이 JSON 가정을 놓쳤던 회귀 — 빌드로 잡는다.
    #[test]
    fn capability_covers_new_windows() {
        let src = std::fs::read_to_string("capabilities/default.json").unwrap_or_default();
        assert!(
            src.contains("win-*") || src.contains("\"*\""),
            "capability default.json 의 windows 스코프가 새 창(win-*)을 포함해야 한다 — \
             \"main\" 단일 창 가정 금지(새 창이 드래그·포커스 권한을 못 받는다)"
        );
    }
}
