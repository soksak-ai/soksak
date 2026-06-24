// remote::auth — 원격 기기 인증/인가 하한선(RULE 0 암호 불변식).
//
// 이 모듈은 "인증된 원격 기기"라는 generic capability 다(폰 전용 아님 — RULE 8 무강결합).
// 미래의 네트워크 어댑터가 `route()` 호출 전에 상담하는 auth 층. 여기서는 어떤 TcpListener·
// ipc 변경도 하지 않는다 — auth 코어만.
//
// 위협 모델(계획서 "폰-링크 보안 모델" + 매트릭스): 도난폰·MITM·릴레이 침해·악성 페어링·
// 재생·scope 상승. 폰이 보내는 건 raw shell 이 아니라 typed capability assertion 이며,
// 모든 원격 액션은 Ed25519 서명 assertion 으로 증명되어야 한다.
//
// 절대 불변식(RULE 0 — 뚫리면 끝):
//   - fail-closed: 어떤 실패·미상도 ⇒ Denied. 기본값은 거부.
//   - per-device 핀닝 키(OpenClaw shared-secret 반면교사 — 기기마다 자기 키).
//   - verify_strict 만 사용(약·소위수 키 forgery 차단). 일반 verify() 금지.
//   - nonce 단일사용 + exp freshness + issued_at 단조 → 재생 차단.
//   - scope ⊆ granted 를 매 호출 강제(진입만 검사 X).
//   - destructive ⇒ 데스크톱 confirm 권위(폰이 끄거나 우회 불가).
//   - 게이트를 실행에 엮기("기능을 토큰에 엮기") — 단일 if 우회 불가. Grant 는
//     모든 검사를 통과한 봉인 경로에서만 생성되고, nonce 소비라는 부작용의
//     산물(NonceProof)이 봉인의 필수 입력이다. 한 검사를 NOP-패치하면 Grant 가
//     생성 불가(미봉인) ⇒ fail-closed, 조용한 grant 0.
//
// 이 모듈은 auth 코어만이며 아직 어떤 transport 도 호출하지 않는다(다음 단계). 따라서
// 공개 표면(AuthorizedAction/DesktopConfirmToken 등)은 현재 미사용 — dead_code 허용.
// 테스트(`mod tests`)는 전 표면을 행위로 강제한다.
#![allow(dead_code)]

use std::collections::HashMap;

use ed25519_dalek::{Signature, VerifyingKey, SIGNATURE_LENGTH};

// ===========================================================================
// 0. Scope — 최소권한(read-only 기본, destructive 명시 grant)
// ===========================================================================

/// 원격 기기에 부여하거나 assertion 이 요청하는 권한 수준.
///
/// 폰 기본 = read-only(좁게). destructive 는 명시 grant + 데스크톱 confirm 권위.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Scope {
    /// 관찰 전용 — 상태/트리 읽기. 파괴·주입 0.
    ReadOnly,
    /// 비파괴 쓰기(예: 포커스 이동, 비위험 명령). read-only 를 포함한다.
    Write,
    /// 파괴/주입 가능. 데스크톱 confirm 권위 필수(자동 grant 절대 금지).
    Destructive,
}

impl Scope {
    /// 권한 격자(lattice) 순위 — 높을수록 강한 권한.
    fn rank(self) -> u8 {
        match self {
            Scope::ReadOnly => 0,
            Scope::Write => 1,
            Scope::Destructive => 2,
        }
    }

    /// `self` 가 `granted` 에 포함되는가(요청 ⊆ 부여). read-only ⊆ write ⊆ destructive.
    ///
    /// 매 verify() 호출에서 강제된다(진입 시 1회 X — 계획서 "scope 는 매 step 강제").
    fn is_subset_of(self, granted: Scope) -> bool {
        self.rank() <= granted.rank()
    }

    /// 이 scope 가 파괴적인가 — destructive 면 데스크톱 confirm 권위가 강제된다.
    fn is_destructive(self) -> bool {
        matches!(self, Scope::Destructive)
    }
}

// ===========================================================================
// 1. DeviceState — 페어링 상태(active / revoked)
// ===========================================================================

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DeviceState {
    /// 활성 — 페어링됨, 명령 수신 가능.
    Active,
    /// 취소(deactivate) — kill-switch. 유효 서명·신선 nonce 여도 거부.
    Revoked,
}

