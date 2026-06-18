// 범용 WebSocket capability — Origin 헤더를 보내지 않는 클라이언트(ws:// 평문).
// 브라우저/webview 의 WebSocket 은 Origin 을 강제로 붙이고 변경할 수 없어, Origin 을 검사하는
// 서버(webOS TV SSAP 등)가 "invalid origin"(close 1008)으로 거부한다. tokio-tungstenite 는
// Origin 을 보내지 않으므로 그런 서버에 연결된다. 특정 용도 락인 0 — 임의 ws 서버에 범용.
//
// 양방향: connect 후 sink/stream 으로 split. read task 가 텍스트 프레임을 on_message Channel 로
// 스트리밍(process.rs 의 stdout Channel 패턴), write 는 mpsc 로 받아 sink 에 보낸다. close 시
// session 제거(tx drop → write task 종료) + read task abort.

use std::collections::HashMap;
use std::sync::Mutex;

use futures_util::{SinkExt, StreamExt};
use tauri::ipc::Channel;
use tauri::State;
use tokio::sync::mpsc;

struct WsSession {
    tx: mpsc::UnboundedSender<String>,
    read_task: tauri::async_runtime::JoinHandle<()>,
}

#[derive(Default)]
pub struct WsManager {
    sessions: Mutex<HashMap<u32, WsSession>>,
    next_id: Mutex<u32>,
}

impl WsManager {
    // 앱 종료 시: 모든 연결 정리.
    pub fn close_all(&self) {
        if let Ok(mut s) = self.sessions.lock() {
            for (_, sess) in s.drain() {
                sess.read_task.abort();
            }
        }
    }
}

#[tauri::command]
pub async fn ws_connect(
    url: String,
    on_message: Channel<String>,
    on_close: Channel<()>,
    manager: State<'_, WsManager>,
) -> Result<u32, String> {
    use tokio_tungstenite::connect_async;
    use tokio_tungstenite::tungstenite::Message;

    let (stream, _resp) = connect_async(&url).await.map_err(|e| e.to_string())?;
    let (mut write, mut read) = stream.split();

    // write task — mpsc 로 받은 텍스트를 sink 로. tx drop(세션 제거) 시 종료.
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    tauri::async_runtime::spawn(async move {
        while let Some(t) = rx.recv().await {
            if write.send(Message::Text(t)).await.is_err() {
                break;
            }
        }
        let _ = write.close().await;
    });

    // read task — 텍스트 프레임을 on_message 로 스트리밍, 닫힘/에러 시 on_close.
    let read_task = tauri::async_runtime::spawn(async move {
        while let Some(msg) = read.next().await {
            match msg {
                Ok(Message::Text(t)) => {
                    if on_message.send(t).is_err() {
                        break;
                    }
                }
                Ok(Message::Close(_)) | Err(_) => break,
                _ => {} // binary/ping/pong 무시(SSAP 는 텍스트)
            }
        }
        let _ = on_close.send(());
    });

    let id = {
        let mut n = manager.next_id.lock().unwrap();
        *n += 1;
        *n
    };
    manager
        .sessions
        .lock()
        .unwrap()
        .insert(id, WsSession { tx, read_task });
    Ok(id)
}

#[tauri::command]
pub fn ws_send(id: u32, text: String, manager: State<'_, WsManager>) -> Result<(), String> {
    let sessions = manager.sessions.lock().unwrap();
    let sess = sessions.get(&id).ok_or("no such websocket")?;
    sess.tx.send(text).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn ws_close(id: u32, manager: State<'_, WsManager>) -> Result<(), String> {
    // 세션 제거 → tx drop(write task 종료) + read task abort.
    if let Some(sess) = manager.sessions.lock().unwrap().remove(&id) {
        sess.read_task.abort();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    // WebSocket 연결은 실 서버가 필요해 단위테스트 범위를 벗어난다(통합 검증은 실TV E2E).
    // 매니저의 핸들 발급/제거 같은 순수 상태만 검증 가능하나, 세션 생성이 async connect 에
    // 묶여 있어 여기서는 컴파일 보증만 둔다(close_all idempotent).
    use super::*;

    #[test]
    fn close_all_on_empty_is_ok() {
        let m = WsManager::default();
        m.close_all(); // 빈 매니저에서도 패닉 없음
        assert!(m.sessions.lock().unwrap().is_empty());
    }
}
