# 폰-링크 — 원격 제어 보안 계약 (정본)

상태: 완성·`main`에 머지됨. 이 계약은 코어 보안 floor를 문서화한다; 전체 현재
스택 — dev서버 터널(`tunnel.rs`), 데스크톱-소유 페어링 설정(`pairing.rs`), 응답
chunking(`session.rs` 내) 포함, **총 263 Rust 테스트** — 과 요구사항·사용법·
라이브-E2E 증거는 `docs/PHONE-LINK-GUIDE.md`에. 교차-결함 적대 감사는 보안
구멍 0 확인(가이드 참조).
범위: 폰(또는 임의 페어링 기기)이 CGNAT 데스크톱의 `command`/`dom`/`status`
표면을 원격 조종하고, 로컬 dev서버를 터널링한다 — 상호 인증된 종단간 암호 채널 위에서.

이 문서는 정본 계약이다: 위협 모델, 계층 방어, 그리고 각 방어를 증명하는 정확한
테스트. 코어의 `docs/AI-CONTROL.md`(이 기능이 원격 노출하는 로컬 제어 표면)를
보완한다. 원천 계획: `~/.claude/plans/polished-launching-toast.md`.

> 보안 하한선(절대 약화 불가 — RULE 0): 인증 없이 연결되거나, assertion이 미검증이거나,
> 릴레이가 페이로드를 읽는 순간 전부 무너진다. 미인증 fallback·디버그 백도어·로컬-신뢰 예외 0.

---

## 1. 어디 사는가

전부 코어의 `src-tauri/src/remote/` 아래 additive Rust(기본 비활성 — 명시적으로
켜지 않으면 실행 중인 앱에 영향 0). 재사용하는 로컬 `command`/`dom`/`status`
디스패치 seam은 `ipc.rs::request_command` → `route()`(무변경).

| 모듈 | 역할 | 테스트 |
|------|------|--------|
| `auth.rs`    | Ed25519 기기 페어링 + capability-assertion 검증(인가) | 41 |
| `noise.rs`   | Noise_KK_25519_ChaChaPoly_BLAKE2s 채널(인증 + 기밀 + PFS) | 31 |
| `session.rs` | `SecureSession` — 프레임마다 두 게이트 합성 | 31 |
| `transport.rs` | transport-agnostic `serve_connection(stream)` + 길이 프레이밍 | 29 |
| `tcp.rs`     | loopback 전용(127.0.0.1) TCP 리스너 | 4 |
| `confirm.rs` | destructive 데스크톱-confirm 권위(event-driven, 폴링 없음) | 11 |
| `iroh.rs`    | iroh QUIC P2P + relay 전송 tier | 6 |
| `client.rs`  | 재사용 initiator(폰이 임베드하는 절반) + `sok-phone` CLI | 13 |
| `bridge.rs`  | 기본 비활성 앱 글루(enable 플래그, `request_command` 디스패치, Tauri confirm 커맨드) | — |

위 floor 합계: **166 RED→GREEN 테스트** — 전체 스택(터널·페어링·chunking·적대
fuzz·감사 커버리지 추가)은 **263**. 각 방어를 NOP-패치(공격 통과 = RED)·복원(차단 = GREEN)으로 독립 검증.

---

## 2. 2중-계층 모델 (defense in depth)

독립된 두 게이트. 어느 한쪽만 뚫어선 아무 것도 못 얻는다.

```
폰 ──TCP/iroh 스트림──▶ [게이트 1: Noise_KK]  상호 정적키 인증 + ChaCha20-Poly1305 + PFS
                              │  (미페어링/미상 키 ⇒ 채널 미성립)
                              ▼
                       [게이트 2: Ed25519 assertion]  프레임마다: verify_strict, 단일사용
                              │   nonce, freshness, 단조 issued_at, scope ⊆ granted
                              ▼
                       [기기-신원 바인딩]  채널 peer ≡ assertion.device_id
                              ▼
                       [danger]  destructive ⇒ 데스크톱 사람 confirm (폰 우회 불가)
                              ▼
                       request_command → route()   (command / dom / status)
```

- **채널 인증 ≠ 액션 인가.** 완벽히 유효한 Noise 채널도 아무 것도 인가 안 한다 — 프레임마다 자기 서명·scope·단일사용 assertion을 싣는다.
- 기기마다 두 키 종류, 페어링 시 핀: **X25519 정적** 키(Noise 채널)와 **Ed25519 신원** 키(assertion). 전송 주소(iroh node-id)는 둘 다 아님 — 올바른 node-id라도 미핀 기기 키면 Noise 핸드셰이크 실패.

---

## 3. 위협 → 방어 → 테스트

각 행: 공격, 방어, 그리고 그것을 증명하는 테스트명(`cargo test -p soksak-dev --lib remote::<module>`로 실행). RED는 방어 제거로 입증.

