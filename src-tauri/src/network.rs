// 범용 UDP 데이터그램 송신 capability — 임의 host:port 로 단발 UDP 패킷을 보낸다(브로드캐스트 포함).
// webview JS 는 raw UDP 를 열 수 없어(보안) 코어가 제공하는 범용 기능이다(특정 용도 락인 0 —
// Wake-on-LAN·디스커버리·IoT 등 무엇이든). command registry 의 net.udp.send 가 이 실행기를 부른다
// (catalogNetwork.ts). 1회용 소켓(0.0.0.0:0 바인드 → send_to → 드롭)이라 세션/State 가 없다.

use std::net::UdpSocket;

#[tauri::command]
pub fn network_udp_send(
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
        let sent = network_udp_send("127.0.0.1".to_string(), port, payload.clone(), None).unwrap();
        assert_eq!(sent, payload.len());

        let mut buf = [0u8; 32];
        let (n, _) = recv.recv_from(&mut buf).unwrap();
        assert_eq!(&buf[..n], &payload[..]);
    }

    #[test]
    fn errors_on_invalid_host() {
        // 빈 호스트는 주소 해석에 실패해 Err 이어야 한다(조용한 성공 금지).
        let r = network_udp_send("".to_string(), 9, vec![0u8], None);
        assert!(r.is_err());
    }
}