/// 페어링된 기기 1대의 레코드. per-device 핀닝 공개키 + 부여 scope + 상태 +
/// issued_at 단조 워터마크(재생/시계되돌리기 차단).
#[derive(Debug, Clone)]
struct DeviceRecord {
    /// TOFU 로 핀닝된 이 기기의 Ed25519 공개키. 절대 조용히 교체 안 됨.
    pinned_key: VerifyingKey,
    /// 이 기기에 부여된 최대 권한. 요청 scope 는 이 이하여야 한다.
    granted_scope: Scope,
    /// active/revoked.
    state: DeviceState,
    /// 마지막으로 수락된 assertion 의 issued_at. 다음 assertion 은 이보다 커야 한다
    /// (strict monotonic). None = 아직 수락된 assertion 없음.
    last_issued_at: Option<u64>,
}

// ===========================================================================
// 2. CapabilityAssertion — 기기 자기 키로 서명된 권한 주장
// ===========================================================================

/// 원격 기기가 한 액션을 수행할 권리를 주장하는 단명 토큰.
///
/// 캐노니컬 바이트 = 고정 키 순서 compact 직렬화(license doc 와 동형). Worker-as-issuer
/// 수렴은 후속 — 지금은 peer 모델(기기 자기 키로 서명, 핀닝 공개키로 검증).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CapabilityAssertion {
    /// 어느 기기가 주장하는가.
    pub device_id: String,
    /// 이 액션이 요구하는 권한.
    pub scope: Scope,
    /// 단일사용 난수(재생 차단). verify() 가 소비한다.
    pub nonce: [u8; 32],
    /// 발급 시각(Unix secs). 기기별 strict monotonic — 시계 되돌리기/옛 assertion 재생 차단.
    pub issued_at: u64,
    /// 만료 시각(Unix secs). now >= exp 이면 신선도 실패.
    pub exp: u64,
}

impl CapabilityAssertion {
    /// 캐노니컬 서명 바이트 — 고정 필드 순서, 길이 프리픽스로 모호성 제거.
    ///
    /// 순서: device_id, scope, nonce, issued_at, exp. license doc 의 "고정 키 순서
    /// compact 직렬화" 와 동형. 서명자/검증자가 정확히 동일 바이트를 재구성한다.
    /// 길이 프리픽스(device_id) 로 ("ab","c") 와 ("a","bc") 충돌을 막는다.
    pub fn canonical_bytes(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(64 + self.device_id.len());
        let id = self.device_id.as_bytes();
        out.extend_from_slice(&(id.len() as u64).to_le_bytes());
        out.extend_from_slice(id);
        out.push(scope_tag(self.scope));
        out.extend_from_slice(&self.nonce);
        out.extend_from_slice(&self.issued_at.to_le_bytes());
        out.extend_from_slice(&self.exp.to_le_bytes());
        out
    }
}

/// scope → 캐노니컬 바이트의 1바이트 태그(직렬화 결정성).
fn scope_tag(scope: Scope) -> u8 {
    match scope {
        Scope::ReadOnly => 0,
        Scope::Write => 1,
        Scope::Destructive => 2,
    }
}

// ===========================================================================
// 3. NonceProof — 봉인의 필수 입력(게이트를 실행에 엮기)
// ===========================================================================

/// nonce 가 **실제로 소비되었다는** 증거. 필드 private + 생성자 private →
/// 오직 `NonceLedger::consume` 만이 만든다. `Grant` 봉인은 이 값을 요구한다.
///
/// NOP-패치 불변식: nonce 소비 단계를 삭제하면 NonceProof 가 없어 Grant 를 봉인 불가
/// ⇒ verify() 는 Granted 를 반환할 수 없다(fail-closed). 단일 if 우회로는 조용한 grant 0.
#[derive(Debug)]
struct NonceProof {
    consumed: [u8; 32],
}

/// 소비된 nonce 집합 — 단일사용 강제. 본 적 없는 nonce 만 소비 성공.
#[derive(Debug, Default)]
struct NonceLedger {
    seen: std::collections::HashSet<[u8; 32]>,
}

