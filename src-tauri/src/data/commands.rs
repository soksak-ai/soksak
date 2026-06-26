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
pub fn data_kv_get(ns: String, key: String, state: State<'_, DbState>) -> Result<Option<Value>, String> {
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
    emit_change(&app, &ns, Some(coll.as_str()), Some(scope_s.as_str()), "put", Some(new_id.as_str()));
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
    with_conn(&state, |c| store::get(c, &ns, &coll, &id, scope.as_deref(), Some(&resolver)))
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
    let removed = with_conn(&state, |c| store::delete(c, &ns, &coll, &id, scope.as_deref()))?;
    if removed {
        emit_change(&app, &ns, Some(coll.as_str()), scope.as_deref(), "delete", Some(id.as_str()));
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
        store::search(c, &ns, &coll, &query, scope.as_deref(), limit, Some(&resolver))
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
    with_conn(&state, |c| store::retention_trim(c, &ns, &coll, &scope, cap))
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
    with_conn(&state, |c| store::retention_reap_ttl(c, &ns, &coll, cutoff_ms))
}

// ── 암호화(단계② — scope 단위 봉투 키 라이프사이클, R0 command registry) ─────────────

use super::crypto;

#[derive(Serialize)]
pub struct EncryptionStatus {
    pub enabled: bool,        // scope 에 active key 존재(= 봉인 트리거 ON)
    pub key_id: Option<String>,
    pub algo: Option<String>,
    pub unlocked: bool,       // vault(개인키 S) 해제 여부 — 복호 가능 조건
    pub tampered: bool,       // [blocker④] publicKey 가 vault S 와 불일치(키스왑 탐지). unlock 상태에서만 판정.
}

// scope 암호화 활성 — X25519 키페어 생성, 개인키 S 를 vault 에 wrap(먼저), 공개키 P 를 테이블에 등록.
// 순서가 안전핀이다: S 를 vault 에 넣은 뒤에만 P 를 등록한다 — P(=봉인 트리거)만 있고 S 가 없으면 이후
// 모든 put 이 봉인되는데 영원히 복호 불가(전손)다. vault 잠김이면 put_data_key 가 Err → P 미등록(무해).
#[tauri::command]
pub fn data_encryption_enable(
    scope: String,
    state: State<'_, DbState>,
    secrets: State<'_, SecretsState>,
) -> Result<String, String> {
    if scope.is_empty() {
        return Err("scope 필요".to_string());
    }
    // 이미 active key 있으면 재활성 거부(중복 트리거·키 혼선 방지 — 회전은 별도 커맨드).
    if with_conn(&state, |c| crypto::active_key(c, &scope))?.is_some() {
        return Err(format!("scope {scope} 는 이미 암호화 활성(회전은 rotate 커맨드)"));
    }
    let (sk, pk) = crate::secrets::gen_asym_keypair();
    let key_id = crypto::new_key_id();
    // (1) S 를 vault 에 먼저 — 잠김이면 여기서 Err(P 미등록, 전손 0).
    secrets.put_data_key(&key_id, &sk)?;
    // (2) P 를 테이블에 등록(봉인 트리거 ON). 실패해도 vault 의 S 는 orphan(무해 — 트리거 없음).
    let created = super::now_millis();
    with_conn(&state, |c| crypto::register_active_key(c, &scope, &key_id, &pk, created))?;
    Ok(key_id)
}

// 기존 평문 레코드 봉인 변환(R17) — 암호화 활성 후 이미 쌓인 (ns,coll,scope) 평문을 active key 로 봉인.
// 레코드별 단일 트랜잭션이라 크래시 재개 가능. 배치 반복으로 전부 변환, 반환=변환 수.
#[tauri::command]
pub fn data_encryption_convert(
    ns: String,
    coll: String,
    scope: String,
    state: State<'_, DbState>,
) -> Result<usize, String> {
    validate_ns(&ns)?;
    let mut total = 0usize;
    loop {
        // 암호화 활성 scope 에선 새 put 이 이미 봉인(enc=1)이라 enc=0 은 줄기만 한다 → n==0 = 잔여 0.
        let n = with_conn(&state, |c| store::convert_pending(c, &ns, &coll, &scope, 512))?;
        total += n;
        if n == 0 {
            break;
        }
    }
    Ok(total)
}

// scope 암호화 상태 — enabled(트리거), keyId, algo, vault unlock 여부(복호 가능 조건).
#[tauri::command]
pub fn data_encryption_status(
    scope: String,
    state: State<'_, DbState>,
    secrets: State<'_, SecretsState>,
) -> Result<EncryptionStatus, String> {
    let ak = with_conn(&state, |c| crypto::active_key(c, &scope))?;
    let unlocked = secrets.is_unlocked();
    // [blocker④] unlock 상태에서만 키스왑 판정 가능(S 필요). lock 이면 tampered=false(미판정).
    let tampered = match (&ak, unlocked) {
        (Some(k), true) => match secrets.get_data_key(&k.key_id)? {
            Some(s) => !with_conn(&state, |c| crypto::verify_active_key(c, &scope, &s))?,
            None => false, // S 부재(키 미보관) — 별도 무결성 이슈지만 스왑 판정은 보류
        },
        _ => false,
    };
    Ok(EncryptionStatus {
        enabled: ak.is_some(),
        key_id: ak.as_ref().map(|k| k.key_id.clone()),
        algo: ak.as_ref().map(|_| crypto::ALGO_V1.to_string()),
        unlocked,
        tampered,
    })
}

// ── 백업/복원/이식(코어 커맨드 — data.* 카탈로그 핸들러가 ns="core" 로 호출) ───────────

#[tauri::command]
pub fn data_backup(path: Option<String>, state: State<'_, DbState>) -> Result<String, String> {
    let dest = match path {
        Some(p) => std::path::PathBuf::from(p),
        None => {
            let home = std::env::var("HOME").map_err(|e| format!("HOME 없음: {e}"))?;
            std::path::PathBuf::from(home)
                .join(".soksak")
                .join("backups")
                .join(format!("soksak-{}.db", super::now_millis()))
        }
    };
    with_conn(&state, |c| backup::backup(c, &dest))?;
    Ok(dest.to_string_lossy().to_string())
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
    with_conn(&state, |c| backup::export(c, ns.as_deref(), coll.as_deref()))
}

#[tauri::command]
pub fn data_import(app: AppHandle, jsonl: String, state: State<'_, DbState>) -> Result<i64, String> {
    let n = with_conn(&state, |c| backup::import(c, &jsonl))?;
    emit_change(&app, "core", None, None, "import", None);
    Ok(n)
}
