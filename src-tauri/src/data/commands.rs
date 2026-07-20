// app.data 의 Tauri 커맨드 표면. 프론트 app.data.* → invoke → 여기. ns 는 호출 측(api.ts)이
// pluginId 로 주입하고 여기서 재검증한다. 변경 커맨드는 app.emit("data-change") 로 전 창 브로드캐스트
// → 프론트 app.data.watch 가 재질의(멀티윈도우·같은 프로젝트 일관, 폴링 0).

use rusqlite::Connection;
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, State};

use super::{backup, db_path, store, validate_ns, DbState};
use crate::secrets::SecretsState;

#[derive(Serialize, Clone)]
struct DataChange {
    ns: String,
    coll: Option<String>,
    scope: Option<String>,
    op: String,
    id: Option<String>,
}

#[allow(clippy::too_many_arguments)]
fn emit_change(
    app: &AppHandle,
    ns: &str,
    coll: Option<&str>,
    scope: Option<&str>,
    op: &str,
    id: Option<&str>,
) {
    let _ = app.emit(
        "data-change",
        DataChange {
            ns: ns.to_string(),
            coll: coll.map(String::from),
            scope: scope.map(String::from),
            op: op.to_string(),
            id: id.map(String::from),
        },
    );
    // 쓰기 사실 = 백업 링의 유일한 트리거(폴링 0) — 게이트(1h mtime)와 회전은 ring 이 소유한다.
    super::ring::on_write();
}

fn with_conn<T>(
    state: &DbState,
    f: impl FnOnce(&Connection) -> Result<T, String>,
) -> Result<T, String> {
    let guard = state.conn.lock().map_err(|e| e.to_string())?;
    let conn = guard.as_ref().ok_or("DB 미초기화")?;
    f(conn)
}

// ── KV ───────────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn data_kv_get(
    ns: String,
    key: String,
    state: State<'_, DbState>,
) -> Result<Option<Value>, String> {
    validate_ns(&ns)?;
    with_conn(&state, |c| store::kv_get(c, &ns, &key))
}

#[tauri::command]
pub fn data_kv_set(
    app: AppHandle,
    ns: String,
    key: String,
    value: Value,
    state: State<'_, DbState>,
) -> Result<(), String> {
    validate_ns(&ns)?;
    with_conn(&state, |c| store::kv_set(c, &ns, &key, &value))?;
    emit_change(&app, &ns, None, None, "kv_set", Some(key.as_str()));
    Ok(())
}

#[tauri::command]
pub fn data_kv_delete(
    app: AppHandle,
    ns: String,
    key: String,
    state: State<'_, DbState>,
) -> Result<bool, String> {
    validate_ns(&ns)?;
    let removed = with_conn(&state, |c| store::kv_delete(c, &ns, &key))?;
    if removed {
        emit_change(&app, &ns, None, None, "kv_delete", Some(key.as_str()));
    }
    Ok(removed)
}

#[tauri::command]
pub fn data_kv_keys(
    ns: String,
    prefix: Option<String>,
    state: State<'_, DbState>,
) -> Result<Vec<String>, String> {
    validate_ns(&ns)?;
    with_conn(&state, |c| store::kv_keys(c, &ns, prefix.as_deref()))
}

// ── 컬렉션 ──────────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn data_define(
    ns: String,
    coll: String,
    indexes: Vec<String>,
    fts: Vec<String>,
    state: State<'_, DbState>,
) -> Result<(), String> {
    validate_ns(&ns)?;
    with_conn(&state, |c| store::define(c, &ns, &coll, &indexes, &fts))
}

#[tauri::command]
pub fn data_put(
    app: AppHandle,
    ns: String,
    coll: String,
    scope: Option<String>,
    id: Option<String>,
    doc: Value,
    state: State<'_, DbState>,
) -> Result<String, String> {
    validate_ns(&ns)?;
    let scope_s = scope.unwrap_or_default();
    let new_id = with_conn(&state, |c| store::put(c, &ns, &coll, &scope_s, id, &doc))?;
    emit_change(
        &app,
        &ns,
        Some(coll.as_str()),
        Some(scope_s.as_str()),
        "put",
        Some(new_id.as_str()),
    );
    Ok(new_id)
}

