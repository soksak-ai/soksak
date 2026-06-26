// app.data 암호화(단계②) — 인덱스 인지 doc 분할 봉인. blocker① 해소의 핵심:
// query 는 `json_extract(doc, '$.field')` 표현식 인덱스로 필터한다(store.rs). doc 전체를 봉인하면
// json_extract 가 NULL → 0 행(헤드라인 비동작). 그래서 **선언된 인덱스 필드 + id 는 평문 top-level 로
// 남기고**(query·order 가 그대로 탄다), 나머지 민감 페이로드만 X25519 SealedBox 로 봉인한다.
//
// 저장 형태(enc=1): { id, <인덱스필드들>, __enc: { k: keyId, b: SealedBox } }
//   - 평문: id ∪ 인덱스필드 — 저자가 query 가능하라고 선언한 비밀 아닌 필드(R6/R19).
//   - 봉인: 그 외 전부(output/commandLine/cwd…) — whole-doc 보안에서 인덱스만 뺀 것(R19).
// FTS 가 봉인 필드를 가리키면 암호화 scope 에선 색인 불가(자격증명 평문 노출 금지, R19) — 호출자가 무력화.
//
// AAD = canonical(ns|coll|scope|id|keyId|enc) 를 inner AEAD 에 바인딩 → 재배치/replay/교차-scope 이동 거부(R11).
// 봉인은 공개키 P 만 쓴다(개인키 불요) → vault lock 중에도 at-rest 쓰기 가능(단계③ auto-lock 의 전제).

use crate::secrets::{self, SealedBox};
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use rusqlite::{Connection, OptionalExtension};
use serde_json::{json, Map, Value};

// 현재 봉투 알고리즘 식별자 — 미래 마이그레이션 분기용(헤더에 기록).
pub const ALGO_V1: &str = "x25519-hkdf-sha256-xchacha20poly1305-v1";

// 새 keyId — "k-" + 9 랜덤바이트 base64url(검증 통과 문자만: A-Za-z0-9-_). vault key·테이블 PK 양쪽 안전.
pub fn new_key_id() -> String {
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use rand::RngCore;
    let mut b = [0u8; 9];
    rand::rngs::OsRng.fill_bytes(&mut b);
    format!("k-{}", URL_SAFE_NO_PAD.encode(b))
}

// 봉인된 나머지 페이로드가 담기는 예약 필드. 평문 doc 에 이 키가 있으면 충돌이므로 호출자가 거부해야.
pub const ENC_FIELD: &str = "__enc";

// AAD canonical — 봉인 컨텍스트 바인딩. enc 표식 "1" 고정(평문은 봉인 안 함). 구분자 '|' 는
// 필드값에 등장 가능하나 ns/coll/scope/id/keyId 는 검증된 식별자(영숫자·-·_·.)라 '|' 미포함 → 모호성 0.
pub fn canonical_aad(ns: &str, coll: &str, scope: &str, id: &str, key_id: &str) -> Vec<u8> {
    format!("{ns}|{coll}|{scope}|{id}|{key_id}|1").into_bytes()
}

// doc 를 (평문 top-level: id ∪ plaintext_fields) + (봉인 나머지)로 분할해 공개키 P 로 봉인.
// plaintext_fields = 선언된 인덱스 필드(query 가능 유지). 반환 = 저장할 Value(enc=1 형태).
pub fn seal_doc(
    doc: &Value,
    plaintext_fields: &[String],
    recipient_pk: &[u8; 32],
    key_id: &str,
    aad: &[u8],
) -> Result<Value, String> {
    let obj = doc.as_object().ok_or("doc 는 객체여야 함")?;
    if obj.contains_key(ENC_FIELD) {
        return Err(format!("doc 가 예약 필드 {ENC_FIELD} 를 포함함"));
    }
    let mut public = Map::new();
    let mut sealed_part = Map::new();
    for (k, v) in obj {
        if k == "id" || plaintext_fields.iter().any(|f| f == k) {
            public.insert(k.clone(), v.clone()); // 평문 유지(query·order)
        } else {
            sealed_part.insert(k.clone(), v.clone()); // 봉인 대상
        }
    }
    let payload = serde_json::to_vec(&Value::Object(sealed_part)).map_err(|e| e.to_string())?;
    let boxed = secrets::seal_to(recipient_pk, &payload, aad)?;
    public.insert(ENC_FIELD.to_string(), json!({ "k": key_id, "b": boxed }));
    Ok(Value::Object(public))
}