impl NonceLedger {
    /// nonce 를 소비한다. 처음 보는 nonce 만 Some(proof). 이미 본(재생) ⇒ None.
    ///
    /// 부작용으로 nonce 를 집합에 기록한다. proof 는 봉인의 필수 입력 →
    /// "검증을 우회해도 정답(proof)이 없어 기능이 안 됨"(license doc §6).
    fn consume(&mut self, nonce: [u8; 32]) -> Option<NonceProof> {
        if self.seen.contains(&nonce) {
            return None; // 재생: 이미 소비됨.
        }
        self.seen.insert(nonce);
        Some(NonceProof { consumed: nonce })
    }
}

// ===========================================================================
// 4. Grant / AuthDecision — 봉인된 결정(우회 불가)
// ===========================================================================

/// verify() 가 모든 검사를 통과시킨 뒤 봉인한 권한 부여.
///
/// 필드 private + 외부 생성자 없음 → 이 모듈의 `Grant::seal`(아래 단일 봉인점)에서만
/// 생성된다. seal 은 `NonceProof`(소비 증거)를 **소유로** 받는다 → nonce 미소비면 봉인 불가.
/// 따라서 한 검사를 NOP-패치해 조기 반환을 막아도 Grant 는 구성 불가(unconstructable),
/// 조용한 grant 가 아니라 컴파일/런타임 fail-closed.
#[derive(Debug)]
pub struct Grant {
    device_id: String,
    /// 실제로 부여된 권한(요청 scope, 단 ⊆ granted 가 검증된 뒤).
    granted_scope: Scope,
    /// 소비된 nonce 증거 — 봉인의 필수 입력. 외부에서 못 만든다.
    nonce_proof: NonceProof,
    /// destructive 면 Some(데스크톱 confirm 요구). 자동 grant 절대 0.
    desktop_confirm: Option<DesktopConfirmRequired>,
}

impl Grant {
    /// 단일 봉인점 — 모든 검사 통과 후에만 호출된다. NonceProof 소유 이동을 요구하므로
    /// nonce 소비 없이는 호출 자체가 불가능(타입 시스템 강제).
    fn seal(
        device_id: String,
        granted_scope: Scope,
        nonce_proof: NonceProof,
        desktop_confirm: Option<DesktopConfirmRequired>,
    ) -> Grant {
        Grant {
            device_id,
            granted_scope,
            nonce_proof,
            desktop_confirm,
        }
    }

    /// 부여된 권한.
    pub fn scope(&self) -> Scope {
        self.granted_scope
    }

    /// 어느 기기에 부여됐는가.
    pub fn device_id(&self) -> &str {
        &self.device_id
    }

    /// destructive 면 Some — 데스크톱 confirm 토큰 없이는 액션 진행 불가.
    /// read-only/write 면 None(confirm 불요).
    pub fn desktop_confirm(&self) -> Option<&DesktopConfirmRequired> {
        self.desktop_confirm.as_ref()
    }

    /// 이 grant 가 데스크톱 confirm 을 요구하는가(destructive 경로).
    pub fn requires_desktop_confirm(&self) -> bool {
        self.desktop_confirm.is_some()
    }

    /// 봉인 시 소비된 nonce — 감사/디버그용 노출(증거가 실재함을 단언 가능).
    pub fn consumed_nonce(&self) -> [u8; 32] {
        self.nonce_proof.consumed
    }
}

/// destructive 결정에 실린 데스크톱 confirm 요구. 필드 private + 생성자 private →
/// 폰(원격)이 스스로 만들 수 없다. transport 는 데스크톱이 발급한 confirm 토큰을
/// 이 요구와 매칭해야 액션을 진행할 수 있다(데스크톱 confirm 권위, 폰 우회 불가).
#[derive(Debug, Clone)]
pub struct DesktopConfirmRequired {
    device_id: String,
    /// 이 confirm 이 묶인 nonce — confirm 토큰을 액션에 결속(다른 액션 재사용 차단).
    bound_nonce: [u8; 32],
}

impl DesktopConfirmRequired {
    fn new(device_id: String, bound_nonce: [u8; 32]) -> Self {
        DesktopConfirmRequired {
            device_id,
            bound_nonce,
        }
    }

    pub fn device_id(&self) -> &str {
        &self.device_id
    }

