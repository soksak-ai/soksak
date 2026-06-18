// 클립보드 capability — 시스템 클립보드 텍스트 읽기/쓰기 + 변경 감시. 변경 감시는 OS별로 다르다:
// Windows=WM_CLIPBOARDUPDATE, X11=XFixes, Wayland=wl-data-control 의 네이티브 푸시 이벤트(폴링 0).
// macOS 만 NSPasteboard 에 변경 이벤트 API 가 없어 changeCount 폴링이 유일하다. clipboard-rs 가 이 4
// 백엔드를 단일 ClipboardHandler 추상으로 흡수하고, 코어는 그 변경을 단일 "clipboard-change" 이벤트
// (바뀐 텍스트)로 전 창 브로드캐스트한다 — 플러그인은 OS 분기를 보지 않는다(코어 락인/플랫폼 락인 금지).
//
// self-write 억제: 플러그인이 clipboard_write 로 쓴 값은 곧바로 변경 이벤트로 되돌아온다(echo). 방금 쓴
// 값을 1회 마커로 기억해 그 echo 만 emit 에서 제외한다(사용자가 같은 값을 다시 복사하면 마커가 이미
// 소비됐으므로 정상 emit). 실제 감시 스레드는 플러그인이 watch_start 를 호출할 때만 시작(불필요 폴링 0).

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use clipboard_rs::{
    Clipboard, ClipboardContext, ClipboardHandler, ClipboardWatcher, ClipboardWatcherContext,
    WatcherShutdown,
};
use tauri::{AppHandle, Emitter, State};

// self-write 마커 TTL — macOS changeCount 폴링 윈도우(500ms)+여유. echo 는 이 안에 도착한다.
// 이보다 길면 동일 값 사용자 복사를 잘못 억제(false-suppression)하므로 짧게 유지한다.
const SELF_WRITE_TTL: Duration = Duration::from_secs(2);

pub struct ClipboardState {
    app: Mutex<Option<AppHandle>>,
    shutdown: Mutex<Option<WatcherShutdown>>,
    // 핸들러와 공유 — clipboard_write 가 (값, 시각) 마커를 심고, 핸들러가 echo 1회를 소비한다.
    last_written: Arc<Mutex<Option<(String, Instant)>>>,
}

impl Default for ClipboardState {
    fn default() -> Self {
        Self {
            app: Mutex::new(None),
            shutdown: Mutex::new(None),
            last_written: Arc::new(Mutex::new(None)),
        }
    }
}

impl ClipboardState {
    // 앱 setup 에서 1회 — 이벤트 emit 에 쓸 앱 핸들 주입. 감시 스레드는 watch_start 에서 시작.
    pub fn init(&self, app: AppHandle) {
        *self.app.lock().unwrap() = Some(app);
    }
}

// 순수: self-write echo 억제 결정(TTL 인지). 마커가 있을 때:
//  - 만료(now-t >= ttl): 마커 정리 후 true — 잔존 마커가 정상 복사를 삼키지 않게.
//  - 신선·동일값: 마커 소비(None) 후 false — echo 1회만 억제.
//  - 신선·다른값: stale 마커 정리(None) 후 true — 다른 값이 도착했으면 더 기다릴 이유 없음.
// 마커가 없으면 항상 true.
fn should_emit(marker: &mut Option<(String, Instant)>, text: &str, now: Instant, ttl: Duration) -> bool {
    match marker {
        Some((v, t)) => {
            if now.duration_since(*t) >= ttl {
                *marker = None;
                true
            } else if v == text {
                *marker = None;
                false
            } else {
                *marker = None;
                true
            }
        }
        None => true,
    }
}

struct Handler {
    ctx: ClipboardContext,
    app: AppHandle,
    last_written: Arc<Mutex<Option<(String, Instant)>>>,
}

impl ClipboardHandler for Handler {
    fn on_clipboard_change(&mut self) {
        // 텍스트가 아니면(이미지/파일 등) 무시 — v1 은 텍스트 클립만.
        let Ok(text) = self.ctx.get_text() else {
            return;
        };
        if let Ok(mut lw) = self.last_written.lock() {
            if !should_emit(&mut lw, &text, Instant::now(), SELF_WRITE_TTL) {
                return;
            }
        }
        let _ = self.app.emit("clipboard-change", text);
    }
}

#[tauri::command]
pub fn clipboard_read() -> Result<String, String> {
    let ctx = ClipboardContext::new().map_err(|e| e.to_string())?;
    // 비텍스트(이미지/파일 등) 클립이면 에러 대신 빈 문자열 — 호출자는 텍스트만 다룬다.
    Ok(ctx.get_text().unwrap_or_default())
}

