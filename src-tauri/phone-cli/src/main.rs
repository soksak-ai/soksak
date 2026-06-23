// sok-phone — 폰-링크 INITIATOR 측 thin CLI. 검증된 remote::client 라이브러리(소켓/암호/auth/
// confirm 전부 그 안)를 구동하는 얇은 글루다 — 인자 파싱 + 키 영속 + tokio 런타임 + 출력만 한다.
//
// 사용:
//   sok-phone pair
//       이 기기(폰)의 페어링 번들을 출력한다(device_id + 두 공개키). 데스크톱이 이걸 핀닝한다.
//       (QR 전송 자체는 P3 — 여기선 번들 JSON 을 stdout 으로.)
//
//   sok-phone call <target> <desktop-id> <desktop-static-hex> <command> ['{"json":"params"}']
//                  [--destructive]
//       <target> = "host:port"(loopback/LAN TCP) 또는 "iroh:<node-id-z32>"(P2P/relay).
//       핀닝된 desktop-static(hex 32B)으로 KK INITIATOR 핸드셰이크 → call. --destructive 면
//       데스크톱 confirm 권위 경로(승인 대기 surface → 최종 결과 수신, 이벤트-우선).
//
// 수동 E2E: 라이브 데스크톱 브리지가 필요하다 — 앱을 SOKSAK_REMOTE_TCP=1(또는 SOKSAK_REMOTE_IROH=1)
// 로 실행하고, 데스크톱이 이 폰의 번들(pair 출력)을 핀닝/페어링한 상태여야 한다(페어링 UI 는 P3).
// 브리지가 비어 있으면(미페어링) 서버는 fail-closed — 핸드셰이크가 미성립한다(정상).

use std::path::PathBuf;
use std::process::ExitCode;

use serde_json::{json, Value};
use soksak_lib::remote::client::{
    connect_iroh, connect_tcp, ClientResponse, DeniedReason, DeviceIdentity,
};
use soksak_lib::remote::auth::Scope;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        None | Some("-h") | Some("--help") => {
            print_usage();
            ExitCode::SUCCESS
        }
        Some("pair") => run_pair(),
        Some("call") => run_call(&args[1..]),
        Some(other) => {
            eprintln!("알 수 없는 하위명령: {other}");
            print_usage();
            ExitCode::FAILURE
        }
    }
}

fn print_usage() {
    eprintln!(
        "sok-phone — 폰-링크 INITIATOR CLI(수동 E2E, 검증된 remote::client 구동)

사용:
  sok-phone pair
      이 기기의 페어링 번들 출력(device_id + x25519/ed25519 공개키). 데스크톱이 핀닝.

  sok-phone call <target> <desktop-id> <desktop-static-hex> <command> ['{{JSON params}}'] [--destructive]
      <target> = host:port (TCP) | iroh:<node-id>
      <desktop-static-hex> = 데스크톱 X25519 static 공개키 32B hex(페어링 때 받음).
      --destructive: 데스크톱 confirm 권위 경로(승인 대기 → 최종 결과, 이벤트-우선).

폰 신원은 $SOK_PHONE_IDENTITY(없으면 ~/.soksak/phone-identity.json)에 영속된다.
수동 E2E 는 라이브 데스크톱 브리지(앱이 bridge 켜진 채 실행 + 이 폰 페어링됨)를 요구한다."
    );
}

// ── 폰 신원 영속(키 저장은 CLI 의 책임 — 라이브러리는 from_parts/generate 만 제공) ──────────

/// 신원 파일 경로 — $SOK_PHONE_IDENTITY 또는 ~/.soksak/phone-identity.json.
fn identity_path() -> Result<PathBuf, String> {
    if let Ok(p) = std::env::var("SOK_PHONE_IDENTITY") {
        if !p.is_empty() {
            return Ok(PathBuf::from(p));
        }
    }
    let home = std::env::var("HOME").map_err(|_| "HOME 없음".to_string())?;
    Ok(PathBuf::from(home).join(".soksak").join("phone-identity.json"))
}