    pub fn bound_nonce(&self) -> [u8; 32] {
        self.bound_nonce
    }
}

/// 거부 사유 — fail-closed 의 명시적 분류(감사/디버그). 어떤 사유든 0 접근.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DenyReason {
    /// 등록된 적 없는 기기.
    UnknownDevice,
    /// revoke(deactivate)된 기기 — kill-switch.
    DeviceRevoked,
    /// 서명 검증 실패(위조/타키/약키 — verify_strict 거부).
    BadSignature,
    /// nonce 재생(이미 소비됨) 또는 형식 불량.
    NonceReplay,
    /// assertion 만료(now >= exp).
    Expired,
    /// issued_at 비단조(시계 되돌리기/옛 assertion 재생).
    ClockRollback,
    /// 요청 scope 가 부여 scope 초과(상승 시도).
    ScopeEscalation,
}

/// verify() 의 결과 — Granted(봉인된 Grant) | Denied(사유). 기본값은 Denied.
#[derive(Debug)]
pub enum AuthDecision {
    /// 모든 검사 통과 — 봉인된 권한. destructive 면 Grant 가 데스크톱 confirm 을 싣는다.
    Granted(Grant),
    /// 거부 — 사유 동반. nonce 미소비(이 경로에선 소비 안 함).
    Denied(DenyReason),
}

impl AuthDecision {
    /// 편의: Granted 면 &Grant.
    pub fn granted(&self) -> Option<&Grant> {
        match self {
            AuthDecision::Granted(g) => Some(g),
            AuthDecision::Denied(_) => None,
        }
    }

    /// 편의: Denied 면 사유.
    pub fn denied(&self) -> Option<&DenyReason> {
        match self {
            AuthDecision::Denied(r) => Some(r),
            AuthDecision::Granted(_) => None,
        }
    }

    pub fn is_granted(&self) -> bool {
        matches!(self, AuthDecision::Granted(_))
    }
}

// ===========================================================================
// 5. 검증 컨텍스트 + 페어링 에러
// ===========================================================================

/// verify() 가 신선도/단조를 판정하는 데 필요한 외부 입력. 호출자(transport)가 주입한다.
#[derive(Debug, Clone, Copy)]
pub struct VerifyCtx {
    /// 현재 시각(Unix secs). 신선도(now < exp) 판정 기준.
    pub now: u64,
}

/// 페어링 단계 에러(verify 와 분리 — 페어링은 신뢰 확립, verify 는 액션 인가).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PairError {
    /// max_devices 한도 초과 — N+1 바인딩 거부.
    CapacityExceeded,
    /// 동일 device_id 가 **다른** 키로 재페어링 시도 — TOFU 위반(조용한 키 교체 차단).
    KeyMismatch,
    /// 공개키 바이트가 유효한 Ed25519 점이 아님(약/소위수 포함 from_bytes 거부).
    InvalidKey,
}

// ===========================================================================
// 6. DeviceRegistry — 페어링/인가의 단일 권위
// ===========================================================================

/// 페어링된 기기 레지스트리 + nonce 원장. verify() 의 유일한 입구.
///
/// 상태: 기기별 핀닝 키/scope/active·revoked/issued_at 워터마크 + 전역 nonce 원장.
/// fail-closed: 미상/미페어링/취소 모두 Denied. 매 호출 재검사(연결 시 1회 X).
#[derive(Debug)]
pub struct DeviceRegistry {
    devices: HashMap<String, DeviceRecord>,
    nonces: NonceLedger,
    max_devices: usize,
}

impl DeviceRegistry {
    /// 한도와 함께 빈 레지스트리 생성.
    pub fn new(max_devices: usize) -> Self {
        DeviceRegistry {
            devices: HashMap::new(),
            nonces: NonceLedger::default(),
            max_devices,
        }
    }

