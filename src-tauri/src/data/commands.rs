// app.data 의 Tauri 커맨드 표면. 프론트 app.data.* → invoke → 여기. ns 는 호출 측(api.ts)이
// pluginId 로 주입하고 여기서 재검증한다. 변경 커맨드는 app.emit("data-change") 로 전 창 브로드캐스트
// → 프론트 app.data.watch 가 재질의(멀티윈도우·같은 프로젝트 일관, 폴링 0).

use rusqlite::Connection;
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, State};

use super::{backup, db_path, store, validate_ns, DbState};

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
) -> Result<Option<Value>, String> {
    validate_ns(&ns)?;
    with_conn(&state, |c| store::get(c, &ns, &coll, &id, scope.as_deref()))
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
) -> Result<Vec<Value>, String> {
    validate_ns(&ns)?;
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
) -> Result<Vec<Value>, String> {
    validate_ns(&ns)?;
    with_conn(&state, |c| {
        store::search(c, &ns, &coll, &query, scope.as_deref(), limit)
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
