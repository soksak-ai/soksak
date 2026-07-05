// 범용 UDP 데이터그램 송신 capability — 임의 host:port 로 단발 UDP 패킷을 보낸다(브로드캐스트 포함).
// webview JS 는 raw UDP 를 열 수 없어(보안) 코어가 제공하는 범용 기능이다(특정 용도 락인 0 —
// Wake-on-LAN·디스커버리·IoT 등 무엇이든). command registry 의 net.udp.send 가 이 실행기를 부른다
// (catalogNetwork.ts). 1회용 소켓(0.0.0.0:0 바인드 → send_to → 드롭)이라 세션/State 가 없다.

use std::net::UdpSocket;

#[tauri::command]
pub fn net_udp_send(
    host: String,
    port: u16,
    data: Vec<u8>,
    broadcast: Option<bool>,
) -> Result<usize, String> {
    let sock = UdpSocket::bind("0.0.0.0:0").map_err(|e| e.to_string())?;
    if broadcast.unwrap_or(false) {
        sock.set_broadcast(true).map_err(|e| e.to_string())?;
    }
    sock.send_to(&data, (host.as_str(), port))
        .map_err(|e| e.to_string())
}

// 수신 패킷 1건 — 송신자 주소/포트 + raw 바이트(플러그인이 파싱).
#[derive(serde::Serialize)]
pub struct UdpPacket {
    pub address: String,
    pub port: u16,
    pub data: Vec<u8>,
}

// 범용 UDP 요청-응답 — 한 소켓에서 send_to 후 타임아웃 동안 recv_from 다중 수집.
// SSDP(M-SEARCH→유니캐스트 응답)·mDNS·DNS 등 요청-응답 UDP 의 범용 실행기. 같은 소켓이라야
// 응답이 송신 포트로 돌아온다(send/recv 를 다른 소켓으로 나누면 응답 유실). LG 무관 — 범용.
#[tauri::command]
pub fn net_udp_request(
    host: String,
    port: u16,
    data: Vec<u8>,
    timeout_ms: Option<u64>,
    max_packets: Option<usize>,
) -> Result<Vec<UdpPacket>, String> {
    use std::time::Duration;
    let sock = UdpSocket::bind("0.0.0.0:0").map_err(|e| e.to_string())?;
    sock.set_broadcast(true).ok(); // 멀티캐스트/브로드캐스트 송신 허용(SSDP 등)
    sock.set_read_timeout(Some(Duration::from_millis(timeout_ms.unwrap_or(3000))))
        .map_err(|e| e.to_string())?;
    sock.send_to(&data, (host.as_str(), port))
        .map_err(|e| e.to_string())?;

    let limit = max_packets.unwrap_or(64);
    let mut out = Vec::new();
    let mut buf = [0u8; 4096];
    while out.len() < limit {
        match sock.recv_from(&mut buf) {
            Ok((n, src)) => out.push(UdpPacket {
                address: src.ip().to_string(),
                port: src.port(),
                data: buf[..n].to_vec(),
            }),
            // 타임아웃(플랫폼별 WouldBlock/TimedOut) = 정상 종료.
            Err(e)
                if e.kind() == std::io::ErrorKind::WouldBlock
                    || e.kind() == std::io::ErrorKind::TimedOut =>
            {
                break
            }
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::UdpSocket;
    use std::time::Duration;

    #[test]
    fn sends_datagram_to_loopback() {
        // 127.0.0.1 임의 포트에 수신 소켓을 두고, 그 포트로 보낸 바이트가 그대로 도착하는지.
        let recv = UdpSocket::bind("127.0.0.1:0").unwrap();
        let port = recv.local_addr().unwrap().port();
        recv.set_read_timeout(Some(Duration::from_secs(2))).unwrap();

        let payload = vec![1u8, 2, 3, 4, 5];
        let sent = net_udp_send("127.0.0.1".to_string(), port, payload.clone(), None).unwrap();
        assert_eq!(sent, payload.len());

        let mut buf = [0u8; 32];
        let (n, _) = recv.recv_from(&mut buf).unwrap();
        assert_eq!(&buf[..n], &payload[..]);
    }

    #[test]
    fn errors_on_invalid_host() {
        // 빈 호스트는 주소 해석에 실패해 Err 이어야 한다(조용한 성공 금지).
        let r = net_udp_send("".to_string(), 9, vec![0u8], None);
        assert!(r.is_err());
    }

    #[test]
    fn request_collects_responses_same_socket() {
        // echo 서버를 띄우고, request 가 보낸 패킷의 응답을 같은 소켓으로 수신하는지(SSAP/SSDP 핵심).
        let echo = UdpSocket::bind("127.0.0.1:0").unwrap();
        let echo_port = echo.local_addr().unwrap().port();
        std::thread::spawn(move || {
            let mut buf = [0u8; 1024];
            // 응답 2건(다중 수집 검증).
            for _ in 0..1 {
                if let Ok((n, src)) = echo.recv_from(&mut buf) {
                    let _ = echo.send_to(&buf[..n], src);
                    let _ = echo.send_to(b"second", src);
                }
            }
        });
        std::thread::sleep(Duration::from_millis(100));

        let pkts = net_udp_request(
            "127.0.0.1".to_string(),
            echo_port,
            b"ping".to_vec(),
            Some(800),
            None,
        )
        .unwrap();
        assert!(pkts.len() >= 1, "응답 최소 1건");
        assert_eq!(pkts[0].data, b"ping", "에코된 본문이 송신 소켓으로 돌아옴");
    }

    #[test]
    fn request_returns_empty_on_timeout() {
        // 아무도 응답 안 하는 포트 → 타임아웃까지 기다린 뒤 빈 목록(에러 아님).
        let dead = UdpSocket::bind("127.0.0.1:0").unwrap();
        let dead_port = dead.local_addr().unwrap().port();
        drop(dead); // 포트 닫음 — 응답 없음
        let pkts =
            net_udp_request("127.0.0.1".to_string(), dead_port, b"x".to_vec(), Some(150), None)
                .unwrap();
        assert_eq!(pkts.len(), 0);
    }
}