    /// 페어링(TOFU) — 기기 공개키 핀닝 + scope 부여 + active.
    ///
    /// - 32바이트 공개키는 `VerifyingKey::from_bytes`(Result) 로 파싱 → 약/소위수 포함
    ///   유효하지 않은 점은 InvalidKey.
    /// - 동일 device_id 재페어링: **같은 키면** 멱등(scope 갱신), **다른 키면** KeyMismatch
    ///   (TOFU — 조용한 키 교체 0). revoked 기기 재페어링도 같은 키만 허용(재활성 경로).
    /// - 새 기기인데 active 기기 수가 max_devices 이상이면 CapacityExceeded(N+1 거부).
    pub fn pair(
        &mut self,
        device_id: &str,
        public_key: &[u8; 32],
        granted_scope: Scope,
    ) -> Result<(), PairError> {
        // 키 파싱 — from_bytes 는 Result(유효 점만 통과). 약/소위수 키는 verify_strict 가
        // 추가로 막지만, 핀닝 시점에 이미 거른다.
        let key = VerifyingKey::from_bytes(public_key).map_err(|_| PairError::InvalidKey)?;
        // is_weak 사전검사 — 소위수 키를 핀닝 자체에서 차단(이중 방어).
        if key.is_weak() {
            return Err(PairError::InvalidKey);
        }

        if let Some(existing) = self.devices.get_mut(device_id) {
            // 재페어링: TOFU — 키가 다르면 거부(조용한 교체 0).
            if existing.pinned_key.as_bytes() != key.as_bytes() {
                return Err(PairError::KeyMismatch);
            }
            // 같은 키 — 멱등 갱신(scope 재부여, 재활성). 단조 워터마크는 유지.
            existing.granted_scope = granted_scope;
            existing.state = DeviceState::Active;
            return Ok(());
        }

        // 신규 기기 — 한도 검사(N+1 거부). 한도는 등록된 전체 기기 수 기준.
        if self.devices.len() >= self.max_devices {
            return Err(PairError::CapacityExceeded);
        }

        self.devices.insert(
            device_id.to_string(),
            DeviceRecord {
                pinned_key: key,
                granted_scope,
                state: DeviceState::Active,
                last_issued_at: None,
            },
        );
        Ok(())
    }

    /// revoke(deactivate) — kill-switch. 도난폰/유출키/환불 시 즉시 차단.
    /// 이후 그 기기의 어떤 assertion 도(유효 서명·신선 nonce 여도) Denied.
    /// 미상 device_id 면 false(noop), 처리됨이면 true.
    pub fn revoke(&mut self, device_id: &str) -> bool {
        match self.devices.get_mut(device_id) {
            Some(rec) => {
                rec.state = DeviceState::Revoked;
                true
            }
            None => false,
        }
    }

    /// 활성 페어링 여부 — 등록 + active.
    pub fn is_paired(&self, device_id: &str) -> bool {
        matches!(
            self.devices.get(device_id),
            Some(rec) if rec.state == DeviceState::Active
        )
    }

    /// 등록된(상태 무관) 기기 수 — 한도 회계.
    pub fn device_count(&self) -> usize {
        self.devices.len()
    }

    // -----------------------------------------------------------------------
    // verify() — 하한선(the floor). 모든 검사를 fail-closed 로 통과한 뒤에만 봉인.
    // -----------------------------------------------------------------------

