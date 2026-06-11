// 파일 트리 라이브 갱신용 파일시스템 워처. 폴링 없음 — OS 네이티브 이벤트(macOS=FSEvents,
// Linux=inotify, Windows=ReadDirectoryChangesW)를 notify 가 추상화한다. lazy 트리와 짝을
// 이뤄, 프론트가 "펼친(로드된) 디렉토리"만 비재귀로 watch 하고, 변경 시 그 디렉토리만
// 다시 list 해 증분 반영한다. 거대 트리 전체를 재귀 감시하지 않으므로 폭주하지 않는다.

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use notify_debouncer_mini::notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};
use tauri::{AppHandle, Emitter, State};

pub struct FsWatcher {
    debouncer: Mutex<Option<Debouncer<RecommendedWatcher>>>,
    watched: Mutex<HashSet<PathBuf>>,
}

impl Default for FsWatcher {
    fn default() -> Self {
        Self {
            debouncer: Mutex::new(None),
            watched: Mutex::new(HashSet::new()),
        }
    }
}

impl FsWatcher {
    // 앱 setup 에서 1회 초기화. 변경 이벤트의 "부모 디렉토리"를 프론트로 emit 한다
    // (디렉토리 D 안에 파일/폴더가 추가·삭제·이름변경되면 그 변화는 D 에서 관찰된다).
    pub fn init(&self, app: AppHandle) {
        let debouncer = new_debouncer(
            Duration::from_millis(250),
            move |res: DebounceEventResult| {
                let Ok(events) = res else { return };
                let mut dirs: HashSet<String> = HashSet::new();
                for ev in events {
                    // 변경된 항목의 부모 = 다시 list 할 디렉토리. 부모가 없으면(루트) 스킵.
                    if let Some(parent) = ev.path.parent() {
                        dirs.insert(parent.to_string_lossy().to_string());
                    }
                }
                for d in dirs {
                    let _ = app.emit("fs-change", d);
                }
            },
        );
        if let Ok(d) = debouncer {
            *self.debouncer.lock().unwrap() = Some(d);
        }
    }
}

// 디렉토리 하나를 비재귀로 감시(이미 감시 중이면 무시). lazy 트리가 폴더를 로드할 때 호출.
#[tauri::command]
pub fn watch_dir(state: State<FsWatcher>, path: String) -> Result<(), String> {
    let pb = PathBuf::from(&path);
    let mut watched = state.watched.lock().map_err(|e| e.to_string())?;
    if watched.contains(&pb) {
        return Ok(());
    }
    let mut guard = state.debouncer.lock().map_err(|e| e.to_string())?;
    if let Some(d) = guard.as_mut() {
        d.watcher()
            .watch(&pb, RecursiveMode::NonRecursive)
            .map_err(|e| e.to_string())?;
        watched.insert(pb);
    }
    Ok(())
}

// 디렉토리 감시 해제(트리 언마운트·서브트리 삭제 시 FSEvents 핸들 정리).
#[tauri::command]
pub fn unwatch_dir(state: State<FsWatcher>, path: String) -> Result<(), String> {
    let pb = PathBuf::from(&path);
    let mut watched = state.watched.lock().map_err(|e| e.to_string())?;
    if !watched.remove(&pb) {
        return Ok(());
    }
    let mut guard = state.debouncer.lock().map_err(|e| e.to_string())?;
    if let Some(d) = guard.as_mut() {
        let _ = d.watcher().unwatch(&pb);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Instant;

    // 비재귀 감시가 "새 파일 생성"을 잡아 부모 디렉토리를 보고하는지(= fs-change 가
    // emit 될 디렉토리) 실제 파일시스템에서 검증. 워처 콜백의 부모추출 로직과 동일.
    #[test]
    fn non_recursive_watch_detects_new_file() {
        let dir = std::env::temp_dir().join(format!(
            "soksak-watch-new-{}-{}",
            std::process::id(),
            Instant::now().elapsed().as_nanos()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // FSEvents 는 realpath 로 보고 → temp(/var→/private/var 심링크)와 맞추려 canonicalize.
        let dir = dir.canonicalize().unwrap();

        let (tx, rx) = mpsc::channel::<String>();
        let mut debouncer = new_debouncer(
            Duration::from_millis(100),
            move |res: DebounceEventResult| {
                if let Ok(events) = res {
                    for ev in events {
                        if let Some(p) = ev.path.parent() {
                            let _ = tx.send(p.to_string_lossy().to_string());
                        }
                    }
                }
            },
        )
        .unwrap();
        debouncer
            .watcher()
            .watch(&dir, RecursiveMode::NonRecursive)
            .unwrap();

        std::thread::sleep(Duration::from_millis(300)); // 워처 무장 대기
        std::fs::write(dir.join("new_file.txt"), b"hello").unwrap();

        let got = rx
            .recv_timeout(Duration::from_secs(8))
            .expect("워처가 새 파일 이벤트를 보고하지 않음");
        assert_eq!(got, dir.to_string_lossy(), "보고된 부모 디렉토리가 감시 대상과 일치");

        let _ = std::fs::remove_dir_all(&dir);
    }

    // 기존 파일 내용 갱신(쓰기)도 감지하는지 검증(사용자 시나리오: scriptgen 의 result.json 갱신).
    #[test]
    fn non_recursive_watch_detects_modify() {
        let dir = std::env::temp_dir().join(format!(
            "soksak-watch-mod-{}-{}",
            std::process::id(),
            Instant::now().elapsed().as_nanos()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let dir = dir.canonicalize().unwrap();
        let file = dir.join("result.json");
        std::fs::write(&file, b"{}").unwrap();

        let (tx, rx) = mpsc::channel::<String>();
        let mut debouncer = new_debouncer(
            Duration::from_millis(100),
            move |res: DebounceEventResult| {
                if let Ok(events) = res {
                    for ev in events {
                        if let Some(p) = ev.path.parent() {
                            let _ = tx.send(p.to_string_lossy().to_string());
                        }
                    }
                }
            },
        )
        .unwrap();
        debouncer
            .watcher()
            .watch(&dir, RecursiveMode::NonRecursive)
            .unwrap();

        std::thread::sleep(Duration::from_millis(300));
        std::fs::write(&file, b"{\"changed\":true}").unwrap();

        let got = rx
            .recv_timeout(Duration::from_secs(8))
            .expect("워처가 파일 갱신 이벤트를 보고하지 않음");
        assert_eq!(got, dir.to_string_lossy());

        let _ = std::fs::remove_dir_all(&dir);
    }
}
