// 멀티 윈도우 — 새 OS 창 생성·열거·포커스·닫기. 같은 frontendDist 를 로드해 각 창이 독립
// 작업공간(프로젝트 탭/세션)이 된다(sessions store 는 메모리라 webview 별 JS 컨텍스트가 자연 격리;
// settings/theme/plugins 는 localStorage 공유 — 의도적 전역). 소켓·플러그인·설정은 1 프로세스 공유.
//
// 새 창은 생성 직후 그 label 로 네이티브 hook(레이어 역전·신호등)을 설치해 hole-punch 브라우저가
// 이 창에서도 동작한다(P0 창별 HashMap 덕 — webview.rs layer 참조).

use tauri::{AppHandle, Manager, WebviewWindowBuilder};

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
//
// label/rect = 재시작 복원 리스폰(B2) 전용: manifest slot 의 라벨을 그대로 재사용해 그 창의
// 스냅샷 키("window/<label>")가 일치하게 하고, 저장된 프레임(논리 px)으로 같은 자리에 만든다.
// label 지정 창은 fresh 기본이 붙지 않는다(복원이 목적). 이미 존재하는 label 은 멱등(그대로 반환).
#[tauri::command]
pub fn window_create(
    app: AppHandle,
    init: Option<String>,
    label: Option<String>,
    rect: Option<serde_json::Value>,
    // 창을 앞으로 가져와 포커스할지. 기본 true(사용자가 새 창을 열면 그 창이 자연스럽게 포커스).
    // 재시작 복원(리스폰)은 false — 백그라운드로 되살리고 현재 포커스(오케스트레이터 등)를 뺏지 않는다.
    focus: Option<bool>,
) -> Result<String, String> {
    let focus = focus.unwrap_or(true);
    match label {
        None => create_window_init(&app, init.as_deref(), focus),
        Some(label) => {
            if app.get_window(&label).is_some() {
                return Ok(label); // 멱등 — 리스폰 재호출 무해
            }
            let r = rect.as_ref().and_then(|v| {
                Some((
                    v.get("x")?.as_f64()?,
                    v.get("y")?.as_f64()?,
                    v.get("w")?.as_f64()?,
                    v.get("h")?.as_f64()?,
                ))
            });
            create_window_labeled(&app, &label, r, init.as_deref(), focus)
        }
    }
}

// 새 창 생성(기존 시그니처 유지 — Dock 메뉴 등 init 불요 호출부). 사용자 행위라 포커스한다.
pub fn create_window(app: &AppHandle) -> Result<String, String> {
    create_window_init(app, None, true)
}

// 새 창 생성 본체. label = "w-<uuid4>" — 불투명·비재사용 식별자(NAMING). uuid 라 라벨이
// 세션 간 우연히 재사용될 수 없고, 죽은 세션의 영속 슬롯을 유령 복원하는 부류가 존재 자체로
// 불가능하다(과거 win-<seq> 재사용의 실측 사고 근치 — fresh 플래그 패치는 폐기).
// 의도적 재사용은 respawn 뿐: manifest 의 같은 uuid 로 재생성해 그 창의 스냅샷을 되살린다.
// 메인 스레드에서 호출해야 안전(WebviewWindowBuilder). 명령(window_create)과 Dock 메뉴(dockmenu)가
// 공유하는 단일 진입점.
//
// init = 새 창 부트 지시 쿼리스트링("root=<enc>" 등, '?' 제외). 새 창의 main.tsx 부트가
// location.search 로 읽는다 — 창 생성자가 프론트 상태에 직접 손대지 않는 유일한 전달 통로
// (창별 JS 컨텍스트 분리 원칙). 코어는 쿼리의 의미를 강제하지 않는다(부트가 해석).
pub fn create_window_init(
    app: &AppHandle,
    init: Option<&str>,
    focus: bool,
) -> Result<String, String> {
    // 새 창을 트리거한(현재 활성) 창의 위치·배율을 빌드 전에 캡처 — 빌드 후엔 새 창이 포커스를
    // 가져가 활성 창이 바뀐다. 단일 창("main") 하드코딩이 아니라 is_focused 로 동적 판정(MW1).
    // windows()(Window 레지스트리) — 브라우저 연 창도 포함해야 그 창에서 Cmd+N 한 경우 소스로 잡힌다.
    let src = app
        .windows()
        .values()
        .find(|w| w.is_focused().unwrap_or(false))
        .and_then(|w| Some((w.outer_position().ok()?, w.scale_factor().ok()?)));

    let label = format!("w-{}", uuid::Uuid::new_v4());
    create_window_core(app, &label, init, focus)?;

    // 활성 창에서 가로·세로 ~1cm(28pt) 캐스케이드 — 정확히 겹치면 새 창이 떴는지 눈으로 알 수 없다.
    // 물리 좌표를 배율로 나눠 논리 좌표로 환산 → 어느 DPI 든 시각적 1cm. 소스 창이 없으면 OS 기본 위치.
    if let (Some((pos, scale)), Some(win)) = (src, app.get_window(&label)) {
        const CASCADE_PT: f64 = 28.0; // ~1cm (72pt = 1in = 2.54cm)
        let _ = win.set_position(tauri::LogicalPosition::new(
            pos.x as f64 / scale + CASCADE_PT,
            pos.y as f64 / scale + CASCADE_PT,
        ));
    }
    Ok(label)
}