    /// assertion + 분리 서명 + ctx 를 검증해 AuthDecision 을 낸다.
    ///
    /// `&mut self`: nonce 소비라는 **부작용**과 issued_at 워터마크 전진을 위해 필요.
    /// 게이트가 실행에 엮인 핵심 — 부작용(NonceProof) 없이는 Grant 봉인 불가.
    ///
    /// 강제 항목(전부 통과해야 Granted, 하나라도 실패/미상 ⇒ Denied):
    ///   1. 기기가 페어링 + active (미상/취소 재검사 — 매 호출).
    ///   2. verify_strict(핀닝 공개키, canonical_bytes, sig) Ok (위조/타키/약키 거부).
    ///   3. now < exp (신선도).
    ///   4. issued_at >= last_issued_at (monotonic 비감소 — 시계 되돌리기/옛것 재생 거부).
    ///      엄격 부등(<)으로 **더 과거만** 거부한다. 동률(같은 초의 distinct 액션)은 통과시키고
    ///      재생 판정은 nonce 게이트에 맡긴다 — 단조와 nonce 의 책임을 분리(license doc
    ///      Worker 순서 가드가 `>` 를 쓰는 이유: 동시각 distinct 이벤트를 드롭하면 안 됨).
    ///   5. nonce 단일사용 소비(재생 거부) — **소비 성공이 봉인의 필수 입력**.
    ///   6. 요청 scope ⊆ 부여 scope (상승 거부 — 매 호출).
    ///   7. destructive ⇒ Grant 가 DesktopConfirmRequired 를 싣는다(자동 grant 0).
    ///
    /// 순서 주의: 워터마크/nonce 변이는 **다른 모든 검사 통과 후** 마지막에 한다.
    /// 그래서 실패한 시도가 워터마크를 전진시키거나 nonce 를 소비하지 않는다(DoS/오염 0).
    pub fn verify(
        &mut self,
        assertion: &CapabilityAssertion,
        signature: &[u8],
        ctx: VerifyCtx,
    ) -> AuthDecision {
        // (1) 페어링 + active 재검사. 미상/취소 ⇒ Denied. 레코드를 **복제**해 불변
        //     검사를 먼저 끝내고, 변이(워터마크/nonce)는 맨 끝에서만 한다.
        let record = match self.devices.get(&assertion.device_id) {
            None => return AuthDecision::Denied(DenyReason::UnknownDevice),
            Some(rec) if rec.state == DeviceState::Revoked => {
                return AuthDecision::Denied(DenyReason::DeviceRevoked);
            }
            Some(rec) => rec.clone(),
        };

        // (2) 서명 검증 — verify_strict(약/소위수 키 forgery 차단). 일반 verify() 금지.
        //     서명 길이가 정확히 64B 가 아니면 거부(형식 불량 = 위조 취급).
        let sig = match parse_signature(signature) {
            Some(s) => s,
            None => return AuthDecision::Denied(DenyReason::BadSignature),
        };
        let msg = assertion.canonical_bytes();
        if record.pinned_key.verify_strict(&msg, &sig).is_err() {
            return AuthDecision::Denied(DenyReason::BadSignature);
        }

        // (3) 신선도 — now < exp. 만료 assertion 거부.
        if ctx.now >= assertion.exp {
            return AuthDecision::Denied(DenyReason::Expired);
        }

        // (4) 단조(비감소) — issued_at 이 마지막 수락값보다 **더 과거면** 거부(시계 되돌리기/
        //     옛 assertion 재생). 동률은 통과 — 같은 초의 distinct 액션을 허용하고, 통째 재생
        //     (같은 nonce)은 (5) nonce 게이트가 잡는다. 두 방어의 책임 분리.
        if let Some(last) = record.last_issued_at {
            if assertion.issued_at < last {
                return AuthDecision::Denied(DenyReason::ClockRollback);
            }
        }

        // (6) scope ⊆ granted — 매 호출 강제. read-only 기기가 destructive 요청 ⇒ 거부.
        //     (5 nonce 소비보다 먼저 검사 — 실패 시 nonce 를 태우지 않는다.)
        if !assertion.scope.is_subset_of(record.granted_scope) {
            return AuthDecision::Denied(DenyReason::ScopeEscalation);
        }

        // ---- 여기까지 모든 불변 검사 통과. 이제부터 변이(부작용). ----

        // (5) nonce 단일사용 소비 — **봉인의 필수 입력**. 재생이면 None ⇒ Denied.
        //     NOP-패치 불변식: 이 소비를 지우면 NonceProof 가 없어 Grant::seal 호출 불가.
        let nonce_proof = match self.nonces.consume(assertion.nonce) {
            Some(p) => p,
            None => return AuthDecision::Denied(DenyReason::NonceReplay),
        };

        // 단조 워터마크 전진(소비 성공 후에만). 다음 assertion 은 이보다 커야 한다.
        if let Some(rec) = self.devices.get_mut(&assertion.device_id) {
            rec.last_issued_at = Some(assertion.issued_at);
        }

        // (7) destructive ⇒ 데스크톱 confirm 요구를 싣는다. read-only/write 면 None.
        //     destructive 가 confirm 없이 자동 Granted 되는 일은 구조적으로 불가
        //     (이 분기 외에 Grant 를 만들 다른 경로가 없다).
        let desktop_confirm = if assertion.scope.is_destructive() {
            Some(DesktopConfirmRequired::new(
                assertion.device_id.clone(),
                assertion.nonce,
            ))
        } else {
            None
        };

        // 단일 봉인점 — NonceProof 소유 이동을 요구. 모든 검사 통과의 산물.
        let grant = Grant::seal(
            assertion.device_id.clone(),
            assertion.scope,
            nonce_proof,
            desktop_confirm,
        );
        AuthDecision::Granted(grant)
    }
}