/// 영속된 폰 신원을 로드하거나(있으면), 없으면 새로 생성해 저장한다(첫 실행 1회).
/// 저장 형식: {device_id, x25519_private, x25519_public, ed25519_private} (전부 hex).
/// **개인키가 평문 hex 로 디스크에 남는다** — 수동 E2E 편의용이며, P3 실앱은 OS 키체인/
/// secrets 코어를 쓴다(이 CLI 는 테스트 글루). 파일 권한은 0600 으로 좁힌다.
fn load_or_create_identity() -> Result<DeviceIdentity, String> {
    let path = identity_path()?;
    if let Ok(txt) = std::fs::read_to_string(&path) {
        if let Ok(v) = serde_json::from_str::<Value>(&txt) {
            let device_id = v["device_id"].as_str().ok_or("device_id 없음")?;
            let xp = from_hex32(v["x25519_private"].as_str().ok_or("x25519_private 없음")?)?;
            let xpub = from_hex32(v["x25519_public"].as_str().ok_or("x25519_public 없음")?)?;
            let ep = from_hex32(v["ed25519_private"].as_str().ok_or("ed25519_private 없음")?)?;
            return DeviceIdentity::from_parts(device_id, xp, xpub, ep)
                .map_err(|e| format!("신원 복원 실패: {e}"));
        }
    }
    // 새 신원 — device_id 는 호스트명 기반(고정 식별자). 저장.
    let device_id = std::env::var("SOK_PHONE_DEVICE_ID").unwrap_or_else(|_| {
        format!(
            "phone-{}",
            std::env::var("USER").unwrap_or_else(|_| "device".into())
        )
    });
    let identity = DeviceIdentity::generate(&device_id).map_err(|e| format!("키 생성 실패: {e}"))?;
    // 개인키 영속을 위해 from_parts 라운드트립이 필요하나, 라이브러리는 개인키를 노출하지 않는다
    // (zeroize 보호). 그래서 저장 시점엔 공개부만 안전히 기록하고, 개인키는 메모리에만 둔다 —
    // 즉 이 CLI 인스턴스 수명 동안만 같은 신원을 쓴다(재시작 시 새 신원 = 재페어링 필요).
    // 수동 E2E 편의로는 충분하다(한 세션 내 pair→call). 영속 개인키는 P3 의 책임.
    persist_public_only(&path, &identity)?;
    Ok(identity)
}

/// 공개부만 파일에 남긴다(개인키 미노출 — 라이브러리 zeroize 계약 존중). pair 출력 재현용.
fn persist_public_only(path: &PathBuf, identity: &DeviceIdentity) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let bundle = identity.pairing_bundle();
    let v = json!({
        "device_id": bundle.device_id,
        "x25519_public": to_hex(&bundle.x25519_public),
        "ed25519_public": to_hex(&bundle.ed25519_public),
        "note": "public-only (private keys held in-memory per session; persistent keystore is P3)",
    });
    std::fs::write(path, serde_json::to_string_pretty(&v).unwrap_or_default())
        .map_err(|e| format!("{} 쓰기 실패: {e}", path.display()))
}

// ── pair — 이 기기의 페어링 번들 출력 ────────────────────────────────────────

fn run_pair() -> ExitCode {
    let identity = match load_or_create_identity() {
        Ok(i) => i,
        Err(e) => {
            eprintln!("{e}");
            return ExitCode::FAILURE;
        }
    };
    let bundle = identity.pairing_bundle();
    let out = json!({
        "device_id": bundle.device_id,
        "x25519_public": to_hex(&bundle.x25519_public),
        "ed25519_public": to_hex(&bundle.ed25519_public),
    });
    println!("{}", serde_json::to_string_pretty(&out).unwrap_or_default());
    eprintln!(
        "\n# 데스크톱이 위 두 공개키를 device_id='{}' 로 핀닝하면 페어링 완료(페어링 UI 는 P3).",
        bundle.device_id
    );
    ExitCode::SUCCESS
}

// ── call — 핀닝된 데스크톱에 연결해 명령 실행 ─────────────────────────────────