// 재시작 복원 리스폰(B2) — manifest slot 라벨로 창을 만들고 저장된 프레임(논리 px)을 적용한다.
// 캐스케이드 없음(제자리 복원). fresh 기본 없음(이 창의 스냅샷 복원이 목적).
fn create_window_labeled(
    app: &AppHandle,
    label: &str,
    rect: Option<(f64, f64, f64, f64)>,
    init: Option<&str>,
    focus: bool,
) -> Result<String, String> {
    create_window_core(app, label, init, focus)?;
    if let (Some((x, y, w, h)), Some(win)) = (rect, app.get_window(label)) {
        let _ = win.set_position(tauri::LogicalPosition::new(x, y));
        let _ = win.set_size(tauri::LogicalSize::new(w, h));
    }
    Ok(label.to_string())
}

// 창 생성 공용 골격 — conf windows[0] 상속 + label 교체 + init 쿼리 + 네이티브 설치.
fn create_window_core(
    app: &AppHandle,
    label: &str,
    init: Option<&str>,
    focus: bool,
) -> Result<(), String> {
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
    cfg.label = label.to_string();
    // 포커스는 임의로 주지 않는다 — 리스폰(focus=false)은 백그라운드로 되살리고 현재 포커스를
    // 뺏지 않는다. 사용자가 연 새 창(focus=true)만 자연스럽게 앞으로 온다(conf 기본 상속 대신 명시).
    cfg.focus = focus;
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
                let joined = if s.contains('?') {
                    format!("{s}&{q}")
                } else {
                    format!("{s}?{q}")
                };
                WebviewUrl::App(joined.into())
            }
            other => other.clone(),
        };
    }
    WebviewWindowBuilder::from_config(app, &cfg)
        .map_err(|e| e.to_string())?
        .build()
        .map_err(|e| e.to_string())?;

    // 이 창에 네이티브 설치(레이어 역전·신호등) — main 과 동일한 단일 진입점.
    #[cfg(target_os = "macos")]
    install_window_natives(app, label);
    Ok(())
}

// ── 창 닫힘 의미론(B1) ───────────────────────────────────────────────────────
// 명시 종료(Cmd+Q/app.exit)=전 창 세션 보존(재시작 복원 대상), 사용자 개별 닫기(빨간 버튼·
// window.close)=그 창 세션 폐기. 폐기는 두 단계다: CloseRequested 에서 "사용자 닫기" 마크만
// 남기고, 실제 정리는 Destroyed 에서 한다 — 웹뷰 unload(pagehide)의 마지막 저장이 정리 *뒤에*
// 도착해 스냅샷을 부활시키는 순서 결함을 피한다(저장→파괴→정리 순서 보장). 앱 종료의 창
// 파괴는 CloseRequested 를 지나지 않아 마크가 없고, 아무것도 지우지 않는다.

static USER_CLOSED: std::sync::Mutex<Option<std::collections::HashSet<String>>> =
    std::sync::Mutex::new(None);