### 페어링 / 인가 (`remote::auth`)
| 공격 | 방어 | 테스트 |
|------|------|--------|
| 미페어링 기기가 command 전송 | fail-closed; 매 호출 재검사 | `a_forged_assertion_wrong_key_denied`, 미상 기기 거부 |
| 위조 assertion(잘못/타키) | 핀 키 대조 `verify_strict` | `a_forged_assertion_wrong_key_denied`, `a_tampered_payload_denied` |
| 약/소위수 키 | `from_bytes` Result + `is_weak()` 가드 | `c_weak_small_order_key_rejected_at_pairing` |
| 재생(nonce/통째 assertion 재사용) | 단일사용 nonce 원장 | `replay_reused_nonce_denied`, `replay_whole_prior_assertion_denied` |
| 시계 되돌리기(과거 `issued_at`) | 비감소 단조 워터마크 | `clock_rollback_older_issued_at_denied` |
| 만료 assertion | `now < exp` freshness | `expiry_expired_assertion_denied` |
| 도난폰 / revoke 후 환불 | 기기 `revoke`, 매 호출 재검사 | `f_revoked_device_denied_even_with_valid_sig_and_fresh_nonce`, `f_revoke_rechecked_every_call_not_just_connect` |
| `max_devices` 초과 | 바인딩 상한 | `max_devices_n_plus_one_rejected` |
| TOFU 키 교체 | 같은 id·다른 키 재페어링 거부 | `tofu_repair_same_id_different_key_rejected` |
| scope 상승(read-only → destructive) | 매 호출 `scope ⊆ granted` 강제 | `c_readonly_requesting_destructive_denied`, `c_scope_rechecked_per_call_not_just_entry` |
| 게이트 NOP-패치(한 검사 우회) | **woven 게이트** — `NonceProof`(private ctor)를 `Grant::seal`에 소유 이동; nonce 단계 삭제 시 컴파일 실패(E0308) | `g_nonce_consume_is_the_only_proof_source`, `g_every_failure_fails_closed_no_silent_grant` |

### 채널 / 기밀 (`remote::noise`)
| 공격 | 방어 | 테스트 |
|------|------|--------|
| 미상/미핀 정적키 | KK 핸드셰이크가 채널 미생성 | `unpinned_remote_initiate_refused_no_channel`, `wrong_static_key_handshake_fails_no_channel` |
| revoked peer | `resolve_pinned` PeerRevoked | `revoked_peer_handshake_refused_no_channel` |
| 변조(바이트 flip / 위조 tag / 절단 / 주입) | AEAD 인증 → decrypt Err, garbage 0 | `tampered_ciphertext_byte_flip`, `tampered_auth_tag`, `truncated_ciphertext`, `injected_random_ciphertext` |
| 재생 / 순서-위반 메시지 | Noise nonce 시퀀싱 | `replay_captured_message`, `out_of_order_message_rejected_by_sequencing` |
| 평문/약 패턴 다운그레이드 | 고정 단일 패턴; 평문 채널 ctor 없음 | `no_downgrade_only_kk_pattern_pinned`, `no_plaintext_path_channel_only_from_finished_handshake` |
| 릴레이가 페이로드 읽기 | E2E — ciphertext에 평문 0 | `relay_sees_no_plaintext_zero_knowledge` |
| 장기키 후유출이 과거 트래픽 복호 | PFS — 세션키는 임시 `ee`에서, zeroize | `pfs_a_*`, `pfs_b_*`, `pfs_c_static_key_alone_cannot_decrypt_session`, `pfs_static_private_zeroized_on_drop` |

### 합성 session + transport (`remote::session`, `remote::transport`, `remote::tcp`, `remote::iroh`)
| 공격 | 방어 | 테스트 |
|------|------|--------|
| 유효 채널 ⇒ 인가됐다고 가정 | 둘째 게이트 독립 — 프레임은 여전히 유효 assertion 필요 | `gate2_valid_channel_forged_assertion_denied`, `defense_in_depth_channel_bypassed_still_needs_authz` |
| cross-device assertion 밀반입 | 채널 peer ≡ assertion.device_id | `device_binding_cross_device_assertion_rejected_dispatch_not_called` |
| Grant 없이 디스패치 | `dispatch`가 `AuthorizedAction`(오직 `Grant`에서) 요구 | `woven_dispatch_unreachable_without_grant` |
| 임의 host:port 피벗(SSRF) | 디스패치는 레지스트리 command만; raw host:port 0 | `dispatch_routes_only_registry_commands_no_raw_host_port_forward` |
| 외부 노출 / DNS rebinding | 127.0.0.1 전용 바인드(0.0.0.0 0) | `listener_binds_loopback_only_never_wildcard`, `bind_is_loopback_only_not_wildcard` |
| 오버사이즈 / malformed 프레임 | 길이 상한(65535) → graceful close, panic 0 | `oversized_length_prefix_rejected_gracefully_no_panic` |
| 전송-계층 신뢰(iroh node-id ≠ 인증) | node-id는 주소만; Noise+auth 여전히 필요 | `correct_node_id_with_wrong_device_key_fails_zero_dispatch` |
| 핸드셰이크 전 데이터 | 핸드셰이크 완료 전 디스패치 0 | `pre_handshake_bytes_never_dispatched` |
| 한 연결이 다른 연결 영향 | 연결별 격리; 세션 중 revoke | `two_concurrent_clients_isolated_one_revoked_other_unaffected` |