// 봉인 doc 개봉 → 원본 doc 복원. 개인키 S 로 __enc 개봉 후 평문 top-level 과 병합(__enc 제거).
// aad 불일치·변조·잘못된 키 → Err(평문 누출 0).
pub fn open_doc(stored: &Value, secret: &[u8; 32], aad: &[u8]) -> Result<Value, String> {
    let obj = stored.as_object().ok_or("저장 doc 는 객체여야 함")?;
    let enc = obj.get(ENC_FIELD).ok_or("__enc 필드 없음(평문 레코드?)")?;
    let boxed: SealedBox = serde_json::from_value(enc.get("b").cloned().ok_or("__enc.b 없음")?)
        .map_err(|e| e.to_string())?;
    let payload = secrets::open_sealed(secret, &boxed, aad)?;
    let sealed_part: Value = serde_json::from_slice(&payload).map_err(|e| e.to_string())?;
    let mut out = Map::new();
    for (k, v) in obj {
        if k != ENC_FIELD {
            out.insert(k.clone(), v.clone()); // 평문 top-level(id+인덱스)
        }
    }
    if let Value::Object(sp) = sealed_part {
        for (k, v) in sp {
            out.insert(k, v); // 봉인 페이로드 병합
        }
    }
    Ok(Value::Object(out))
}

// ── encryption_keys — scope 별 봉투 키 메타(R18) ─────────────────────────────
// 공개키 P 만 여기(평문 — 공개값). 개인키 S 는 vault 에만(KEK wrap, commands 레벨). status='active'
// 행의 존재 자체가 **암호화 트리거**다(fail-closed, blocker high) — 별도 enable 불리언 없음.
// 회전 = 새 active 추가 + 옛 active→retired. retired 폐기는 그 키로 봉인된 enc=1 레코드 0일 때만(R18).

#[derive(Debug, Clone, PartialEq)]
pub struct ActiveKey {
    pub key_id: String,
    pub public_key: [u8; 32],
}

// 부팅 시 1회 — 테이블 + active 부분 인덱스. init_base 에서 호출(멱등). recovery = R24 복구 blob(암호문,
// 평문 저장 안전 — recovery code 로만 열림). 기존 DB(recovery 컬럼 없는)는 멱등 ALTER 로 추가.
pub fn init_keys_table(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS encryption_keys (\
            scope TEXT NOT NULL, keyId TEXT NOT NULL,\
            publicKey TEXT NOT NULL, algo TEXT NOT NULL,\
            status TEXT NOT NULL, created INTEGER NOT NULL,\
            recovery TEXT,\
            PRIMARY KEY(scope, keyId)\
         );\
         CREATE INDEX IF NOT EXISTS encryption_keys_active ON encryption_keys(scope) WHERE status='active';",
    )
    .map_err(|e| e.to_string())?;
    // [R24] 기존 DB(recovery 컬럼 부재) 멱등 마이그레이션.
    let has_recovery: bool = conn
        .prepare("SELECT 1 FROM pragma_table_info('encryption_keys') WHERE name='recovery'")
        .map_err(|e| e.to_string())?
        .exists([])
        .map_err(|e| e.to_string())?;
    if !has_recovery {
        conn.execute_batch("ALTER TABLE encryption_keys ADD COLUMN recovery TEXT;")
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

// [R24] 키 행에 recovery blob 저장(JSON 문자열). enable 시 keypair 생성 직후 1회.
pub fn set_recovery(conn: &Connection, scope: &str, key_id: &str, recovery_json: &str) -> Result<(), String> {
    let n = conn
        .execute(
            "UPDATE encryption_keys SET recovery=?3 WHERE scope=?1 AND keyId=?2",
            (scope, key_id, recovery_json),
        )
        .map_err(|e| e.to_string())?;
    if n == 0 {
        return Err(format!("키 {key_id} 없음 — recovery 저장 실패"));
    }
    Ok(())
}

// [R24] active 키의 recovery blob 조회 — 복구 흐름이 읽는다. 없으면 None.
pub fn active_recovery(conn: &Connection, scope: &str) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT recovery FROM encryption_keys WHERE scope=?1 AND status='active'",
        [scope],
        |r| r.get::<_, Option<String>>(0),
    )
    .optional()
    .map_err(|e| e.to_string())
    .map(|o| o.flatten())
}

