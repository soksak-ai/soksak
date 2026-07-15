// 파일 트리 라이브 갱신용 파일시스템 워처. 폴링 없음 — OS 네이티브 이벤트(macOS=FSEvents,
// Linux=inotify, Windows=ReadDirectoryChangesW)를 notify 가 추상화한다. lazy 트리와 짝을
// 이뤄, 프론트가 "펼친(로드된) 디렉토리"만 비재귀로 watch 하고, 변경 시 그 디렉토리만
// 다시 list 해 증분 반영한다. 거대 트리 전체를 재귀 감시하지 않으므로 폭주하지 않는다.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use notify_debouncer_mini::notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};
use tauri::{AppHandle, Emitter, State};

pub struct FsWatcher {
    debouncer: Mutex<Option<Debouncer<RecommendedWatcher>>>,
    // 경로 → 소비자 refcount. OS watch 는 경로당 1개(0→1 에서 장착, 1→0 에서 해제).
    // 여러 창·플러그인이 같은 경로를 watch 해도 서로의 해제에 깨지지 않는다(W8 M1 dedup 계약).
    watched: Mutex<HashMap<PathBuf, usize>>,
}

impl Default for FsWatcher {
    fn default() -> Self {
        Self {
            debouncer: Mutex::new(None),
            watched: Mutex::new(HashMap::new()),
        }
    }
}

impl FsWatcher {
    // 앱 setup 에서 1회 초기화. 변경 이벤트의 "부모 디렉토리"를 프론트로 emit 한다
    // (디렉토리 D 안에 파일/폴더가 추가·삭제·이름변경되면 그 변화는 D 에서 관찰된다).
    pub fn init(&self, app: AppHandle) {
        self.init_with(move |d| {
            let _ = app.emit("fs-change", d);
        });
    }

    // emit 싱크 주입판 — 코어는 AppHandle 로, 테스트는 채널로 관찰한다.
    pub fn init_with(&self, sink: impl Fn(String) + Send + 'static) {
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
                    sink(d);
                }
            },
        );
        if let Ok(d) = debouncer {
            *self.debouncer.lock().unwrap() = Some(d);
        }
    }

    // 감시 등록 — refcount 를 올리고, 첫 소비자(0→1)에서만 OS watch 를 장착한다.
    // 반환 = 등록 후 refcount(관찰면 — 커맨드 응답으로 노출).
    pub fn watch(&self, path: &str) -> Result<usize, String> {
        let pb = PathBuf::from(path);
        let mut watched = self.watched.lock().map_err(|e| e.to_string())?;
        if let Some(n) = watched.get_mut(&pb) {
            *n += 1;
            return Ok(*n);
        }
        let mut guard = self.debouncer.lock().map_err(|e| e.to_string())?;
        if let Some(d) = guard.as_mut() {
            d.watcher()
                .watch(&pb, RecursiveMode::NonRecursive)
                .map_err(|e| e.to_string())?;
            watched.insert(pb, 1);
            return Ok(1);
        }
        Err("워처 미초기화".into())
    }

    // 감시 해제 — refcount 를 내리고, 마지막 소비자(1→0)에서만 OS watch 를 해제한다.
    // 미등록 경로 해제는 no-op(멱등). 반환 = 해제 후 refcount.
    pub fn unwatch(&self, path: &str) -> Result<usize, String> {
        let pb = PathBuf::from(path);
        let mut watched = self.watched.lock().map_err(|e| e.to_string())?;
        let Some(n) = watched.get_mut(&pb) else {
            return Ok(0);
        };
        *n -= 1;
        if *n > 0 {
            return Ok(*n);
        }
        watched.remove(&pb);
        let mut guard = self.debouncer.lock().map_err(|e| e.to_string())?;
        if let Some(d) = guard.as_mut() {
            let _ = d.watcher().unwatch(&pb);
        }
        Ok(0)
    }
}

// 디렉토리 하나를 비재귀로 감시. lazy 트리가 폴더를 로드할 때·플러그인이 fs.watch 로 호출.
// 반환 = 등록 후 refcount.
#[tauri::command]
pub fn watch_dir(state: State<FsWatcher>, path: String) -> Result<usize, String> {
    state.watch(&path)
}

// 디렉토리 감시 해제(트리 언마운트·서브트리 삭제 시 FSEvents 핸들 정리). 반환 = 해제 후 refcount.
#[tauri::command]
pub fn unwatch_dir(state: State<FsWatcher>, path: String) -> Result<usize, String> {
    state.unwatch(&path)
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
        assert_eq!(
            got,
            dir.to_string_lossy(),
            "보고된 부모 디렉토리가 감시 대상과 일치"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    // W8 M1 dedup 계약 — 같은 경로를 두 소비자(창·플러그인)가 watch 하면, 한쪽의 unwatch 가
    // 다른 쪽의 감시를 죽이지 못한다. OS watch 는 경로당 1개, 해제는 마지막 소비자에서만.
    #[test]
    fn shared_path_unwatch_keeps_other_consumer() {
        let dir = std::env::temp_dir().join(format!(
            "soksak-watch-ref-{}-{}",
            std::process::id(),
            Instant::now().elapsed().as_nanos()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("픽스처 디렉토리 생성");
        let dir = dir.canonicalize().expect("픽스처 경로 정규화");
        let path = dir.to_string_lossy().to_string();

        let (tx, rx) = mpsc::channel::<String>();
        let w = FsWatcher::default();
        w.init_with(move |d| {
            let _ = tx.send(d);
        });

        // 소비자 2명이 같은 경로를 watch — 두 번째는 OS watch 를 늘리지 않고 refcount 만 올린다.
        assert_eq!(w.watch(&path).expect("첫 watch 등록"), 1);
        assert_eq!(w.watch(&path).expect("둘째 watch 등록"), 2);

        // 한 소비자가 해제 — 남은 소비자의 감시는 살아 있어야 한다.
        assert_eq!(w.unwatch(&path).expect("부분 해제"), 1);

        std::thread::sleep(Duration::from_millis(300)); // 워처 무장 대기
        std::fs::write(dir.join("still-watched.txt"), b"x").expect("픽스처 파일 쓰기");
        let got = rx
            .recv_timeout(Duration::from_secs(8))
            .expect("공유 경로 unwatch 후 남은 소비자의 이벤트가 유실됨");
        assert_eq!(got, dir.to_string_lossy());

        // 마지막 소비자 해제 → OS watch 도 해제. 이후 변경은 이벤트가 없어야 한다.
        assert_eq!(w.unwatch(&path).expect("최종 해제"), 0);
        // 미등록 경로 해제는 no-op 멱등.
        assert_eq!(w.unwatch(&path).expect("멱등 해제"), 0);
        std::thread::sleep(Duration::from_millis(300));
        std::fs::write(dir.join("no-longer-watched.txt"), b"x").expect("픽스처 파일 쓰기");
        assert!(
            rx.recv_timeout(Duration::from_millis(1200)).is_err(),
            "전원 해제 후에도 이벤트가 발화됨"
        );

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