#[tauri::command]
pub fn data_get(
    ns: String,
    coll: String,
    id: String,
    scope: Option<String>,
    state: State<'_, DbState>,
    secrets: State<'_, SecretsState>,
) -> Result<Option<Value>, String> {
    validate_ns(&ns)?;
    // [단계②] 봉인(enc=1) 레코드는 vault 의 개인키 S 로 개봉(unlock 필요). 평문은 resolver 무관.
    let resolver = |key_id: &str| secrets.get_data_key(key_id);
    with_conn(&state, |c| {
        store::get(c, &ns, &coll, &id, scope.as_deref(), Some(&resolver))
    })
}

#[tauri::command]
pub fn data_delete(
    app: AppHandle,
    ns: String,
    coll: String,
    id: String,
    scope: Option<String>,
    state: State<'_, DbState>,
) -> Result<bool, String> {
    validate_ns(&ns)?;
    let removed = with_conn(&state, |c| {
        store::delete(c, &ns, &coll, &id, scope.as_deref())
    })?;
    if removed {
        emit_change(
            &app,
            &ns,
            Some(coll.as_str()),
            scope.as_deref(),
            "delete",
            Some(id.as_str()),
        );
    }
    Ok(removed)
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn data_query(
    ns: String,
    coll: String,
    scope: Option<String>,
    filter: Option<Value>,
    order: Option<String>,
    desc: Option<bool>,
    limit: Option<i64>,
    offset: Option<i64>,
    state: State<'_, DbState>,
    secrets: State<'_, SecretsState>,
) -> Result<Vec<Value>, String> {
    validate_ns(&ns)?;
    let resolver = |key_id: &str| secrets.get_data_key(key_id);
    with_conn(&state, |c| {
        store::query(
            c,
            &ns,
            &coll,
            scope.as_deref(),
            filter.as_ref(),
            order.as_deref(),
            desc.unwrap_or(true),
            limit,
            offset,
            Some(&resolver),
        )
    })
}

#[tauri::command]
pub fn data_search(
    ns: String,
    coll: String,
    query: String,
    scope: Option<String>,
    limit: Option<i64>,
    state: State<'_, DbState>,
    secrets: State<'_, SecretsState>,
) -> Result<Vec<Value>, String> {
    validate_ns(&ns)?;
    let resolver = |key_id: &str| secrets.get_data_key(key_id);
    with_conn(&state, |c| {
        store::search(
            c,
            &ns,
            &coll,
            &query,
            scope.as_deref(),
            limit,
            Some(&resolver),
        )
    })
}

#[tauri::command]
pub fn data_count(
    ns: String,
    coll: String,
    scope: Option<String>,
    filter: Option<Value>,
    state: State<'_, DbState>,
) -> Result<i64, String> {
    validate_ns(&ns)?;
    with_conn(&state, |c| {
        store::count(c, &ns, &coll, scope.as_deref(), filter.as_ref())
    })
}

// ── retention(R5) — 코어가 노출(R0 command registry). 반환=삭제 수. AI/E2E 가 cleanup 호출 가능. ──

// count FIFO — (ns,coll,scope) 수가 cap 초과 시 oldest(created) 축출.
#[tauri::command]
pub fn data_retention_trim(
    ns: String,
    coll: String,
    scope: String,
    cap: i64,
    state: State<'_, DbState>,
) -> Result<usize, String> {
    validate_ns(&ns)?;
    with_conn(&state, |c| {
        store::retention_trim(c, &ns, &coll, &scope, cap)
    })
}

// TTL reaper — created < cutoff_ms 삭제(시간축).
#[tauri::command]
pub fn data_retention_reap(
    ns: String,
    coll: String,
    cutoff_ms: i64,
    state: State<'_, DbState>,
) -> Result<usize, String> {
    validate_ns(&ns)?;
    with_conn(&state, |c| {
        let n = store::retention_reap_ttl(c, &ns, &coll, cutoff_ms)?;
        // [R5] reaper 가 만든 free 페이지를 bounded 반환(physical reclaim). 정리 실패는 reap 결과 비차단.
        let _ = store::incremental_vacuum(c, 256);
        Ok(n)
    })
}

// ── 암호화(단계② — scope 단위 봉투 키 라이프사이클, R0 command registry) ─────────────

use super::crypto;

#[derive(Serialize)]
pub struct EncryptionStatus {
    pub enabled: bool, // scope 에 active key 존재(= 봉인 트리거 ON)
    pub key_id: Option<String>,
    pub algo: Option<String>,
    pub unlocked: bool,    // vault(개인키 S) 해제 여부 — 복호 가능 조건
    pub tampered: bool, // [blocker④] publicKey 가 vault S 와 불일치(키스왑 탐지). unlock 상태에서만 판정.
    pub key_missing: bool, // [R23] active P 있는데 vault 에 S 없음(vault 리셋/손실) — 레코드 복호 영구 불가 경고.
}

#[derive(Serialize)]
pub struct EnableResult {
    pub key_id: String,
    // [R24] 의무 recovery code(1회 표시). passphrase 분실 시 S 복구의 유일 경로 — 사용자가 안전 보관해야
    // 하고 분실 시 영구손실. 이후 조회 불가(blob 만 DB 에 남고 코드 원문은 어디에도 저장 안 함).
    pub recovery_code: String,
}

// scope 암호화 활성 — X25519 키페어 생성, 개인키 S 를 vault 에 wrap + recovery code 로도 2중 wrap(R24),
// 공개키 P 를 테이블에 등록. 순서가 안전핀이다: S 를 vault 에 넣은 뒤에만 P 를 등록한다 — P(=봉인 트리거)만
// 있고 S 가 없으면 이후 모든 put 이 봉인되는데 영원히 복호 불가(전손)다. vault 잠김이면 여기서 Err(P 미등록).
#[tauri::command]
pub fn data_encrypt_enable(
    scope: String,
    state: State<'_, DbState>,
    secrets: State<'_, SecretsState>,
) -> Result<EnableResult, String> {
    if scope.is_empty() {
        return Err("scope 필요".to_string());
    }
    // 이미 active key 있으면 재활성 거부(중복 트리거·키 혼선 방지 — 회전은 별도 커맨드).
    if with_conn(&state, |c| crypto::active_key(c, &scope))?.is_some() {
        return Err(format!(
            "scope {scope} 는 이미 암호화 활성(회전은 rotate 커맨드)"
        ));
    }
    let (sk, pk) = crate::secrets::gen_asym_keypair();
    let key_id = crypto::new_key_id();
    // (1) S 를 vault 에 먼저 — 잠김이면 여기서 Err(P 미등록, 전손 0).
    secrets.put_data_key(&key_id, &sk)?;
    // (2) P 를 테이블에 등록(봉인 트리거 ON). 실패해도 vault 의 S 는 orphan(무해 — 트리거 없음).
    let created = super::now_millis();
    with_conn(&state, |c| {
        crypto::register_active_key(c, &scope, &key_id, &pk, created)
    })?;
    // (3) [R24] recovery code 발급 + S 를 코드로 2중 wrap → blob 저장(평문 DB 안전, 코드로만 열림).
    let recovery_code = with_conn(&state, |c| crypto::issue_recovery(c, &scope, &key_id, &sk))?;
    Ok(EnableResult {
        key_id,
        recovery_code,
    })
}

// [R24] 복구 — recovery code 로 S 를 되찾아 이 기계의 vault 에 재저장(re-wrap). device OS 키체인의 KEK 취득이
// 전제(S 를 KEK 로 다시 wrap). 복구된 S 가 등록 P 와 일치(basepoint)해야 한다 — 코드가 맞아도 P 불일치면
// 거부(무결성). 성공 시 그 scope 봉인 레코드가 이 기계에서 다시 복호 가능(다른 기계/OS 이관 경로).
#[tauri::command]
pub fn data_encrypt_recover(
    scope: String,
    recovery_code: String,
    state: State<'_, DbState>,
    secrets: State<'_, SecretsState>,
) -> Result<(), String> {
    if scope.is_empty() {
        return Err("scope 필요".to_string());
    }
    if !secrets.is_unlocked() {
        return Err(
            "KEK 취득 불가(no secret service) — 복구는 device 키체인 접근 필요(S 재저장에 KEK 필요)"
                .to_string(),
        );
    }
    let ak = with_conn(&state, |c| crypto::active_key(c, &scope))?
        .ok_or("암호화 비활성 scope — 복구 대상 아님")?;
    let blob_json = with_conn(&state, |c| crypto::active_recovery(c, &scope))?
        .ok_or("recovery blob 없음 — 이 키는 복구 코드 미발급")?;
    let blob: crate::secrets::RecoveryBlob =
        serde_json::from_str(&blob_json).map_err(|e| e.to_string())?;
    let s_vec = crate::secrets::recovery_unwrap(&recovery_code, &blob.salt, &blob.sealed)
        .map_err(|_| "복구 실패 — 잘못된 recovery code".to_string())?;
    if s_vec.len() != 32 {
        return Err("복구된 키 길이 오류".to_string());
    }
    let mut s = [0u8; 32];
    s.copy_from_slice(&s_vec);
    // 무결성 — 복구된 S 가 등록 P 와 일치해야(스왑·손상 거부).
    if crate::secrets::public_from_secret(&s) != ak.public_key {
        return Err("복구된 키가 등록 publicKey 와 불일치 — 거부".to_string());
    }
    // 현재 vault(새 passphrase)에 S 재저장 → 이제 KEK 로 열린다.
    secrets.put_data_key(&ak.key_id, &s)?;
    Ok(())
}

#[derive(Serialize)]
pub struct RotateResult {
    pub old_key_id: String,
    pub new_key_id: String,
    pub rekeyed: usize,
    pub old_disposed: bool, // old 키로 봉인된 잔여 0 이라 폐기됨(아니면 다음 회전/재개에서)
    pub recovery_code: String, // 새 키의 새 복구코드(1회 반환·앱 미저장) — 회전이 복구 blob 을 재발급해야 무손실
}

// 키 회전(R18/B9) — 새 키페어로 scope 전체를 re-key. old S 로 개봉→new P 로 재봉인. 잔여 0 확인 후에만
// old 키를 폐기한다(영구손실 0). unlock 필요(old 개봉). 중단 시 keyId=old 잔여만 다음 회전에서 이어받음.
#[tauri::command]
pub fn data_encrypt_rotate(
    scope: String,
    state: State<'_, DbState>,
    secrets: State<'_, SecretsState>,
) -> Result<RotateResult, String> {
    if scope.is_empty() {
        return Err("scope 필요".to_string());
    }
    if !secrets.is_unlocked() {
        return Err(
            "KEK 취득 불가(no secret service) — 회전은 device 키체인 접근 필요(old 키 개봉)".to_string(),
        );
    }
    let old = with_conn(&state, |c| crypto::active_key(c, &scope))?
        .ok_or("암호화 비활성 scope — 회전 대상 아님")?;
    let old_s = secrets
        .get_data_key(&old.key_id)?
        .ok_or("old 개인키 부재 — 회전 불가(무결성 이슈)")?;
    // 변조 검증 — old P==basepoint(old S). 스왑된 키로 회전하면 옛 레코드 개봉 실패 전손 위험.
    if crate::secrets::public_from_secret(&old_s) != old.public_key {
        return Err("old publicKey 가 vault 키와 불일치(스왑 의심) — 회전 거부".to_string());
    }
    // 새 키페어 → vault wrap → 등록(old retired, new active). 이후 새 put 은 new 로 봉인.
    let (new_s, new_p) = crate::secrets::gen_asym_keypair();
    let new_key_id = crypto::new_key_id();
    secrets.put_data_key(&new_key_id, &new_s)?;
    let created = super::now_millis();
    with_conn(&state, |c| {
        crypto::register_active_key(c, &scope, &new_key_id, &new_p, created)
    })?;
    // 새 active 키의 복구 blob 재발급 — 빠뜨리면 회전 후 active_recovery=None 이라 기계 분실 시 봉인 데이터
    // 영구 손실. re-key 루프 전에 발급해 new_s 가 살아있는 동안 처리. 새 코드 1회 반환(앱 미저장).
    let recovery_code =
        with_conn(&state, |c| crypto::issue_recovery(c, &scope, &new_key_id, &new_s))?;
    // 전 레코드 re-key(배치 반복).
    let mut rekeyed = 0usize;
    loop {
        let n = with_conn(&state, |c| {
            store::rekey_scope(c, &scope, &old.key_id, &old_s, &new_key_id, &new_p, 512)
        })?;
        rekeyed += n;
        if n == 0 {
            break;
        }
    }
    // 잔여 0(전 ns/coll) 확인 후에만 old 폐기(테이블 + vault). 잔여 있으면 다음 호출이 이어받음.
    let remaining = with_conn(&state, |c| {
        crypto::count_sealed_with_key(c, &scope, &old.key_id)
    })?;
    let old_disposed = remaining == 0;
    if old_disposed {
        with_conn(&state, |c| {
            crypto::dispose_retired_key(c, &scope, &old.key_id)
        })?;
        secrets.delete_data_key(&old.key_id)?;
    }
    Ok(RotateResult {
        old_key_id: old.key_id,
        new_key_id,
        rekeyed,
        old_disposed,
        recovery_code,
    })
}

// [R24] 복구코드 변경 — 데이터 재암호화 없이 active 키의 S 를 새 복구코드로 다시 감싼다(저렴). 코드 분실·노출
// 시. device OS 키체인의 KEK 취득이 전제(active S 를 vault 에서 꺼내 새 코드로 재-wrap). 새 코드 1회 반환·앱
// 미저장. rotate 와 달리 keyId·봉인 레코드는 그대로 — 복구 blob 만 새 코드로 교체.
#[tauri::command]
pub fn data_encrypt_change_recovery(
    scope: String,
    state: State<'_, DbState>,
    secrets: State<'_, SecretsState>,
) -> Result<String, String> {
    if scope.is_empty() {
        return Err("scope 필요".to_string());
    }
    if !secrets.is_unlocked() {
        return Err(
            "KEK 취득 불가(no secret service) — 복구코드 변경은 device 키체인 접근 필요(S 재-wrap)"
                .to_string(),
        );
    }
    let ak = with_conn(&state, |c| crypto::active_key(c, &scope))?
        .ok_or("암호화 비활성 scope — 복구코드 변경 대상 아님")?;
    let s = secrets
        .get_data_key(&ak.key_id)?
        .ok_or("active 개인키 부재 — 복구코드 변경 불가(무결성 이슈)")?;
    // 무결성 — vault 의 S 가 등록 P 와 일치(스왑 거부).
    if crate::secrets::public_from_secret(&s) != ak.public_key {
        return Err("active publicKey 가 vault 키와 불일치(스왑 의심) — 복구코드 변경 거부".to_string());
    }
    with_conn(&state, |c| crypto::issue_recovery(c, &scope, &ak.key_id, &s))
}

// 기존 평문 레코드 봉인 변환(R17) — 암호화 활성 후 이미 쌓인 (ns,coll,scope) 평문을 active key 로 봉인.
// 레코드별 단일 트랜잭션이라 크래시 재개 가능. 배치 반복으로 전부 변환, 반환=변환 수.
#[tauri::command]
pub fn data_encrypt_convert(
    ns: String,
    coll: String,
    scope: String,
    state: State<'_, DbState>,
) -> Result<usize, String> {
    validate_ns(&ns)?;
    let mut total = 0usize;
    loop {
        // 암호화 활성 scope 에선 새 put 이 이미 봉인(enc=1)이라 enc=0 은 줄기만 한다 → n==0 = 잔여 0.
        let n = with_conn(&state, |c| {
            store::convert_pending(c, &ns, &coll, &scope, 512)
        })?;
        total += n;
        if n == 0 {
            break;
        }
    }
    // convert 는 평문 doc 을 in-place 로 봉인 전환한다. secure_delete=ON 이 freed 셀을 0 채우지만,
    // 확실한 잔존 제거를 위해 실제 전환이 있었으면 full VACUUM(freelist 째 재기록) + WAL truncate 로
    // 전환 이전 평문이 파일-carve 로 복원되는 경로를 닫는다.
    if total > 0 {
        with_conn(&state, |c| {
            c.execute_batch("VACUUM; PRAGMA wal_checkpoint(TRUNCATE);")
                .map_err(|e| e.to_string())
        })?;
    }
    Ok(total)
}

// scope 암호화 상태 — enabled(트리거), keyId, algo, vault unlock 여부(복호 가능 조건).
#[tauri::command]
pub fn data_encrypt_status(
    scope: String,
    state: State<'_, DbState>,
    secrets: State<'_, SecretsState>,
) -> Result<EncryptionStatus, String> {
    let ak = with_conn(&state, |c| crypto::active_key(c, &scope))?;
    let unlocked = secrets.is_unlocked();
    // unlock 상태에서만 S 기반 판정. tampered=키스왑(blocker④), key_missing=S 부재(R23 footgun: vault
    // 리셋/삭제로 P 는 남고 S 가 사라진 상태 — 그 scope 의 봉인 레코드는 영구 복호 불가).
    let mut tampered = false;
    let mut key_missing = false;
    if let (Some(k), true) = (&ak, unlocked) {
        match secrets.get_data_key(&k.key_id)? {
            Some(s) => tampered = !with_conn(&state, |c| crypto::verify_active_key(c, &scope, &s))?,
            None => key_missing = true,
        }
    }
    Ok(EncryptionStatus {
        enabled: ak.is_some(),
        key_id: ak.as_ref().map(|k| k.key_id.clone()),
        algo: ak.as_ref().map(|_| crypto::ALGO_V1.to_string()),
        unlocked,
        tampered,
        key_missing,
    })
}

// ── 백업/복원/이식(코어 커맨드 — data.* 카탈로그 핸들러가 ns="core" 로 호출) ───────────

#[tauri::command]
pub fn data_backup(path: Option<String>, state: State<'_, DbState>) -> Result<String, String> {
    let dest = match path {
        Some(p) => std::path::PathBuf::from(p),
        None => crate::home::soksak_home()
            .join("backups")
            .join(format!("soksak-{}.db", super::now_millis())),
    };
    with_conn(&state, |c| backup::backup(c, &dest))?;
    Ok(dest.to_string_lossy().to_string())
}

// ns 회수 — 그 네임스페이스가 만든 모든 것을 지운다(레코드·kv·컬렉션 정의·FTS·인덱스). 만드는 길이
// 있으면 걷는 길도 있어야 한다: 이 표면이 없어 시험이 남의 저장소에 흔적을 남겼다. 남의 ns 는 안 건드린다.
#[tauri::command]
pub fn data_ns_remove(ns: String, state: State<'_, DbState>) -> Result<serde_json::Value, String> {
    // 삭제는 문법을 따지지 않는다. 만드는 길이 규칙을 어겨 앉힌 ns 를 걷지 못하면 그건 회수가 아니다
    // (실측: 검증 없는 import 가 남긴 ns 를 삭제 표면이 "잘못된 ns" 로 거부했다). 지우는 것은
    // 존재하는 것뿐이므로 문법 검증이 지킬 것이 없다.
    let out = with_conn(&state, |c| store::drop_ns(c, &ns))?;
    Ok(serde_json::json!({
        "ns": ns,
        "collections": out.collections,
        "records": out.records,
        "kv": out.kv,
    }))
}

// 저장소 자기 진단 — 전수 대조(integrity_check). 부팅 게이트(quick_check)는 인덱스↔테이블 대조를
// 하지 않아 인덱스 손상을 통과시킨다(integrity.rs 머리말). 읽기 전용.
#[tauri::command]
pub fn data_verify(state: State<'_, DbState>) -> Result<Vec<String>, String> {
    with_conn(&state, |c| super::integrity::check(c))
}

// 저장소 실황 — 앱 안의 SQLite 가 자기 한도·메모리·페이지 상태를 답한다(integrity.rs 머리말).
#[tauri::command]
pub fn data_stats(state: State<'_, DbState>) -> Result<super::integrity::Stats, String> {
    with_conn(&state, |c| super::integrity::stats(c))
}

// 저장소 치유 — 인덱스를 테이블에서 다시 만든다(REINDEX). 행은 만들지도 지우지도 않는다.
// 치유 후 다시 진단해 남은 문제를 그대로 싣는다(나았다고 주장만 하지 않는다).
#[tauri::command]
pub fn data_repair(state: State<'_, DbState>) -> Result<super::integrity::Repair, String> {
    with_conn(&state, |c| super::integrity::repair(c))
}

#[tauri::command]
pub fn data_restore(app: AppHandle, path: String, state: State<'_, DbState>) -> Result<(), String> {
    let src = std::path::PathBuf::from(&path);
    backup::validate(&src)?;
    let dbp = db_path()?;
    {
        let mut guard = state.conn.lock().map_err(|e| e.to_string())?;
        *guard = None; // 기존 커넥션 드롭(파일 잠금 해제) 후 스왑
        backup::restore_into(&dbp, &src)?;
        *guard = Some(super::open(&dbp)?);
    }
    emit_change(&app, "core", None, None, "restore", None);
    Ok(())
}

#[tauri::command]
pub fn data_export(
    ns: Option<String>,
    coll: Option<String>,
    state: State<'_, DbState>,
) -> Result<String, String> {
    with_conn(&state, |c| {
        backup::export(c, ns.as_deref(), coll.as_deref())
    })
}

#[tauri::command]
pub fn data_import(
    app: AppHandle,
    jsonl: String,
    state: State<'_, DbState>,
) -> Result<i64, String> {
    let n = with_conn(&state, |c| backup::import(c, &jsonl))?;
    emit_change(&app, "core", None, None, "import", None);
    Ok(n)
}

// ── 개명 데이터 이관(파괴적 플러그인 개명 후폭풍 방어) ────────────────────────
// ns = 호출 pluginId 라, 플러그인 id 개명은 옛 id 의 kv/records/meta_collections 를 새 id
// 에서 불가시하게 만든다 → 기존 사용자의 데이터(예: command_blocks) 전멸. 개명한 플러그인이
// 매니페스트에 이전 id 를 선언(renamedFrom)하면 코어 로더가 활성화 시 이 커맨드를 1회 부른다.
// 코어는 특정 id 를 모른다 — 선언된 from/to 만 옮긴다(C1: 코어에 특정 플러그인 이름 없음).
// 멱등: 새 ns 에 데이터가 있으면 이관하지 않는다(이미 이관됨 또는 새 플러그인 자기 데이터 —
// 이관 후 옛 ns 는 비어 다음 활성화가 source-empty 로 스킵). 옛 ns 가 비었으면 할 일 없음.
// 양쪽 다 데이터가 있으면 안전 병합 불가 → 명시 에러(무음 유실 금지). 세 테이블 원자 이동은
// store 가 소유(단위 테스트 가능). 코어는 선언된 from/to 만 옮긴다(C1: 특정 플러그인 이름 없음).
#[tauri::command]
pub fn data_migrate_ns(
    app: AppHandle,
    from_ns: String,
    to_ns: String,
    state: State<'_, DbState>,
) -> Result<store::NsMigrateOutcome, String> {
    validate_ns(&from_ns)?;
    validate_ns(&to_ns)?;
    if from_ns == to_ns {
        return Ok(store::NsMigrateOutcome {
            migrated: false,
            reason: "same-ns".into(),
        });
    }
    let outcome = with_conn(&state, |c| store::migrate_ns(c, &from_ns, &to_ns))?;
    if outcome.migrated {
        emit_change(&app, &to_ns, None, None, "ns-migrate", None);
    }
    Ok(outcome)
}

#[cfg(test)]
mod tests {
    use super::crypto;
    use crate::data::init_base;
    use crate::secrets::{FailingKekSource, SecretsState};
    use rusqlite::Connection;

    // (신규 test7) enable fail-closed — no-secret-service(KEK 취득 불가)면 안전핀 순서(S 를
    // put_data_key 로 먼저 → 성공해야 P 등록)가 자동 성립해 봉인 트리거(active P)가 등록되지 않는다.
    // data_encrypt_enable 은 Tauri State 경계라 커맨드 대신 그 순서를 재현 — 무음 평문·orphan 트리거 0.
    #[test]
    fn enable_fail_closed_without_secret_service() {
        let conn = Connection::open_in_memory().unwrap();
        init_base(&conn).unwrap();
        let dir = std::env::temp_dir().join(format!(
            "soksak-enable-fc-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let secrets = SecretsState::default();
        secrets.set_path(dir.join("secrets.vault"));
        secrets.set_kek_source(Box::new(FailingKekSource));

        let (sk, _pk) = crate::secrets::gen_asym_keypair();
        let key_id = crypto::new_key_id();
        // (1) S 를 vault 에 먼저 — KEK 취득 불가 → Err(여기서 중단, register 미도달).
        assert!(
            secrets.put_data_key(&key_id, &sk).is_err(),
            "KEK 없으면 S 저장 실패(loud)"
        );
        // (2) 안전핀 — 위가 Err 라 register_active_key 미도달 → active P 없음(봉인 트리거 0).
        assert!(
            crypto::active_key(&conn, "proj-a").unwrap().is_none(),
            "P 미등록 — orphan 봉인 트리거 0"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