#[tauri::command]
pub fn clipboard_write(state: State<ClipboardState>, text: String) -> Result<(), String> {
    // echo 억제 마커를 먼저 심는다(set 직후 변경 이벤트가 도착하므로). 값+시각을 함께 기록.
    if let Ok(mut lw) = state.last_written.lock() {
        *lw = Some((text.clone(), Instant::now()));
    }
    let ctx = ClipboardContext::new().map_err(|e| e.to_string())?;
    ctx.set_text(text).map_err(|e| e.to_string())
}

// 감시 시작(멱등) — 이미 감시 중이면 무시. clipboard-rs 워처를 스레드에서 돌리고 shutdown 채널 보관.
#[tauri::command]
pub fn clipboard_watch_start(state: State<ClipboardState>) -> Result<(), String> {
    let mut guard = state.shutdown.lock().map_err(|e| e.to_string())?;
    if guard.is_some() {
        return Ok(());
    }
    let app = state
        .app
        .lock()
        .map_err(|e| e.to_string())?
        .clone()
        .ok_or("clipboard 미초기화(setup init 누락)")?;
    let ctx = ClipboardContext::new().map_err(|e| e.to_string())?;
    let handler = Handler {
        ctx,
        app,
        last_written: state.last_written.clone(),
    };
    let mut watcher: ClipboardWatcherContext<Handler> =
        ClipboardWatcherContext::new().map_err(|e| e.to_string())?;
    let shutdown = watcher.add_handler(handler).get_shutdown_channel();
    std::thread::spawn(move || {
        watcher.start_watch();
    });
    // 이전 세션의 잔존 마커를 정리 — 첫 정상 복사를 삼키지 않게.
    if let Ok(mut lw) = state.last_written.lock() {
        *lw = None;
    }
    *guard = Some(shutdown);
    Ok(())
}

// 감시 중단 — shutdown 채널로 워처 스레드 종료.
#[tauri::command]
pub fn clipboard_watch_stop(state: State<ClipboardState>) -> Result<(), String> {
    if let Some(shutdown) = state.shutdown.lock().map_err(|e| e.to_string())?.take() {
        shutdown.stop();
    }
    // 마커 정리 — 다음 watch_start 까지 잔존하지 않게.
    if let Ok(mut lw) = state.last_written.lock() {
        *lw = None;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{should_emit, SELF_WRITE_TTL};
    use std::time::{Duration, Instant};

    // (a) 신선·동일값: echo 1회만 억제(마커 소비), 이후엔 마커 없어 정상 emit.
    #[test]
    fn fresh_self_write_suppressed_once_then_emits() {
        let t0 = Instant::now();
        let mut lw = Some(("hello".to_string(), t0));
        assert!(
            !should_emit(&mut lw, "hello", t0, SELF_WRITE_TTL),
            "신선한 방금 쓴 값의 echo 는 억제"
        );
        assert_eq!(lw, None, "마커 소비됨");
        assert!(
            should_emit(&mut lw, "hello", t0, SELF_WRITE_TTL),
            "마커 없으면 재복사 정상 emit"
        );
    }

    // (b) 만료: TTL 이상 경과한 마커는 동일값이라도 emit + 마커 정리.
    #[test]
    fn expired_marker_emits_and_clears() {
        let t0 = Instant::now();
        let now = t0 + SELF_WRITE_TTL + Duration::from_millis(1);
        let mut lw = Some(("hello".to_string(), t0));
        assert!(
            should_emit(&mut lw, "hello", now, SELF_WRITE_TTL),
            "만료 마커는 동일값이라도 emit"
        );
        assert_eq!(lw, None, "만료 마커 정리됨");
    }

    // (c) 신선·다른값: emit + stale 마커 정리.
    #[test]
    fn fresh_different_value_emits_and_clears() {
        let t0 = Instant::now();
        let mut lw = Some(("a".to_string(), t0));
        assert!(
            should_emit(&mut lw, "b", t0, SELF_WRITE_TTL),
            "다른 값이면 emit"
        );
        assert_eq!(lw, None, "다른 값 도착 시 stale 마커 정리");
    }

    // 마커 없으면 항상 emit.
    #[test]
    fn no_marker_always_emits() {
        let t0 = Instant::now();
        let mut lw: Option<(String, Instant)> = None;
        assert!(should_emit(&mut lw, "world", t0, SELF_WRITE_TTL), "마커 없으면 항상 emit");
    }
}