/// 분리 서명 바이트(64B) → Signature. v2 에서 64B 배열의 from_bytes 는 infallible 이나,
/// 슬라이스 길이가 정확히 64 가 아니면 위조/형식불량 취급(None).
fn parse_signature(bytes: &[u8]) -> Option<Signature> {
    if bytes.len() != SIGNATURE_LENGTH {
        return None;
    }
    let arr: [u8; SIGNATURE_LENGTH] = bytes.try_into().ok()?;
    // v2: Signature::from_bytes(&[u8; 64]) 는 infallible — Signature 직접 반환.
    Some(Signature::from_bytes(&arr))
}

// ===========================================================================
// 7. AuthorizedAction — destructive 경로의 실행 결속(데스크톱 confirm 권위)
// ===========================================================================

/// 데스크톱이 발급하는 confirm 토큰. 생성자 private(이 모듈 = 데스크톱 권위 경계) →
/// 폰(원격)이 만들 수 없다. 토큰은 특정 (device, nonce) 에 결속된다.
#[derive(Debug, Clone)]
pub struct DesktopConfirmToken {
    device_id: String,
    bound_nonce: [u8; 32],
}

impl DesktopConfirmToken {
    /// 데스크톱 권위가 사용자 confirm 후 발급. 폰이 스스로 호출할 수 없는 경계 함수
    /// (transport 의 데스크톱 측에서만 도달). config 로 끄거나 폰이 우회 불가.
    pub fn issue_after_desktop_confirm(device_id: &str, bound_nonce: [u8; 32]) -> Self {
        DesktopConfirmToken {
            device_id: device_id.to_string(),
            bound_nonce,
        }
    }
}

/// 실행 가능한 인가 액션 — transport 가 route() 호출 전에 보유해야 하는 봉인 값.
/// 생성자가 Grant 를 요구하고, destructive 면 매칭 DesktopConfirmToken 까지 요구한다.
/// 단일 if 우회 불가: destructive 인데 confirm 토큰이 없으면 **구성 자체가 실패**한다.
#[derive(Debug)]
pub struct AuthorizedAction {
    device_id: String,
    scope: Scope,
}

impl AuthorizedAction {
    /// Grant 를 실행 가능한 액션으로 승격한다.
    ///
    /// - read-only/write: confirm 불요 → token=None 으로 즉시 Ok.
    /// - destructive: Grant 가 DesktopConfirmRequired 를 싣고 있고, 발급된
    ///   DesktopConfirmToken 이 **동일 (device, nonce)** 에 매칭돼야 Ok. 없거나 불일치면
    ///   Err — 폰은 토큰을 못 만드므로 데스크톱 confirm 없이 destructive 실행 0.
    pub fn authorize(
        grant: &Grant,
        desktop_token: Option<&DesktopConfirmToken>,
    ) -> Result<AuthorizedAction, AuthorizeError> {
        match grant.desktop_confirm() {
            // destructive — confirm 권위 필수.
            Some(required) => {
                let token = desktop_token.ok_or(AuthorizeError::DesktopConfirmRequired)?;
                if token.device_id != required.device_id()
                    || token.bound_nonce != required.bound_nonce()
                {
                    return Err(AuthorizeError::ConfirmMismatch);
                }
                Ok(AuthorizedAction {
                    device_id: grant.device_id().to_string(),
                    scope: grant.scope(),
                })
            }
            // 비파괴 — confirm 불요.
            None => Ok(AuthorizedAction {
                device_id: grant.device_id().to_string(),
                scope: grant.scope(),
            }),
        }
    }

    pub fn device_id(&self) -> &str {
        &self.device_id
    }

    pub fn scope(&self) -> Scope {
        self.scope
    }
}

/// AuthorizedAction 구성 실패 사유.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuthorizeError {
    /// destructive 인데 데스크톱 confirm 토큰이 제공되지 않음.
    DesktopConfirmRequired,
    /// confirm 토큰이 (device, nonce) 와 불일치.
    ConfirmMismatch,
}

#[cfg(test)]
mod tests;