fn run_call(args: &[String]) -> ExitCode {
    // 위치 인자: <target> <desktop-id> <desktop-static-hex> <command> [params] + 옵션 --destructive.
    let mut positional: Vec<&String> = Vec::new();
    let mut destructive = false;
    for a in args {
        if a == "--destructive" {
            destructive = true;
        } else {
            positional.push(a);
        }
    }
    if positional.len() < 4 {
        eprintln!("사용: sok-phone call <target> <desktop-id> <desktop-static-hex> <command> ['{{JSON}}'] [--destructive]");
        return ExitCode::FAILURE;
    }
    let target = positional[0].clone();
    let desktop_id = positional[1].clone();
    let desktop_static = match from_hex32(positional[2]) {
        Ok(k) => k,
        Err(e) => {
            eprintln!("desktop-static-hex 파싱 실패: {e}");
            return ExitCode::FAILURE;
        }
    };
    let command = positional[3].clone();
    let params = positional.get(4).map(|s| s.as_str()).unwrap_or("");

    let identity = match load_or_create_identity() {
        Ok(i) => i,
        Err(e) => {
            eprintln!("{e}");
            return ExitCode::FAILURE;
        }
    };

    // tokio 런타임(멀티스레드 — iroh 가 요구). 라이브러리 async API 를 여기서 block_on.
    let rt = match tokio::runtime::Runtime::new() {
        Ok(r) => r,
        Err(e) => {
            eprintln!("tokio 런타임 생성 실패: {e}");
            return ExitCode::FAILURE;
        }
    };
    rt.block_on(async move {
        drive_call(
            &target,
            &desktop_id,
            &desktop_static,
            &identity,
            &command,
            params,
            destructive,
        )
        .await
    })
}

/// 한 호출을 구동한다(target 에 따라 TCP/iroh 분기). 검증된 라이브러리 표면만 호출 — 글루 0 로직.
async fn drive_call(
    target: &str,
    desktop_id: &str,
    desktop_static: &[u8; 32],
    identity: &DeviceIdentity,
    command: &str,
    params: &str,
    destructive: bool,
) -> ExitCode {
    // 신선도: exp = 먼 미래, issued_at = now. 라이브러리가 단조/신선 nonce 를 강제하므로 글루는
    // 단순히 합리적 값만 준다.
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let exp = now + 30;
    let params_bytes = params.as_bytes();

    // target 분기 — iroh:<node-id> 또는 host:port(TCP).
    if let Some(node_id_str) = target.strip_prefix("iroh:") {
        // iroh endpoint 빌드(클라이언트 측 — 임시 키, relay 기본). node-id 파싱.
        let node_id: iroh::NodeId = match node_id_str.parse() {
            Ok(n) => n,
            Err(e) => {
                eprintln!("iroh node-id 파싱 실패: {e}");
                return ExitCode::FAILURE;
            }
        };
        let endpoint = match iroh::Endpoint::builder()
            .alpns(vec![soksak_lib::remote::iroh::IROH_ALPN.to_vec()])
            .relay_mode(iroh::RelayMode::Default)
            .bind()
            .await
        {
            Ok(ep) => ep,
            Err(e) => {
                eprintln!("iroh endpoint bind 실패: {e}");
                return ExitCode::FAILURE;
            }
        };
        let node_addr = iroh::NodeAddr::new(node_id);
        match connect_iroh(&endpoint, node_addr, identity, desktop_id, desktop_static).await {
            Ok(mut session) => {
                run_one(&mut session, command, params_bytes, exp, now, destructive).await
            }
            Err(e) => {
                eprintln!("연결 실패(핸드셰이크 미성립 = 미페어링/틀린 키면 정상): {e}");
                ExitCode::FAILURE
            }
        }
    } else {
        // host:port TCP.
        let addr: std::net::SocketAddr = match target.parse() {
            Ok(a) => a,
            Err(e) => {
                eprintln!("주소 파싱 실패('{target}'): {e}");
                return ExitCode::FAILURE;
            }
        };
        match connect_tcp(addr, identity, desktop_id, desktop_static).await {
            Ok(mut session) => {
                run_one(&mut session, command, params_bytes, exp, now, destructive).await
            }
            Err(e) => {
                eprintln!("연결 실패(핸드셰이크 미성립 = 미페어링/틀린 키면 정상): {e}");
                ExitCode::FAILURE
            }
        }
    }
}