fn decode_pk(b64: &str) -> Result<[u8; 32], String> {
    let raw = STANDARD.decode(b64).map_err(|e| format!("publicKey b64: {e}"))?;
    if raw.len() != 32 {
        return Err("publicKey 길이 오류(32B 아님)".to_string());
    }
    let mut p = [0u8; 32];
    p.copy_from_slice(&raw);
    Ok(p)
}

// [R23] 이 DB 에 봉투 키가 하나라도 등록됐는가 — 등록됐다면 그 개인키 S 가 vault 에 있어야 한다(과거
// vault 존재 증거). 부팅 시 이게 true 인데 vault 파일이 없으면(삭제·손실) secrets 가 새 vault 자동생성을
// 거부한다 — 임의 passphrase 가 통과해 봉인 레코드가 영구 복호불가가 되는 footgun 차단(prevention).
pub fn has_any_keys(conn: &Connection) -> Result<bool, String> {
    conn.query_row("SELECT EXISTS(SELECT 1 FROM encryption_keys)", [], |r| r.get::<_, i64>(0))
        .map(|n| n != 0)
        .map_err(|e| e.to_string())
}

// scope 의 active 키 — Some 이면 이 scope 의 put 은 반드시 봉인해야(fail-closed 트리거).
pub fn active_key(conn: &Connection, scope: &str) -> Result<Option<ActiveKey>, String> {
    let row = conn
        .query_row(
            "SELECT keyId, publicKey FROM encryption_keys WHERE scope=?1 AND status='active'",
            [scope],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    match row {
        Some((key_id, pk_b64)) => Ok(Some(ActiveKey { key_id, public_key: decode_pk(&pk_b64)? })),
        None => Ok(None),
    }
}

// 새 active 키 등록 — 기존 active 가 있으면 retired 로 내리고(단일 트랜잭션) 새 active 삽입(회전 포함).
// publicKey 는 호출자가 S 로부터 public_from_secret 으로 만든 P(검증된 페어). created=now.
pub fn register_active_key(
    conn: &Connection,
    scope: &str,
    key_id: &str,
    public_key: &[u8; 32],
    created: i64,
) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    tx.execute(
        "UPDATE encryption_keys SET status='retired' WHERE scope=?1 AND status='active'",
        [scope],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT INTO encryption_keys(scope,keyId,publicKey,algo,status,created) \
         VALUES(?1,?2,?3,?4,'active',?5)",
        (scope, key_id, STANDARD.encode(public_key), ALGO_V1, created),
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

// [blocker④] active key 의 publicKey P 가 vault 의 개인키 S 에서 파생됐는지 검증 — P==basepoint(S).
// 공격자가 encryption_keys.publicKey 를 자기 키로 스왑하면 byte-eq 가 깨진다 → 탐지. S 는 vault 에서
// (호출자가 unlock 후 get_data_key 로). 키 없으면 검증 대상 아님(true). 스왑 탐지 시 false.
pub fn verify_active_key(conn: &Connection, scope: &str, secret: &[u8; 32]) -> Result<bool, String> {
    match active_key(conn, scope)? {
        Some(ak) => Ok(crate::secrets::public_from_secret(secret) == ak.public_key),
        None => Ok(true),
    }
}

// 특정 키로 봉인된(enc=1) 레코드 수 — retired 키 폐기 가드(R18: 0 일 때만 폐기 안전).
pub fn count_sealed_with_key(conn: &Connection, scope: &str, key_id: &str) -> Result<i64, String> {
    conn.query_row(
        "SELECT COUNT(*) FROM records WHERE scope=?1 AND keyId=?2 AND enc=1",
        (scope, key_id),
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}

// retired 키 폐기 — 그 키로 봉인된 enc=1 레코드가 0 일 때만(아니면 Err, 영구손실 차단). vault 의 S 삭제는
// 호출자(commands)가 이 성공 직후 동일 흐름에서 수행한다.
pub fn dispose_retired_key(conn: &Connection, scope: &str, key_id: &str) -> Result<(), String> {
    let remaining = count_sealed_with_key(conn, scope, key_id)?;
    if remaining != 0 {
        return Err(format!("키 {key_id} 로 봉인된 레코드 {remaining}개 잔존 — 폐기 거부(R18)"));
    }
    conn.execute(
        "DELETE FROM encryption_keys WHERE scope=?1 AND keyId=?2 AND status='retired'",
        (scope, key_id),
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secrets::gen_asym_keypair;

    fn mem() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::data::init_base(&conn).unwrap();
        conn
    }

    fn sample() -> Value {
        json!({
            "id": "rec-1",
            "viewId": "term-7",        // 인덱스(평문 유지)
            "startTs": 1718900000000i64, // 인덱스(평문 유지)
            "commandLine": "export TOKEN=sk-abcd1234", // 봉인(자격증명)
            "output": "secret echo line\nrow2",        // 봉인
            "exitCode": 0,             // 봉인
            "nested": { "a": 1, "b": [true, null, "x"] } // 봉인(lossless 검증)
        })
    }
    fn idx() -> Vec<String> {
        vec!["viewId".to_string(), "startTs".to_string()]
    }

    // (c-a, blocker① 단위) seal_doc 결과: 인덱스 필드 + id 는 평문 top-level, 민감 필드는 부재.
    #[test]
    fn sealed_keeps_index_plaintext_hides_payload() {
        let (_s, p) = gen_asym_keypair();
        let aad = canonical_aad("terminal", "command_blocks", "proj-a", "rec-1", "key-1");
        let sealed = seal_doc(&sample(), &idx(), &p, "key-1", &aad).unwrap();
        let o = sealed.as_object().unwrap();
        // 평문 유지(json_extract query 가 타는 필드).
        assert_eq!(o.get("id").unwrap(), "rec-1");
        assert_eq!(o.get("viewId").unwrap(), "term-7");
        assert_eq!(o.get("startTs").unwrap(), 1718900000000i64);
        // 민감 필드는 top-level 에 평문으로 없어야(봉인됨).
        assert!(o.get("commandLine").is_none(), "commandLine 평문 노출 0");
        assert!(o.get("output").is_none(), "output 평문 노출 0");
        assert!(o.get("__enc").is_some(), "__enc 봉투 존재");
        // 직렬화 전체 문자열에도 비밀 평문 부재(blob 안에만).
        let s = serde_json::to_string(&sealed).unwrap();
        assert!(!s.contains("sk-abcd1234"), "자격증명 평문 누출 0");
        assert!(!s.contains("secret echo"), "output 평문 누출 0");
    }

    // (c-b) seal→open roundtrip — 원본 doc 전 필드·타입 복원(lossless, R22 중첩 객체·배열·null·bool·number).
    #[test]
    fn seal_open_roundtrip_lossless() {
        let (s, p) = gen_asym_keypair();
        let aad = canonical_aad("terminal", "command_blocks", "proj-a", "rec-1", "key-1");
        let sealed = seal_doc(&sample(), &idx(), &p, "key-1", &aad).unwrap();
        let opened = open_doc(&sealed, &s, &aad).unwrap();
        assert_eq!(opened, sample(), "개봉 doc 는 원본과 완전 동일(타입·값 보존)");
    }

    // (c-c, R11) AAD 불일치(scope 변조) → open Err. 봉인을 타 scope 행으로 옮겨도 개봉 불가.
    #[test]
    fn cross_scope_move_rejected() {
        let (s, p) = gen_asym_keypair();
        let aad_a = canonical_aad("terminal", "command_blocks", "proj-a", "rec-1", "key-1");
        let aad_b = canonical_aad("terminal", "command_blocks", "proj-b", "rec-1", "key-1");
        let sealed = seal_doc(&sample(), &idx(), &p, "key-1", &aad_a).unwrap();
        assert!(open_doc(&sealed, &s, &aad_b).is_err(), "타 scope AAD 로 개봉 거부");
        assert!(open_doc(&sealed, &s, &aad_a).is_ok(), "정합 AAD 는 성공");
    }

    // (c-d) 봉투가 keyId 를 자기기술(__enc.k) + 예약 필드 충돌 거부.
    #[test]
    fn key_id_and_reserved_field() {
        let (_s, p) = gen_asym_keypair();
        let aad = canonical_aad("terminal", "command_blocks", "proj-a", "rec-1", "key-9");
        let sealed = seal_doc(&sample(), &idx(), &p, "key-9", &aad).unwrap();
        assert_eq!(sealed.get(ENC_FIELD).unwrap().get("k").unwrap(), "key-9", "봉투가 keyId 자기기술");
        // doc 가 이미 __enc 를 담으면 거부(봉투 자리 충돌).
        let bad = json!({ "id": "x", "__enc": 1 });
        assert!(seal_doc(&bad, &[], &p, "key-9", &aad).is_err());
    }

    // (k-a, fail-closed) active_key — 키 없으면 None, 등록 후 Some(P 라운드트립).
    #[test]
    fn active_key_trigger() {
        let c = mem();
        assert!(active_key(&c, "proj-a").unwrap().is_none(), "키 없으면 트리거 0");
        let (_s, p) = gen_asym_keypair();
        register_active_key(&c, "proj-a", "key-1", &p, 100).unwrap();
        let ak = active_key(&c, "proj-a").unwrap().unwrap();
        assert_eq!(ak.key_id, "key-1");
        assert_eq!(ak.public_key, p, "저장 P 가 b64 라운드트립으로 복원");
        // 다른 scope 는 독립(트리거 0).
        assert!(active_key(&c, "proj-b").unwrap().is_none());
    }

    // (k-b) 회전 — 새 active 등록 시 옛 active→retired, scope 당 active 1개 불변.
    #[test]
    fn rotation_retires_old() {
        let c = mem();
        let (_s1, p1) = gen_asym_keypair();
        let (_s2, p2) = gen_asym_keypair();
        register_active_key(&c, "proj-a", "key-1", &p1, 100).unwrap();
        register_active_key(&c, "proj-a", "key-2", &p2, 200).unwrap();
        let ak = active_key(&c, "proj-a").unwrap().unwrap();
        assert_eq!(ak.key_id, "key-2", "최신 키가 active");
        assert_eq!(ak.public_key, p2);
        // active 는 정확히 1개.
        let n: i64 = c
            .query_row(
                "SELECT COUNT(*) FROM encryption_keys WHERE scope='proj-a' AND status='active'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 1, "scope 당 active 1개 불변");
    }

    // (k-e, R24/B10) recovery blob 저장/조회 + 코드로 S 복구 — passphrase 분실 시 독립 복구 경로.
    #[test]
    fn recovery_blob_store_and_recover() {
        use crate::secrets::{gen_recovery_code, public_from_secret, recovery_unwrap, recovery_wrap, RecoveryBlob};
        let c = mem();
        let (s, p) = gen_asym_keypair();
        register_active_key(&c, "proj-a", "key-1", &p, 100).unwrap();
        // enable 흐름 모의 — recovery code 로 S wrap → blob 저장.
        let code = gen_recovery_code();
        let (salt, sealed) = recovery_wrap(&code, &s).unwrap();
        let blob_json = serde_json::to_string(&RecoveryBlob { salt, sealed }).unwrap();
        set_recovery(&c, "proj-a", "key-1", &blob_json).unwrap();
        // active_recovery 로 조회.
        let got = active_recovery(&c, "proj-a").unwrap().unwrap();
        let blob: RecoveryBlob = serde_json::from_str(&got).unwrap();
        // 코드로 S 복구 → 등록 P 와 일치(무결성).
        let recovered = recovery_unwrap(&code, &blob.salt, &blob.sealed).unwrap();
        assert_eq!(recovered, s.to_vec(), "코드로 S 복구");
        let mut rs = [0u8; 32];
        rs.copy_from_slice(&recovered);
        assert_eq!(public_from_secret(&rs), p, "복구된 S 가 등록 P 와 일치");
        // recovery 없는 scope → None.
        assert!(active_recovery(&c, "proj-z").unwrap().is_none());
    }

    // (k-d, blocker④) 키스왑 탐지 — publicKey 를 공격자 P 로 변조하면 verify_active_key 가 false.
    #[test]
    fn key_swap_detected() {
        let c = mem();
        let (s, p) = gen_asym_keypair();
        register_active_key(&c, "proj-a", "key-1", &p, 100).unwrap();
        assert!(verify_active_key(&c, "proj-a", &s).unwrap(), "정상 키페어는 검증 통과");
        // 공격자가 테이블의 publicKey 를 자기 P 로 스왑.
        let (_s_atk, p_atk) = gen_asym_keypair();
        c.execute(
            "UPDATE encryption_keys SET publicKey=?1 WHERE scope='proj-a' AND keyId='key-1'",
            [base64::engine::general_purpose::STANDARD.encode(p_atk)],
        )
        .unwrap();
        assert!(!verify_active_key(&c, "proj-a", &s).unwrap(), "스왑된 P 는 우리 S 와 불일치 → 탐지");
        // 키 없는 scope 는 검증 대상 아님(true).
        assert!(verify_active_key(&c, "proj-z", &s).unwrap());
    }

    // (k-c, R18) retired 폐기 가드 — 그 키로 봉인된 enc=1 레코드가 있으면 폐기 거부, 0 이면 성공.
    #[test]
    fn dispose_blocked_until_zero() {
        let c = mem();
        let (_s1, p1) = gen_asym_keypair();
        let (_s2, p2) = gen_asym_keypair();
        register_active_key(&c, "proj-a", "key-1", &p1, 100).unwrap();
        // key-1 로 봉인된 레코드 1개 직접 주입.
        c.execute(
            "INSERT INTO records(ns,coll,scope,id,doc,created,updated,enc,keyId) \
             VALUES('terminal','command_blocks','proj-a','r1','{}',1,1,1,'key-1')",
            [],
        )
        .unwrap();
        register_active_key(&c, "proj-a", "key-2", &p2, 200).unwrap(); // key-1 retired
        assert_eq!(count_sealed_with_key(&c, "proj-a", "key-1").unwrap(), 1);
        assert!(dispose_retired_key(&c, "proj-a", "key-1").is_err(), "잔존 레코드 → 폐기 거부");
        // 레코드를 key-2 로 재봉인(변환)했다고 가정 → key-1 잔존 0.
        c.execute("UPDATE records SET keyId='key-2' WHERE id='r1'", []).unwrap();
        assert_eq!(count_sealed_with_key(&c, "proj-a", "key-1").unwrap(), 0);
        assert!(dispose_retired_key(&c, "proj-a", "key-1").is_ok(), "잔존 0 → 폐기 성공");
        // 폐기 후 메타에서 사라짐.
        let n: i64 = c
            .query_row("SELECT COUNT(*) FROM encryption_keys WHERE keyId='key-1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0);
    }
}
