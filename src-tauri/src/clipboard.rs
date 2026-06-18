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

use clipboard_rs::{
    Clipboard, ClipboardContext, ClipboardHandler, ClipboardWatcher, ClipboardWatcherContext,
    WatcherShutdown,
};
use tauri::{AppHandle, Emitter, State};

pub struct ClipboardState {
    app: Mutex<Option<AppHandle>>,
    shutdown: Mutex<Option<WatcherShutdown>>,
    // 핸들러와 공유 — clipboard_write 가 마커를 심고, 핸들러가 echo 1회를 소비한다.
    last_written: Arc<Mutex<Option<String>>>,
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

// 순수: self-write echo 억제 결정. 방금 쓴 값과 같으면 마커를 소비하고 false(=emit 안 함).
fn should_emit(last_written: &mut Option<String>, text: &str) -> bool {
    if last_written.as_deref() == Some(text) {
        *last_written = None;
        false
    } else {
        true
    }
}

struct Handler {
    ctx: ClipboardContext,
    app: AppHandle,
    last_written: Arc<Mutex<Option<String>>>,
}

impl ClipboardHandler for Handler {
    fn on_clipboard_change(&mut self) {
        // 텍스트가 아니면(이미지/파일 등) 무시 — v1 은 텍스트 클립만.
        let Ok(text) = self.ctx.get_text() else {
            return;
        };
        if let Ok(mut lw) = self.last_written.lock() {
            if !should_emit(&mut lw, &text) {
                return;
            }
        }
        let _ = self.app.emit("clipboard-change", text);
    }
}

#[tauri::command]
pub fn clipboard_read() -> Result<String, String> {
    let ctx = ClipboardContext::new().map_err(|e| e.to_string())?;
    ctx.get_text().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn clipboard_write(state: State<ClipboardState>, text: String) -> Result<(), String> {
    // echo 억제 마커를 먼저 심는다(set 직후 변경 이벤트가 도착하므로).
    if let Ok(mut lw) = state.last_written.lock() {
        *lw = Some(text.clone());
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
    *guard = Some(shutdown);
    Ok(())
}

// 감시 중단 — shutdown 채널로 워처 스레드 종료.
#[tauri::command]
pub fn clipboard_watch_stop(state: State<ClipboardState>) -> Result<(), String> {
    if let Some(shutdown) = state.shutdown.lock().map_err(|e| e.to_string())?.take() {
        shutdown.stop();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::should_emit;

    // self-write echo 는 1회만 억제(마커 소비), 사용자가 같은 값을 재복사하면 정상 emit.
    #[test]
    fn self_write_suppressed_once_then_emits() {
        let mut lw = Some("hello".to_string());
        assert!(!should_emit(&mut lw, "hello"), "방금 쓴 값의 echo 는 억제");
        assert_eq!(lw, None, "마커 소비됨");
        assert!(should_emit(&mut lw, "hello"), "재복사는 정상 emit");
    }

    #[test]
    fn unrelated_change_emits() {
        let mut lw: Option<String> = None;
        assert!(should_emit(&mut lw, "world"), "마커 없으면 항상 emit");
        let mut lw2 = Some("a".to_string());
        assert!(should_emit(&mut lw2, "b"), "다른 값이면 emit");
        assert_eq!(lw2, Some("a".to_string()), "다른 값엔 마커 보존");
    }
}