/// CloseRequested — 사용자가 이 창을 닫는 중임을 기록.
pub fn mark_user_closed(label: &str) {
    let mut g = USER_CLOSED.lock().unwrap();
    g.get_or_insert_with(Default::default)
        .insert(label.to_string());
}

/// Destroyed — 사용자 닫기였는지 회수(1회성). 앱 종료 경로는 false.
pub fn take_user_closed(label: &str) -> bool {
    let mut g = USER_CLOSED.lock().unwrap();
    g.as_mut().map(|s| s.remove(label)).unwrap_or(false)
}

// 창 영속 흔적 정리 — 사용자 개별 닫기의 Destroyed 에서만 호출된다(위 의미론).
// 지우는 것: ① 그 창의 워크스페이스 스냅샷(core kv "window/<label>") ② manifest("windows")의
// 그 창 slot. 식별자가 uuid 라 유령 복원은 없지만, 닫힌 창의 흔적을 남기면 죽은 슬롯이
// manifest 에 쌓여 respawn 대상을 오염시킨다 — 사용자 닫기 = 흔적 폐기가 위생이다.
pub fn prune_window_persistence(conn: &rusqlite::Connection, label: &str) -> Result<(), String> {
    crate::data::store::kv_delete(conn, "core", &format!("window/{label}"))?;
    if let Some(mut m) = crate::data::store::kv_get(conn, "core", "windows")? {
        if let Some(slots) = m.get_mut("slots").and_then(|s| s.as_array_mut()) {
            let before = slots.len();
            slots.retain(|s| s.get("label").and_then(|l| l.as_str()) != Some(label));
            if slots.len() != before {
                crate::data::store::kv_set(conn, "core", "windows", &m)?;
            }
        }
    }
    Ok(())
}

// 열린 창 label 목록(소켓/CLI introspection — window 명시 타겟 조회). windows()(Window 레지스트리)
// 를 쓴다 — 브라우저 child 를 연 창은 멀티-webview 라 webview_windows() 에서 빠져 목록에 안 잡힌다.
#[tauri::command]
pub fn window_list(app: AppHandle) -> Vec<String> {
    app.windows().keys().cloned().collect()
}

// 모니터·창 배치 팩트(A4) — 판단 없이 사실만: 모니터 목록(물리 px rect·배율·이름)과
// 각 창의 물리 rect + 소속 모니터 인덱스. 전략(어디에 둘지)은 layout.suggest 순수함수가
// 프론트에서 계산한다(팩트/전략 분리 — 확정 결정).
#[tauri::command]
pub fn window_monitors(app: AppHandle) -> Result<serde_json::Value, String> {
    let monitors: Vec<tauri::Monitor> = app.available_monitors().map_err(|e| e.to_string())?;
    let mons: Vec<serde_json::Value> = monitors
        .iter()
        .enumerate()
        .map(|(i, m)| {
            serde_json::json!({
                "index": i,
                "name": m.name().cloned().unwrap_or_default(),
                "x": m.position().x,
                "y": m.position().y,
                "w": m.size().width,
                "h": m.size().height,
                "scale": m.scale_factor(),
            })
        })
        .collect();
    let mut wins: Vec<serde_json::Value> = Vec::new();
    for (label, w) in app.windows() {
        let pos = w.outer_position().map_err(|e| e.to_string())?;
        let size = w.outer_size().map_err(|e| e.to_string())?;
        // 소속 모니터 = 창 중심점이 들어가는 모니터(경계 걸친 창은 중심 기준 단일 판정).
        let (cx, cy) = (
            pos.x + size.width as i32 / 2,
            pos.y + size.height as i32 / 2,
        );
        let monitor = monitors.iter().position(|m| {
            let (mx, my) = (m.position().x, m.position().y);
            let (mw, mh) = (m.size().width as i32, m.size().height as i32);
            cx >= mx && cx < mx + mw && cy >= my && cy < my + mh
        });
        wins.push(serde_json::json!({
            "label": label,
            "title": w.title().unwrap_or_default(),
            "alwaysOnTop": w.is_always_on_top().unwrap_or(false),
            "x": pos.x,
            "y": pos.y,
            "w": size.width,
            "h": size.height,
            "focused": w.is_focused().unwrap_or(false),
            "monitor": monitor,
        }));
    }
    Ok(serde_json::json!({ "monitors": mons, "windows": wins }))
}