### destructive 데스크톱-confirm 권위 (`remote::confirm`)
| 공격 | 방어 | 테스트 |
|------|------|--------|
| 폰이 destructive 직접 실행 | 데스크톱 사람 결정 대기 파킹; 자동 디스패치 0 | `anti_escalation_destructive_always_parks_no_auto_grant_flag` |
| 폰이 자기 confirm 위조 | `DesktopConfirmToken`은 어댑터가 파킹된 Grant의 `(device, bound_nonce)`로 생성; private ctor; 폰엔 resolve 경로 0 | `phone_cannot_self_approve_no_frame_resolves_own_confirm` |
| confirm 거부/타임아웃에도 실행 | deny / TTL auto-deny ⇒ 디스패치 0 | `confirm_deny_no_dispatch_client_gets_denied`, `confirm_timeout_auto_denies_no_dispatch` |
| 결정을 폴링 | event-driven `oneshot` + `select!`, resolve에 깨어남 | `event_first_resolve_wakes_promptly_not_poll` |
| 요청 간 토큰 재사용 | 토큰이 정확한 `(device, nonce)`에 결속 | `confirm_token_bound_to_exact_device_nonce_not_reusable` |

### 클라이언트(initiator) (`remote::client`)
| 속성 | 테스트 |
|------|--------|
| 틀린 데스크톱 키 ⇒ 세션 0(fail-closed, 대칭) | `wrong_desktop_key_handshake_fails_no_session` |
| read-only 폰의 destructive 호출 ⇒ 거부 | `readonly_phone_destructive_call_denied_scope_no_dispatch` |
| destructive confirm 승인/거부/타임아웃, event-driven | `destructive_confirm_approve_client_gets_result_event_driven` (+ deny/timeout) |
| 호출마다 fresh nonce + 단조 issued_at(자기 재생 0) | `sequential_calls_fresh_nonce_monotonic_issued_at_all_succeed` |

---

## 4. 페어링 & 켜기

페어링은 `device_id`마다 폰의 **두 공개키**(X25519 + Ed25519)를 핀; 폰은 데스크톱
정적키(+ 다이얼 주소로 iroh node-id)를 핀. 교환 매체는 QR 번들(데스크톱이 표시,
폰이 스캔) — TOFU. 번들 모양(`sok-phone pair`):

```json
{ "device_id": "phone-max", "ed25519_public": "…", "x25519_public": "…" }
```

브리지는 **기본 비활성**. 명시적으로 켠다(loopback TCP 및/또는 iroh):

- `SOKSAK_REMOTE_TCP=1` — loopback(127.0.0.1) 리스너. LAN/동일 호스트.
- `SOKSAK_REMOTE_IROH=1` — iroh QUIC 엔드포인트(P2P + relay), 교차-네트워크/CGNAT용.

둘 다 미설정이면 아무 것도 바인드 안 한다.

---

## 5. 전송 tier

`serve_connection(stream)`은 transport-agnostic — 우리 Noise E2E가 바이트를
나르는 무엇 **위에** 얹히므로, 릴레이는 불투명 ciphertext만 옮긴다.

1. **iroh**(Rust-first): hole-punching QUIC P2P + CGNAT용 relay fallback, 로컬 발견 LAN fast-path. `iroh = "=0.91.2"` 핀(0.95.x는 빌드 실패하는 `ed25519-dalek 3.0.0-pre.1` 프리릴리스를 끌어옴; 0.91.2는 안정 `ed25519-dalek 2.2.0`로 해소돼 `remote::auth`와 통합). `iroh.rs`가 수락된 bi-stream을 `serve_connection`에 무변경 공급.
2. **loopback TCP**(`tcp.rs`): 동일 호스트 / LAN, 가장 단순한 tier.
3. Go yamux 릴레이와 cloudflared 플러그인은 계획서의 문서화된 fallback(미빌드).

---

## 6. Frontier (사용자 환경 필요 — 미빌드)

이 계약 최초 작성 이후 완료: **라이브-앱 E2E**(페어링 클라이언트가 실제 `route()`
구동 — `state.commands`가 244 KB 전체 카탈로그를 chunked 왕복)와 **데스크톱
confirm 모달**(`RemoteConfirmModal`). 남은 것은 실 인프라가 필요하며 그 맥락에
의도적으로 남겨둠(가짜 검증 0):

- **P3 모바일 앱** — `remote::client`를 임베드한 Tauri 모바일 클라이언트 + 미러 UI; 모바일 툴체인 + 스토어 서명 필요.
- **P4 Cloudflare Worker 수렴** — 페어링/취소를 라이선스 인프라(`docs/license-system-design.md`: Ed25519 챌린지-응답, `machine_id`, `max_devices`, `deactivate`)에 통합. 사용자 Cloudflare/Paddle 설정 필요.
- **실 교차-네트워크 검증** — 실제 NAT hole-punching, relay 페일오버, mDNS 발견, 발화 E2E("왼쪽 창 닫고 터미널 크게 보여줘")는 두 네트워크 실기기 필요.