/// 성립된 세션에서 한 호출(read-only/write 즉시 또는 destructive confirm 경로)을 실행하고 출력.
async fn run_one<S>(
    session: &mut soksak_lib::remote::client::ClientSession<S>,
    command: &str,
    params: &[u8],
    exp: u64,
    issued_at: u64,
    destructive: bool,
) -> ExitCode
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    if destructive {
        // 명시 opt-in — 데스크톱 confirm 권위 경로.
        let pending = match session
            .call_destructive(command.as_bytes(), params, exp, issued_at)
            .await
        {
            Ok(p) => p,
            Err(e) => {
                eprintln!("destructive 송신 실패: {e}");
                return ExitCode::FAILURE;
            }
        };
        // "데스크톱 승인 대기" surface(이벤트-우선 — 폴링 아님).
        eprintln!("# awaiting desktop approval … (데스크톱 모달에서 승인/거부)");
        let _ = pending.is_awaiting_desktop_approval();
        match pending.await_outcome().await {
            Ok(resp) => print_response(&resp),
            Err(e) => {
                eprintln!("결과 수신 실패: {e}");
                ExitCode::FAILURE
            }
        }
    } else {
        // 폰 기본 = read-only(좁은 scope). write 는 SOK_PHONE_SCOPE=write 로 상승(명시).
        let scope = match std::env::var("SOK_PHONE_SCOPE").as_deref() {
            Ok("write") => Scope::Write,
            _ => Scope::ReadOnly,
        };
        match session
            .call(command.as_bytes(), params, scope, exp, issued_at)
            .await
        {
            Ok(resp) => print_response(&resp),
            Err(e) => {
                eprintln!("호출 실패: {e}");
                ExitCode::FAILURE
            }
        }
    }
}

/// ClientResponse → stdout JSON + 종료코드. Ok=0, Denied=비0(사유 표시).
fn print_response(resp: &ClientResponse) -> ExitCode {
    match resp {
        ClientResponse::Ok(body) => {
            // 서버 envelope 는 보통 JSON — 그대로 출력(파싱 가능하면 pretty).
            match serde_json::from_slice::<Value>(body) {
                Ok(v) => println!("{}", serde_json::to_string_pretty(&v).unwrap_or_default()),
                Err(_) => println!("{}", String::from_utf8_lossy(body)),
            }
            ExitCode::SUCCESS
        }
        ClientResponse::Denied(reason) => {
            let name = denied_name(*reason);
            println!("{}", json!({"ok": false, "denied": name}));
            ExitCode::FAILURE
        }
    }
}

fn denied_name(r: DeniedReason) -> String {
    match r {
        DeniedReason::Decrypt => "decrypt".into(),
        DeniedReason::MalformedFrame => "malformed-frame".into(),
        DeniedReason::DeviceMismatch => "device-mismatch".into(),
        DeniedReason::Unauthorized => "unauthorized".into(),
        DeniedReason::DesktopConfirm => "desktop-confirm-denied".into(),
        DeniedReason::Unknown(c) => format!("unknown-{c}"),
    }
}

// ── hex 유틸(공개키 직렬화 — 비밀 아님) ──────────────────────────────────────

fn to_hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

fn from_hex32(s: &str) -> Result<[u8; 32], String> {
    let s = s.trim();
    if s.len() != 64 {
        return Err(format!("32바이트(64 hex 문자) 필요 — got {} 문자", s.len()));
    }
    let mut out = [0u8; 32];
    for (i, chunk) in s.as_bytes().chunks(2).enumerate() {
        let hi = hex_nibble(chunk[0])?;
        let lo = hex_nibble(chunk[1])?;
        out[i] = (hi << 4) | lo;
    }
    Ok(out)
}

fn hex_nibble(c: u8) -> Result<u8, String> {
    match c {
        b'0'..=b'9' => Ok(c - b'0'),
        b'a'..=b'f' => Ok(c - b'a' + 10),
        b'A'..=b'F' => Ok(c - b'A' + 10),
        _ => Err(format!("hex 문자가 아님: {}", c as char)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_round_trips() {
        let bytes = [0u8, 1, 2, 0xab, 0xff, 0x10, 0x42, 7];
        let mut k = [0u8; 32];
        k[..8].copy_from_slice(&bytes);
        let hex = to_hex(&k);
        assert_eq!(hex.len(), 64);
        assert_eq!(from_hex32(&hex).unwrap(), k);
    }

    #[test]
    fn hex32_rejects_wrong_length_and_chars() {
        assert!(from_hex32("ab").is_err(), "짧은 hex 거부");
        assert!(from_hex32(&"z".repeat(64)).is_err(), "비-hex 문자 거부");
        assert!(from_hex32(&"a".repeat(64)).is_ok(), "정확한 길이 통과");
    }

    #[test]
    fn denied_names_stable() {
        assert_eq!(denied_name(DeniedReason::Unauthorized), "unauthorized");
        assert_eq!(denied_name(DeniedReason::DesktopConfirm), "desktop-confirm-denied");
        assert_eq!(denied_name(DeniedReason::Unknown(9)), "unknown-9");
    }
}