// 창 배치 실행(A4) — 물리 px(window_monitors 와 같은 좌표계)로 위치+크기 1회 적용.
#[tauri::command]
pub fn window_place(
    app: AppHandle,
    label: String,
    x: i32,
    y: i32,
    w: u32,
    h: u32,
) -> Result<(), String> {
    let win = app
        .get_window(&label)
        .ok_or_else(|| format!("창 없음: {label}"))?;
    win.set_position(tauri::PhysicalPosition::new(x, y))
        .map_err(|e| e.to_string())?;
    win.set_size(tauri::PhysicalSize::new(w, h))
        .map_err(|e| e.to_string())?;
    Ok(())
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

    // MW5 — capability(권한) 스코프도 새 창을 덮어야 한다. windows 가 "main" 만이면 런타임 창(w-*)이
    // 창-종속 권한(event.listen·start-dragging·set-focus 등)을 못 받아 소켓 명령 전부가 무언 TIMEOUT 이
    // 된다(실측 회귀). 소스(.rs)만 보던 전수조사가 이 JSON 가정을 놓친다 — 빌드로 잡는다.
    #[test]
    fn capability_covers_new_windows() {
        let src = std::fs::read_to_string("capabilities/default.json").unwrap_or_default();
        let doc: serde_json::Value = serde_json::from_str(&src).expect("capability JSON 파싱");
        let windows: Vec<&str> = doc["windows"]
            .as_array()
            .expect("windows 배열")
            .iter()
            .filter_map(|v| v.as_str())
            .collect();
        assert!(
            windows.contains(&"w-*") || windows.contains(&"*"),
            "capability windows 스코프가 런타임 창(w-*)을 포함해야 한다 — \
             \"main\" 단일 창 가정 금지(새 창이 listen·드래그·포커스 권한을 못 받는다)"
        );
        assert!(
            windows.contains(&"main"),
            "capability windows 스코프에 컨트롤 플레인(main)이 있어야 한다(NAMING 4b)"
        );
        assert!(
            !windows.contains(&"win-*") && !windows.contains(&"orch-*"),
            "구세대 라벨(win-*·orch-*)은 소멸했다 — capability 재등재 금지(NAMING 4b: 워크스페이스는 w-*, 컨트롤 플레인은 main)"
        );
    }
    // B1 — 창 닫힘 시 영속 흔적 정리: 그 창의 스냅샷 kv 와 manifest slot 만 제거, 남의 것 보존.
    #[test]
    fn prune_window_persistence_removes_only_that_window() {
        let c = rusqlite::Connection::open_in_memory().unwrap();
        c.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        crate::data::init_base(&c).unwrap();
        let set =
            |k: &str, v: serde_json::Value| crate::data::store::kv_set(&c, "core", k, &v).unwrap();
        set(
            "window/w-1",
            serde_json::json!({"activeId":"t1","projects":[{"id":"t1"}]}),
        );
        set(
            "window/main",
            serde_json::json!({"activeId":"t9","projects":[{"id":"t9"}]}),
        );
        set(
            "windows",
            serde_json::json!({"slots":[
                {"label":"w-1","roots":["/a"],"activeRoot":"/a"},
                {"label":"main","roots":["/m"],"activeRoot":"/m"}
            ]}),
        );
        super::prune_window_persistence(&c, "w-1").unwrap();
        assert_eq!(
            crate::data::store::kv_get(&c, "core", "window/w-1").unwrap(),
            None
        );
        assert!(crate::data::store::kv_get(&c, "core", "window/main")
            .unwrap()
            .is_some());
        let m = crate::data::store::kv_get(&c, "core", "windows")
            .unwrap()
            .unwrap();
        let slots = m["slots"].as_array().unwrap();
        assert_eq!(slots.len(), 1);
        assert_eq!(slots[0]["label"], "main");
        // 멱등 — 없는 창 정리는 무해.
        super::prune_window_persistence(&c, "w-1").unwrap();
    }
}
