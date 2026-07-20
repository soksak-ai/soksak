// 데이터 저장 연산 — kv + 컬렉션. 전부 &Connection 을 받는 순수 함수(테스트는 임시 DB 주입).
// ns/scope 강제·필드 화이트리스트는 호출 시 인자로 들어온다(commands.rs 가 ns 를 주입).

use rusqlite::{Connection, OptionalExtension, ToSql};
use serde_json::{json, Value};

use super::{gen_id, now_millis, validate_coll, validate_field};

// ── KV ───────────────────────────────────────────────────────────────────────

pub fn kv_get(conn: &Connection, ns: &str, k: &str) -> Result<Option<Value>, String> {
    let row: Option<String> = conn
        .query_row("SELECT v FROM kv WHERE ns=?1 AND k=?2", (ns, k), |r| {
            r.get(0)
        })
        .optional()
        .map_err(|e| e.to_string())?;
    match row {
        Some(s) => Ok(Some(serde_json::from_str(&s).map_err(|e| e.to_string())?)),
        None => Ok(None),
    }
}

pub fn kv_set(conn: &Connection, ns: &str, k: &str, v: &Value) -> Result<(), String> {
    let s = serde_json::to_string(v).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO kv(ns,k,v,updated) VALUES(?1,?2,?3,?4)\
         ON CONFLICT(ns,k) DO UPDATE SET v=excluded.v, updated=excluded.updated",
        (ns, k, s, now_millis()),
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn kv_delete(conn: &Connection, ns: &str, k: &str) -> Result<bool, String> {
    let n = conn
        .execute("DELETE FROM kv WHERE ns=?1 AND k=?2", (ns, k))
        .map_err(|e| e.to_string())?;
    Ok(n > 0)
}

pub fn kv_keys(conn: &Connection, ns: &str, prefix: Option<&str>) -> Result<Vec<String>, String> {
    let pat = format!("{}%", prefix.unwrap_or(""));
    let mut stmt = conn
        .prepare("SELECT k FROM kv WHERE ns=?1 AND k LIKE ?2 ORDER BY k")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map((ns, pat), |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

// ── 컬렉션 메타 ────────────────────────────────────────────────────────────────

struct Meta {
    cid: i64,
    fts: Vec<String>,
    idx: Vec<String>,
}

fn get_meta(conn: &Connection, ns: &str, coll: &str) -> Result<Option<Meta>, String> {
    conn.query_row(
        "SELECT cid, idx_fields, fts_fields FROM meta_collections WHERE ns=?1 AND coll=?2",
        (ns, coll),
        |r| {
            let cid: i64 = r.get(0)?;
            let idx: String = r.get(1)?;
            let fts: String = r.get(2)?;
            Ok((cid, idx, fts))
        },
    )
    .optional()
    .map_err(|e| e.to_string())?
    .map(|(cid, idx, fts)| {
        Ok(Meta {
            cid,
            idx: serde_json::from_str(&idx).map_err(|e: serde_json::Error| e.to_string())?,
            fts: serde_json::from_str(&fts).map_err(|e: serde_json::Error| e.to_string())?,
        })
    })
    .transpose()
}

fn fts_table(cid: i64) -> String {
    format!("fts_{cid}")
}

// [M0] 부팅 FTS 정합 backstop — 과거 비원자 put(트랜잭션화 전) crash 로 생긴 orphan FTS 행(records 에 없는
// rowid)을 정리한다. put 트랜잭션화 이후 새 쓰기는 records+FTS 동시 커밋이라 정합 — 이건 레거시 잔재 청소.
// 누락(records 있는데 FTS 없음)은 search 가 약간 놓칠 뿐이라 전체 재구축(비쌈)은 안 한다. 멱등·저비용.
pub fn reconcile_fts(conn: &Connection) -> Result<(), String> {
    let mut stmt = conn
        .prepare("SELECT cid, ns, coll, fts_fields FROM meta_collections")
        .map_err(|e| e.to_string())?;
    let metas: Vec<(i64, String, String, String)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    for (cid, ns, coll, fts_json) in metas {
        let fts: Vec<String> = serde_json::from_str(&fts_json).unwrap_or_default();
        if fts.is_empty() {
            continue;
        }
        let tbl = fts_table(cid);
        conn.execute(
            &format!(
                "DELETE FROM {tbl} WHERE rowid NOT IN (SELECT rowid FROM records WHERE ns=?1 AND coll=?2)"
            ),
            (&ns, &coll),
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

// [단계①·R5] retention 공통 — rowid 집합을 records+FTS 동시 삭제(whole-record, mid-record 절단 금지).
// trim(count)/reap(TTL) 이 rowid 선택만 다르고 삭제 경로는 이 한 유틸을 공유(단일 진실). 호출부가 트랜잭션
// 소유(conn 은 그 tx 의 deref — half-evicted 방지). FTS 는 선언된 경우만.
fn delete_rowids(conn: &Connection, ns: &str, coll: &str, rowids: &[i64]) -> Result<(), String> {
    if rowids.is_empty() {
        return Ok(());
    }
    if let Some(meta) = get_meta(conn, ns, coll)? {
        if !meta.fts.is_empty() {
            let tbl = fts_table(meta.cid);
            for &rid in rowids {
                conn.execute(&format!("DELETE FROM {tbl} WHERE rowid=?1"), [rid])
                    .map_err(|e| e.to_string())?;
            }
        }
    }
    for &rid in rowids {
        conn.execute("DELETE FROM records WHERE rowid=?1", [rid])
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

// 셀렉트한 rowid 집합 → 단일 트랜잭션 삭제(공통 래퍼).
fn select_and_delete(
    conn: &Connection,
    ns: &str,
    coll: &str,
    sql: &str,
    params: impl rusqlite::Params,
) -> Result<usize, String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let rowids: Vec<i64> = {
        let mut stmt = tx.prepare(sql).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params, |r| r.get::<_, i64>(0))
            .map_err(|e| e.to_string())?;
        let mut v = Vec::new();
        for r in rows {
            v.push(r.map_err(|e| e.to_string())?);
        }
        v
    };
    delete_rowids(&tx, ns, coll, &rowids)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(rowids.len())
}

// [단계①·R5] retention count FIFO — (ns,coll,scope) 수가 cap 초과 시 oldest(created) 초과분 삭제. created
// 정렬(updated 금지: 변환 UPDATE 가 updated 를 바꾸면 축출 순서 비결정). insert 시점 호출(주기 sweep 아님).
// ns 통째 회수 — 그 네임스페이스가 만든 모든 것을 지운다(레코드·kv·컬렉션 정의·FTS 표·표현식 인덱스).
// 이 표면이 없어서 회수 3축의 데이터 축이 뚫려 있었다: 하니스·플러그인이 ns 를 만들 수는 있는데
// 걷을 수는 없어, 시험이 끝나도 남의 저장소에 흔적이 남았다(실측). 만드는 길이 있으면 걷는 길도 있어야 한다.
// 반환 = 지운 레코드·kv 행 수와 컬렉션 수. 없는 ns 는 실패가 아니라 0 이다(멱등).
pub struct NsRemoval {
    pub collections: usize,
    pub records: usize,
    pub kv: usize,
}

pub fn drop_ns(conn: &Connection, ns: &str) -> Result<NsRemoval, String> {
    let cids: Vec<i64> = {
        let mut stmt = conn
            .prepare("SELECT cid FROM meta_collections WHERE ns=?1")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([ns], |r| r.get::<_, i64>(0))
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?
    };
    let records = conn
        .execute("DELETE FROM records WHERE ns=?1", [ns])
        .map_err(|e| e.to_string())?;
    let kv = conn
        .execute("DELETE FROM kv WHERE ns=?1", [ns])
        .map_err(|e| e.to_string())?;
    for cid in &cids {
        // FTS 표는 그 컬렉션 전용이라 통째로 버린다. 표현식 인덱스는 records(공유 표)에 붙어 있으므로
        // 이름으로 찾아 떨어뜨린다 — 남기면 지운 컬렉션의 인덱스가 다른 ns 의 쓰기를 계속 무겁게 한다.
        conn.execute_batch(&format!("DROP TABLE IF EXISTS {};", fts_table(*cid)))
            .map_err(|e| e.to_string())?;
        let idx_names: Vec<String> = {
            let mut stmt = conn
                .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE ?1")
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([format!("idx_{cid}_%")], |r| r.get::<_, String>(0))
                .map_err(|e| e.to_string())?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?
        };
        for name in idx_names {
            conn.execute_batch(&format!("DROP INDEX IF EXISTS {name};"))
                .map_err(|e| e.to_string())?;
        }
    }
    conn.execute("DELETE FROM meta_collections WHERE ns=?1", [ns])
        .map_err(|e| e.to_string())?;
    Ok(NsRemoval {
        collections: cids.len(),
        records,
        kv,
    })
}

pub fn retention_trim(
    conn: &Connection,
    ns: &str,
    coll: &str,
    scope: &str,
    cap: i64,
) -> Result<usize, String> {
    select_and_delete(
        conn,
        ns,
        coll,
        "SELECT rowid FROM records WHERE ns=?1 AND coll=?2 AND scope=?3 \
         ORDER BY created ASC, rowid ASC \
         LIMIT MAX(0, (SELECT COUNT(*) FROM records WHERE ns=?1 AND coll=?2 AND scope=?3) - ?4)",
        (ns, coll, scope, cap),
    )
}

// [R5] free 페이지를 bounded 반환(physical reclaim) — logical delete(retention) 후 파일이 안 줄어드는
// 문제(#8835) 해소. auto_vacuum=INCREMENTAL 인 DB 에서만 효과(아니면 no-op). N 페이지만(부하 바운드,
// 전체 VACUUM 의 락·재기록 회피). reaper 직후 호출 — 트랜잭션 밖(PRAGMA 자체 처리).
pub fn incremental_vacuum(conn: &Connection, pages: i64) -> Result<(), String> {
    conn.execute_batch(&format!("PRAGMA incremental_vacuum({});", pages.max(0)))
        .map_err(|e| e.to_string())
}

// [단계①·R5] retention TTL reaper — created < cutoff_ms 인 레코드 일괄 삭제(시간축, trim 과 별개). 부팅/주기
// 호출. scope 무관(컬렉션 전체) — orphan(live scope 외) 판정은 commands 레벨이 live 목록으로 별도 수행.
pub fn retention_reap_ttl(
    conn: &Connection,
    ns: &str,
    coll: &str,
    cutoff_ms: i64,
) -> Result<usize, String> {
    select_and_delete(
        conn,
        ns,
        coll,
        "SELECT rowid FROM records WHERE ns=?1 AND coll=?2 AND created < ?3",
        (ns, coll, cutoff_ms),
    )
}

// define — 멱등. 메타 upsert + FTS 가상테이블 + 인덱스 필드별 표현식 인덱스 생성.
pub fn define(
    conn: &Connection,
    ns: &str,
    coll: &str,
    indexes: &[String],
    fts: &[String],
) -> Result<(), String> {
    validate_coll(coll)?;
    for f in indexes.iter().chain(fts.iter()) {
        validate_field(f)?;
    }
    let idx_json = serde_json::to_string(indexes).map_err(|e| e.to_string())?;
    let fts_json = serde_json::to_string(fts).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO meta_collections(ns,coll,idx_fields,fts_fields) VALUES(?1,?2,?3,?4)\
         ON CONFLICT(ns,coll) DO UPDATE SET idx_fields=excluded.idx_fields, fts_fields=excluded.fts_fields",
        (ns, coll, &idx_json, &fts_json),
    )
    .map_err(|e| e.to_string())?;
    let meta = get_meta(conn, ns, coll)?.ok_or("define 직후 메타 조회 실패")?;

    if !fts.is_empty() {
        // trigram = CJK 부분일치. content 기본(텍스트 사본 저장 → rowid 로 DELETE 가능, 갱신 안전).
        conn.execute_batch(&format!(
            "CREATE VIRTUAL TABLE IF NOT EXISTS {} USING fts5(text, tokenize = 'trigram');",
            fts_table(meta.cid)
        ))
        .map_err(|e| e.to_string())?;
    }
    // 표현식 인덱스 — query 의 json_extract 필터가 탄다. cid·필드명은 검증됨(주입 안전).
    for f in indexes {
        conn.execute_batch(&format!(
            "CREATE INDEX IF NOT EXISTS idx_{cid}_{f} ON records(ns, coll, json_extract(doc, '$.{f}'));",
            cid = meta.cid,
            f = f
        ))
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ── 레코드 ─────────────────────────────────────────────────────────────────────

// [M0] doc 코덱 seam — records 의 doc 직렬화/역직렬화를 이 한 쌍으로 모은다. 지금(단계①)은 평문 직렬화
// 항등. 단계②(암호화)가 scope 의 active key 로 여기에 seal(encode)/open(decode)을 끼운다 — 암호화가
// put/get/query/search 에 흩어지지 않고 한 지점만 탄다. enc=0=평문(현재 전부). kv/meta 는 코덱 대상 아님.
fn encode_doc(doc: &Value) -> Result<String, String> {
    serde_json::to_string(doc).map_err(|e| e.to_string())
}
fn decode_doc(s: &str) -> Result<Value, String> {
    serde_json::from_str(s).map_err(|e| e.to_string())
}

// [단계②] 봉인 레코드 개인키(S) 공급자 — keyId → Some(S) (없으면/lock 이면 None). 읽기 경로(get/query)가
// 받아서 enc=1 행을 개봉한다. commands 레벨이 vault(SecretsState)로 뒤를 댄다. None 이면 평문 전용.
pub type SkResolver<'a> = &'a dyn Fn(&str) -> Result<Option<[u8; 32]>, String>;

// 저장된 (doc_s, enc, keyId) → 평문 Value. enc=0 평문 항등. enc=1 이면 resolve_sk 로 S 얻어 개봉(R12).
// resolver 미제공이면 봉인 JSON 을 doc 인 양 반환하지 않고 정직하게 Err(R10 게이트, 은닉 오반환 금지).
fn decode_stored(
    ns: &str,
    coll: &str,
    scope: &str,
    id: &str,
    doc_s: &str,
    enc: i64,
    key_id: Option<&str>,
    resolve_sk: Option<SkResolver>,
) -> Result<Value, String> {
    if enc == 0 {
        return decode_doc(doc_s);
    }
    let key_id = key_id.ok_or("enc=1 인데 keyId 없음")?;
    let Some(resolve) = resolve_sk else {
        return Err("암호화 레코드 — 복호 경로 미배선(vault resolver 없음)".to_string());
    };
    let s = resolve(key_id)?.ok_or("vault locked 또는 키 없음 — 복호 불가")?;
    let stored = decode_doc(doc_s)?;
    let aad = super::crypto::canonical_aad(ns, coll, scope, id, key_id);
    super::crypto::open_doc(&stored, &s, &aad)
}

// FTS 텍스트 = 선언된 fts 필드의 문자열 값 연결(공백 구분).
fn fts_text(doc: &Value, fields: &[String]) -> String {
    let mut parts = Vec::new();
    for f in fields {
        if let Some(s) = doc.get(f).and_then(|v| v.as_str()) {
            parts.push(s.to_string());
        }
    }
    parts.join(" ")
}

// put — upsert(ON CONFLICT 로 rowid 보존). doc 에 canonical id 주입. FTS 동기화.
// 반환: 레코드 id.
pub fn put(
    conn: &Connection,
    ns: &str,
    coll: &str,
    scope: &str,
    id: Option<String>,
    doc: &Value,
) -> Result<String, String> {
    validate_coll(coll)?;
    let mut doc = doc.clone();
    if !doc.is_object() {
        return Err("doc 는 JSON 객체여야 함".to_string());
    }
    // [단계②] 예약 필드 거부 — 봉인 봉투 자리(__enc)와 충돌하면 후속 convert/회전이 그 레코드에서 실패한다.
    // 평문 시점에 막아 암호화 전환이 항상 안전하게(seal_doc 의 충돌 거부와 같은 불변).
    if doc
        .as_object()
        .unwrap()
        .contains_key(super::crypto::ENC_FIELD)
    {
        return Err(format!(
            "doc 가 예약 필드 {} 를 포함함",
            super::crypto::ENC_FIELD
        ));
    }
    let id = id.unwrap_or_else(gen_id);
    // canonical id 주입(doc.id = 레코드 id 항상 일치).
    doc.as_object_mut()
        .unwrap()
        .insert("id".to_string(), json!(id));
    let now = now_millis();
    // [M0] records 쓰기 + FTS 동기화를 단일 트랜잭션으로 묶는다 — 과거엔 INSERT records → DELETE fts →
    // INSERT fts 가 별도 autocommit 이라, 중간 크래시 시 records 는 있고 FTS 는 stale 인 찢긴 상태가 남았다
    // (search 오결과 + 변환 시 doc/마커 불일치). BEGIN IMMEDIATE 로 원자화해 records+FTS 동시 커밋한다.
    // unchecked_transaction: 단일 쓰기 커넥션(mod.rs Mutex 직렬화)이라 빌림 충돌 없음.
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let meta = get_meta(&tx, ns, coll)?;
    // [단계②] codec seam — fail-closed: scope 에 active key 있으면 봉인(공개키 P 만, vault 불요 →
    // lock 중에도 at-rest 쓰기). 인덱스 필드(meta.idx)는 평문 top-level 로 남겨 query 가 그대로 탄다
    // (blocker①). enc/keyId 컬럼에 표식. active key 없으면 평문 항등(현재 전부) — 회귀 0.
    let idx_fields = meta.as_ref().map(|m| m.idx.clone()).unwrap_or_default();
    let (doc_s, enc, key_id): (String, i64, Option<String>) =
        match super::crypto::active_key(&tx, scope)? {
            Some(ak) => {
                let aad = super::crypto::canonical_aad(ns, coll, scope, &id, &ak.key_id);
                let sealed =
                    super::crypto::seal_doc(&doc, &idx_fields, &ak.public_key, &ak.key_id, &aad)?;
                (encode_doc(&sealed)?, 1, Some(ak.key_id))
            }
            None => (encode_doc(&doc)?, 0, None),
        };
    tx.execute(
        "INSERT INTO records(ns,coll,scope,id,doc,created,updated,enc,keyId) VALUES(?1,?2,?3,?4,?5,?6,?6,?7,?8)\
         ON CONFLICT(ns,coll,id) DO UPDATE SET scope=excluded.scope, doc=excluded.doc, updated=excluded.updated, enc=excluded.enc, keyId=excluded.keyId",
        (ns, coll, scope, &id, &doc_s, now, enc, &key_id),
    )
    .map_err(|e| e.to_string())?;

    if let Some(meta) = &meta {
        sync_fts(&tx, meta, ns, coll, &id, &doc, enc, &idx_fields)?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(id)
}

// FTS 재동기화 — 한 행의 FTS 텍스트를 doc·enc 기준으로 교체(rowid). 봉인(enc=1)이면 평문 인덱스 필드만
// 색인(fts ∩ idx) — 봉인된 fts 필드를 평문 색인하면 자격증명이 FTS 테이블에 노출된다(R19). put·convert 공용.
fn sync_fts(
    tx: &Connection,
    meta: &Meta,
    ns: &str,
    coll: &str,
    id: &str,
    doc: &Value,
    enc: i64,
    idx_fields: &[String],
) -> Result<(), String> {
    if meta.fts.is_empty() {
        return Ok(());
    }
    let rowid: i64 = tx
        .query_row(
            "SELECT rowid FROM records WHERE ns=?1 AND coll=?2 AND id=?3",
            (ns, coll, id),
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let tbl = fts_table(meta.cid);
    tx.execute(&format!("DELETE FROM {tbl} WHERE rowid=?1"), [rowid])
        .map_err(|e| e.to_string())?;
    let fts_fields: Vec<String> = if enc == 1 {
        meta.fts
            .iter()
            .filter(|f| idx_fields.iter().any(|i| i == *f))
            .cloned()
            .collect()
    } else {
        meta.fts.clone()
    };
    let text = fts_text(doc, &fts_fields);
    if !text.is_empty() {
        tx.execute(
            &format!("INSERT INTO {tbl}(rowid, text) VALUES(?1, ?2)"),
            (rowid, text),
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

// [R17] scope 의 평문(enc=0) 레코드를 active key 로 봉인 변환. 레코드별 단일 트랜잭션 — 멱등(WHERE enc=0:
// 이미 봉인된 행은 0 rows, 이중봉인 불가, blocker②) + 동시 삭제와 무경합(삭제된 행은 UPDATE 0 rows, 부활
// 0, blocker③). created/updated 미변경(retention FIFO 순서 불변, R5). 크래시 시 enc=0/1 혼재로 남고
// 재호출이 이어받는다(records_pending 인덱스로 O(pending) 재개). batch 로 끊어 락 시간 바운드. 반환=변환 수.
// [R17 잔존] 봉인 변환 후 FTS 그림자테이블 잔존 제거 — sync_fts 의 DELETE 는 FTS5 에서 tombstone 이라
// 봉인된 fts 필드의 옛 트라이그램이 %_data 세그먼트에 살아남아 파일-carve 로 키 없이 복원된다(적대검증
// residual-carve). 'rebuild' 는 %_content(봉인 레코드 행은 DELETE 로 이미 제거됨)에서 인덱스를 재생성해
// tombstone 을 실제 purge 한다. 프리된 옛 세그먼트는 secure_delete=ON 으로 0 채워지고, 호출자 VACUUM 이
// 파일을 압축한다. fts 미선언 컬렉션은 no-op.
pub fn purge_fts_residual(conn: &Connection, ns: &str, coll: &str) -> Result<(), String> {
    let meta = match get_meta(conn, ns, coll)? {
        Some(m) if !m.fts.is_empty() => m,
        _ => return Ok(()),
    };
    let tbl = fts_table(meta.cid);
    conn.execute(&format!("INSERT INTO {tbl}({tbl}) VALUES('rebuild')"), [])
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn convert_pending(
    conn: &Connection,
    ns: &str,
    coll: &str,
    scope: &str,
    batch: i64,
) -> Result<usize, String> {
    let ak = match super::crypto::active_key(conn, scope)? {
        Some(k) => k,
        None => return Ok(0), // 트리거 없으면 변환 대상 아님
    };
    let meta = get_meta(conn, ns, coll)?;
    let idx_fields = meta.as_ref().map(|m| m.idx.clone()).unwrap_or_default();
    let ids: Vec<String> = {
        let mut stmt = conn
            .prepare(
                "SELECT id FROM records WHERE ns=?1 AND coll=?2 AND scope=?3 AND enc=0 \
                 ORDER BY created ASC, rowid ASC LIMIT ?4",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map((ns, coll, scope, batch.max(0)), |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        let mut v = Vec::new();
        for r in rows {
            v.push(r.map_err(|e| e.to_string())?);
        }
        v
    };
    let mut n = 0usize;
    for id in ids {
        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
        // tx 안에서 enc=0 재확인 — 멱등·경합 안전(이미 변환/삭제됐으면 None → skip).
        let doc_s: Option<String> = tx
            .query_row(
                "SELECT doc FROM records WHERE ns=?1 AND coll=?2 AND id=?3 AND enc=0",
                (ns, coll, &id),
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        let Some(doc_s) = doc_s else {
            tx.commit().map_err(|e| e.to_string())?;
            continue;
        };
        let doc = decode_doc(&doc_s)?;
        let aad = super::crypto::canonical_aad(ns, coll, scope, &id, &ak.key_id);
        let sealed = super::crypto::seal_doc(&doc, &idx_fields, &ak.public_key, &ak.key_id, &aad)?;
        let sealed_s = encode_doc(&sealed)?;
        // created/updated 손대지 않음(retention 순서 불변). WHERE enc=0 으로 멱등.
        let updated = tx
            .execute(
                "UPDATE records SET doc=?4, enc=1, keyId=?5 WHERE ns=?1 AND coll=?2 AND id=?3 AND enc=0",
                (ns, coll, &id, &sealed_s, &ak.key_id),
            )
            .map_err(|e| e.to_string())?;
        if updated == 1 {
            if let Some(m) = &meta {
                sync_fts(&tx, m, ns, coll, &id, &doc, 1, &idx_fields)?; // 봉인 후 FTS = fts ∩ idx
            }
            n += 1;
        }
        tx.commit().map_err(|e| e.to_string())?;
    }
    Ok(n)
}

// [R18/B9] 키 회전 re-key — scope 의 old_key_id 로 봉인된 enc=1 레코드를 new_key 로 재봉인(전 ns/coll).
// 레코드별 단일 트랜잭션: old S 로 개봉 → new P 로 재봉인 → UPDATE keyId WHERE keyId=old(멱등·이미 재키된
// 행 0 rows). 개봉 실패(변조/잘못된 S)면 그 레코드 건너뛰지 않고 Err 전파(은닉 손실 0). created/updated 불변.
// 부팅/중단 재개 = keyId=old 인 잔여만 다시 처리. dispose(old) 는 호출자가 잔여 0 확인 후.
#[allow(clippy::too_many_arguments)]
pub fn rekey_scope(
    conn: &Connection,
    scope: &str,
    old_key_id: &str,
    old_secret: &[u8; 32],
    new_key_id: &str,
    new_pk: &[u8; 32],
    batch: i64,
) -> Result<usize, String> {
    let targets: Vec<(String, String, String)> = {
        let mut stmt = conn
            .prepare(
                "SELECT ns, coll, id FROM records WHERE scope=?1 AND keyId=?2 AND enc=1 \
                 ORDER BY created ASC, rowid ASC LIMIT ?3",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map((scope, old_key_id, batch.max(0)), |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        let mut v = Vec::new();
        for r in rows {
            v.push(r.map_err(|e| e.to_string())?);
        }
        v
    };
    let mut n = 0usize;
    for (ns, coll, id) in targets {
        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
        // tx 안에서 keyId=old 재확인(멱등·경합 안전).
        let doc_s: Option<String> = tx
            .query_row(
                "SELECT doc FROM records WHERE ns=?1 AND coll=?2 AND id=?3 AND keyId=?4 AND enc=1",
                (&ns, &coll, &id, old_key_id),
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        let Some(doc_s) = doc_s else {
            tx.commit().map_err(|e| e.to_string())?;
            continue;
        };
        // 개봉(old S, old AAD) → 재봉인(new P, new AAD). 인덱스 평문 split 은 동일 메타.
        let stored = decode_doc(&doc_s)?;
        let aad_old = super::crypto::canonical_aad(&ns, &coll, scope, &id, old_key_id);
        let plain = super::crypto::open_doc(&stored, old_secret, &aad_old)?;
        let idx_fields = get_meta(&tx, &ns, &coll)?
            .map(|m| m.idx)
            .unwrap_or_default();
        let aad_new = super::crypto::canonical_aad(&ns, &coll, scope, &id, new_key_id);
        let resealed = super::crypto::seal_doc(&plain, &idx_fields, new_pk, new_key_id, &aad_new)?;
        let resealed_s = encode_doc(&resealed)?;
        let updated = tx
            .execute(
                "UPDATE records SET doc=?4, keyId=?5 WHERE ns=?1 AND coll=?2 AND id=?3 AND keyId=?6 AND enc=1",
                (&ns, &coll, &id, &resealed_s, new_key_id, old_key_id),
            )
            .map_err(|e| e.to_string())?;
        if updated == 1 {
            n += 1;
        }
        tx.commit().map_err(|e| e.to_string())?;
    }
    Ok(n)
}

pub fn get(
    conn: &Connection,
    ns: &str,
    coll: &str,
    id: &str,
    scope: Option<&str>,
    resolve_sk: Option<SkResolver>,
) -> Result<Option<Value>, String> {
    // scope 가 None 이면 행의 실제 scope 를 가져와 AAD 에 쓴다(봉인 컨텍스트는 저장 시 scope 로 묶임).
    let row: Option<(String, String, i64, Option<String>)> = match scope {
        Some(s) => conn
            .query_row(
                "SELECT doc, scope, enc, keyId FROM records WHERE ns=?1 AND coll=?2 AND id=?3 AND scope=?4",
                (ns, coll, id, s),
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .optional(),
        None => conn
            .query_row(
                "SELECT doc, scope, enc, keyId FROM records WHERE ns=?1 AND coll=?2 AND id=?3",
                (ns, coll, id),
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .optional(),
    }
    .map_err(|e| e.to_string())?;
    match row {
        Some((doc_s, row_scope, enc, key_id)) => Ok(Some(decode_stored(
            ns,
            coll,
            &row_scope,
            id,
            &doc_s,
            enc,
            key_id.as_deref(),
            resolve_sk,
        )?)),
        None => Ok(None),
    }
}

pub fn delete(
    conn: &Connection,
    ns: &str,
    coll: &str,
    id: &str,
    scope: Option<&str>,
) -> Result<bool, String> {
    // FTS 정리 위해 rowid·cid 선조회.
    let rowid: Option<i64> = conn
        .query_row(
            "SELECT rowid FROM records WHERE ns=?1 AND coll=?2 AND id=?3",
            (ns, coll, id),
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some(rowid) = rowid else { return Ok(false) };

    let n = match scope {
        Some(s) => conn.execute(
            "DELETE FROM records WHERE ns=?1 AND coll=?2 AND id=?3 AND scope=?4",
            (ns, coll, id, s),
        ),
        None => conn.execute(
            "DELETE FROM records WHERE ns=?1 AND coll=?2 AND id=?3",
            (ns, coll, id),
        ),
    }
    .map_err(|e| e.to_string())?;
    if n == 0 {
        return Ok(false);
    }
    if let Some(meta) = get_meta(conn, ns, coll)? {
        if !meta.fts.is_empty() {
            let tbl = fts_table(meta.cid);
            conn.execute(&format!("DELETE FROM {tbl} WHERE rowid=?1"), [rowid])
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(true)
}

// ── 질의(구조 필터 → 파라미터화 SQL) ──────────────────────────────────────────

// 비교값 1개를 바인딩 박스로. json_extract 는 bool→1/0, number, text 를 돌려주므로 동형으로 바인딩.
fn bind_val(v: &Value) -> Box<dyn ToSql> {
    match v {
        Value::Null => Box::new(rusqlite::types::Null),
        Value::Bool(b) => Box::new(if *b { 1i64 } else { 0i64 }),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                Box::new(i)
            } else {
                Box::new(n.as_f64().unwrap_or(0.0))
            }
        }
        Value::String(s) => Box::new(s.clone()),
        other => Box::new(other.to_string()),
    }
}

// 필드 → SQL 컬럼식. created/updated 는 실제 컬럼, 그 외는 json_extract. 필드는 검증·선언 확인됨.
// 내장 필드 = 레코드 컬럼 직행(선언 불요): id 는 PK, created/updated 는 타임스탬프 컬럼.
// 그 외는 json 필드 — 선언 인덱스가 있어야 조회·정렬 가능(전면 스캔 차단).
fn is_builtin_field(field: &str) -> bool {
    field == "id" || field == "created" || field == "updated"
}

fn field_expr(field: &str) -> String {
    if is_builtin_field(field) {
        field.to_string()
    } else {
        format!("json_extract(doc, '$.{field}')")
    }
}

// where 절 빌드. 허용 필드 = 선언 인덱스 ∪ {created,updated}. 값은 전부 ? 바인딩.
fn build_where(
    where_obj: Option<&Value>,
    allowed: &[String],
    params: &mut Vec<Box<dyn ToSql>>,
) -> Result<String, String> {
    let Some(Value::Object(map)) = where_obj else {
        return Ok(String::new());
    };
    let mut clauses = Vec::new();
    for (field, cond) in map {
        validate_field(field)?;
        if !is_builtin_field(field) && !allowed.iter().any(|a| a == field) {
            return Err(format!("필드가 인덱스로 선언되지 않음: {field}"));
        }
        let expr = field_expr(field);
        // {op, value} 형태 또는 스칼라(=eq).
        let (op, value) = match cond {
            Value::Object(o) if o.contains_key("op") => {
                let op = o.get("op").and_then(|v| v.as_str()).unwrap_or("eq");
                let value = o.get("value").unwrap_or(&Value::Null);
                (op.to_string(), value.clone())
            }
            other => ("eq".to_string(), other.clone()),
        };
        match op.as_str() {
            "eq" => {
                clauses.push(format!("{expr} = ?"));
                params.push(bind_val(&value));
            }
            "ne" => {
                clauses.push(format!("{expr} != ?"));
                params.push(bind_val(&value));
            }
            "lt" => {
                clauses.push(format!("{expr} < ?"));
                params.push(bind_val(&value));
            }
            "lte" => {
                clauses.push(format!("{expr} <= ?"));
                params.push(bind_val(&value));
            }
            "gt" => {
                clauses.push(format!("{expr} > ?"));
                params.push(bind_val(&value));
            }
            "gte" => {
                clauses.push(format!("{expr} >= ?"));
                params.push(bind_val(&value));
            }
            "like" => {
                clauses.push(format!("{expr} LIKE ?"));
                params.push(bind_val(&value));
            }
            "in" => {
                let Value::Array(arr) = &value else {
                    return Err("in 연산자 value 는 배열이어야 함".to_string());
                };
                if arr.is_empty() {
                    clauses.push("0".to_string()); // 빈 IN = 거짓
                } else {
                    let marks = vec!["?"; arr.len()].join(",");
                    clauses.push(format!("{expr} IN ({marks})"));
                    for v in arr {
                        params.push(bind_val(v));
                    }
                }
            }
            other => return Err(format!("알 수 없는 연산자: {other}")),
        }
    }
    if clauses.is_empty() {
        Ok(String::new())
    } else {
        Ok(format!(" AND {}", clauses.join(" AND ")))
    }
}

#[allow(clippy::too_many_arguments)]
#[allow(clippy::too_many_arguments)]
pub fn query(
    conn: &Connection,
    ns: &str,
    coll: &str,
    scope: Option<&str>,
    where_obj: Option<&Value>,
    order: Option<&str>,
    desc: bool,
    limit: Option<i64>,
    offset: Option<i64>,
    resolve_sk: Option<SkResolver>,
) -> Result<Vec<Value>, String> {
    let allowed = get_meta(conn, ns, coll)?.map(|m| m.idx).unwrap_or_default();

    let mut params: Vec<Box<dyn ToSql>> =
        vec![Box::new(ns.to_string()), Box::new(coll.to_string())];
    // 봉인 행 개봉에 scope·id·enc·keyId 가 필요 — doc 만이 아니라 함께 가져온다(blocker① 필터는 평문 인덱스).
    let mut sql =
        String::from("SELECT doc, scope, id, enc, keyId FROM records WHERE ns=?1 AND coll=?2");
    if let Some(s) = scope {
        sql.push_str(" AND scope=?3");
        params.push(Box::new(s.to_string()));
    }
    sql.push_str(&build_where(where_obj, &allowed, &mut params)?);

    // ORDER BY — created/updated 또는 선언 인덱스 필드. 기본 updated DESC.
    let order_field = order.unwrap_or("updated");
    validate_field(order_field)?;
    if !is_builtin_field(order_field) && !allowed.iter().any(|a| a == order_field) {
        return Err(format!("정렬 필드가 인덱스로 선언되지 않음: {order_field}"));
    }
    sql.push_str(&format!(
        " ORDER BY {} {}",
        field_expr(order_field),
        if desc { "DESC" } else { "ASC" }
    ));
    sql.push_str(&format!(" LIMIT {}", limit.unwrap_or(200).clamp(0, 5000)));
    if let Some(off) = offset {
        sql.push_str(&format!(" OFFSET {}", off.max(0)));
    }

    let refs: Vec<&dyn ToSql> = params.iter().map(|b| b.as_ref()).collect();
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(refs.as_slice(), |r| {
            Ok((
                r.get::<_, String>(0)?,         // doc
                r.get::<_, String>(1)?,         // scope
                r.get::<_, String>(2)?,         // id
                r.get::<_, i64>(3)?,            // enc
                r.get::<_, Option<String>>(4)?, // keyId
            ))
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        let (doc_s, row_scope, id, enc, key_id) = row.map_err(|e| e.to_string())?;
        out.push(decode_stored(
            ns,
            coll,
            &row_scope,
            &id,
            &doc_s,
            enc,
            key_id.as_deref(),
            resolve_sk,
        )?);
    }
    Ok(out)
}

pub fn count(
    conn: &Connection,
    ns: &str,
    coll: &str,
    scope: Option<&str>,
    where_obj: Option<&Value>,
) -> Result<i64, String> {
    let allowed = get_meta(conn, ns, coll)?.map(|m| m.idx).unwrap_or_default();
    let mut params: Vec<Box<dyn ToSql>> =
        vec![Box::new(ns.to_string()), Box::new(coll.to_string())];
    let mut sql = String::from("SELECT COUNT(*) FROM records WHERE ns=?1 AND coll=?2");
    if let Some(s) = scope {
        sql.push_str(" AND scope=?3");
        params.push(Box::new(s.to_string()));
    }
    sql.push_str(&build_where(where_obj, &allowed, &mut params)?);
    let refs: Vec<&dyn ToSql> = params.iter().map(|b| b.as_ref()).collect();
    conn.query_row(&sql, refs.as_slice(), |r| r.get::<_, i64>(0))
        .map_err(|e| e.to_string())
}

// search — CJK 전문검색. 쿼리 ≥3 코드포인트면 FTS5 trigram MATCH, 미만이면 LIKE 폴백(소량).
// 봉인 레코드는 봉인 필드가 FTS·doc 평문에 없으므로 매치되지 않지만(R19), 평문 인덱스로 매치된 enc=1 행은
// resolve_sk 로 개봉해 반환(없으면 게이트) — 읽기 경로 일관성(decode_stored 단일 지점).
pub fn search(
    conn: &Connection,
    ns: &str,
    coll: &str,
    query_text: &str,
    scope: Option<&str>,
    limit: Option<i64>,
    resolve_sk: Option<SkResolver>,
) -> Result<Vec<Value>, String> {
    let lim = limit.unwrap_or(50).clamp(0, 2000);
    let meta = get_meta(conn, ns, coll)?;
    let use_fts =
        meta.as_ref().is_some_and(|m| !m.fts.is_empty()) && query_text.chars().count() >= 3;

    if use_fts {
        let cid = meta.unwrap().cid;
        let tbl = fts_table(cid);
        // trigram 부분일치 — 따옴표 구문(내부 따옴표는 이중화).
        let m = format!("\"{}\"", query_text.replace('"', "\"\""));
        let mut params: Vec<Box<dyn ToSql>> = vec![
            Box::new(m),
            Box::new(ns.to_string()),
            Box::new(coll.to_string()),
        ];
        let mut sql = format!(
            "SELECT r.doc, r.scope, r.id, r.enc, r.keyId FROM {tbl} f JOIN records r ON r.rowid=f.rowid \
             WHERE f.text MATCH ?1 AND r.ns=?2 AND r.coll=?3"
        );
        if let Some(s) = scope {
            sql.push_str(" AND r.scope=?4");
            params.push(Box::new(s.to_string()));
        }
        sql.push_str(&format!(" ORDER BY r.updated DESC LIMIT {lim}"));
        let refs: Vec<&dyn ToSql> = params.iter().map(|b| b.as_ref()).collect();
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        search_collect(&mut stmt, refs.as_slice(), ns, coll, resolve_sk)
    } else {
        // 폴백 — doc 전체 LIKE(짧은 쿼리·FTS 미선언 컬렉션). scope 로 좁힘. 봉인 doc 은 암호문이라 평문 LIKE 와
        // 매치 안 됨(자격증명 누출 0) — 매치는 평문 인덱스/id 뿐.
        let like = format!("%{}%", query_text);
        let mut params: Vec<Box<dyn ToSql>> = vec![
            Box::new(ns.to_string()),
            Box::new(coll.to_string()),
            Box::new(like),
        ];
        let mut sql = String::from(
            "SELECT doc, scope, id, enc, keyId FROM records WHERE ns=?1 AND coll=?2 AND doc LIKE ?3",
        );
        if let Some(s) = scope {
            sql.push_str(" AND scope=?4");
            params.push(Box::new(s.to_string()));
        }
        sql.push_str(&format!(" ORDER BY updated DESC LIMIT {lim}"));
        let refs: Vec<&dyn ToSql> = params.iter().map(|b| b.as_ref()).collect();
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        search_collect(&mut stmt, refs.as_slice(), ns, coll, resolve_sk)
    }
}

// search 두 분기 공용 — (doc,scope,id,enc,keyId) 행을 decode_stored 로 디코드(봉인 행은 resolve_sk 로 개봉).
fn search_collect(
    stmt: &mut rusqlite::Statement,
    params: &[&dyn ToSql],
    ns: &str,
    coll: &str,
    resolve_sk: Option<SkResolver>,
) -> Result<Vec<Value>, String> {
    let rows = stmt
        .query_map(params, |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, i64>(3)?,
                r.get::<_, Option<String>>(4)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        let (doc_s, row_scope, id, enc, key_id) = row.map_err(|e| e.to_string())?;
        out.push(decode_stored(
            ns,
            coll,
            &row_scope,
            &id,
            &doc_s,
            enc,
            key_id.as_deref(),
            resolve_sk,
        )?);
    }
    Ok(out)
}

// ── 개명 데이터 ns 이관(파괴적 플러그인 개명 후폭풍 방어) ──────────────────────
// ns = pluginId 라 id 개명은 옛 id 의 kv/records/meta_collections 를 새 id 에서 불가시하게
// 만든다. 선언된 from→to 만 옮긴다(코어는 특정 플러그인 이름 불가지). 멱등·충돌 명시 에러.

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NsMigrateOutcome {
    pub migrated: bool,
    pub reason: String,
}

fn ns_has_data(c: &Connection, ns: &str) -> Result<bool, String> {
    let kv = c
        .prepare("SELECT 1 FROM kv WHERE ns=?1 LIMIT 1")
        .map_err(|e| e.to_string())?
        .exists([ns])
        .map_err(|e| e.to_string())?;
    let rec = c
        .prepare("SELECT 1 FROM records WHERE ns=?1 LIMIT 1")
        .map_err(|e| e.to_string())?
        .exists([ns])
        .map_err(|e| e.to_string())?;
    Ok(kv || rec)
}

/// 옛 ns 의 데이터를 새 ns 로 옮긴다(kv·records·meta_collections 원자 이동). 멱등:
/// 새 ns 에 데이터가 있으면 스킵(이미 이관됨/새 플러그인 자기 데이터), 옛 ns 가 비면 할 일 없음.
/// 양쪽 다 데이터가 있으면 병합 불가라 명시 에러(무음 유실 금지).
pub fn migrate_ns(c: &Connection, from: &str, to: &str) -> Result<NsMigrateOutcome, String> {
    if !ns_has_data(c, from)? {
        return Ok(NsMigrateOutcome {
            migrated: false,
            reason: "source-empty".into(),
        });
    }
    if ns_has_data(c, to)? {
        return Err(format!(
            "ns migration conflict: both {from:?} and {to:?} hold data — refusing to merge"
        ));
    }
    let tx = c.unchecked_transaction().map_err(|e| e.to_string())?;
    tx.execute("UPDATE kv SET ns=?2 WHERE ns=?1", (from, to))
        .map_err(|e| e.to_string())?;
    tx.execute("UPDATE records SET ns=?2 WHERE ns=?1", (from, to))
        .map_err(|e| e.to_string())?;
    tx.execute("UPDATE meta_collections SET ns=?2 WHERE ns=?1", (from, to))
        .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(NsMigrateOutcome {
        migrated: true,
        reason: "moved".into(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn mem() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        super::super::init_base(&conn).unwrap();
        conn
    }

    // ns 회수 — 만드는 길이 있으면 걷는 길도 있어야 한다. 이 표면이 없어서 시험이 남의 저장소에
    // 흔적을 남겼다(실측). 남의 ns 는 절대 건드리지 않는다는 것이 이 삭제의 유일한 안전장치다.
    #[test]
    fn drop_ns_reclaims_everything_that_ns_made_and_nothing_else() {
        let c = mem();
        define(
            &c,
            "plugin:probe",
            "t",
            &["issue".into()],
            &["title".into()],
        )
        .unwrap();
        put(
            &c,
            "plugin:probe",
            "t",
            "s",
            Some("x1".into()),
            &json!({"issue":"i-1","title":"probe"}),
        )
        .unwrap();
        kv_set(&c, "plugin:probe", "k", &json!({"a":1})).unwrap();

        define(&c, "plugin:keeper", "t", &["issue".into()], &[]).unwrap();
        put(
            &c,
            "plugin:keeper",
            "t",
            "s",
            Some("y1".into()),
            &json!({"issue":"i-2"}),
        )
        .unwrap();
        kv_set(&c, "plugin:keeper", "k", &json!({"b":2})).unwrap();

        let out = drop_ns(&c, "plugin:probe").unwrap();
        assert_eq!((out.collections, out.records, out.kv), (1, 1, 1));

        // 지운 ns 는 흔적이 없다 — 레코드·kv·컬렉션 정의·표현식 인덱스·FTS 표까지.
        assert!(query(
            &c,
            "plugin:probe",
            "t",
            Some("s"),
            None,
            None,
            false,
            None,
            None,
            None
        )
        .unwrap()
        .is_empty());
        assert!(kv_get(&c, "plugin:probe", "k").unwrap().is_none());
        let leftovers: i64 = c
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE name LIKE 'idx_%' AND sql LIKE '%issue%'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(leftovers, 1, "남은 issue 인덱스는 keeper 것 하나뿐이다");

        // 남의 ns 는 그대로다.
        assert_eq!(
            query(
                &c,
                "plugin:keeper",
                "t",
                Some("s"),
                None,
                None,
                false,
                None,
                None,
                None
            )
            .unwrap()
            .len(),
            1
        );
        assert!(kv_get(&c, "plugin:keeper", "k").unwrap().is_some());

        // 멱등 — 없는 ns 를 지우는 것은 실패가 아니다.
        let again = drop_ns(&c, "plugin:probe").unwrap();
        assert_eq!((again.collections, again.records, again.kv), (0, 0, 0));
    }

    // 파괴적 개명 후폭풍: ns=pluginId 라 개명하면 옛 이력이 새 id 에서 불가시하다. renamedFrom
    // 이관이 없으면 사용자 command_blocks 전멸. RED: 개명 후 새 ns 조회가 빔 → GREEN: 이관 후 재현.
    #[test]
    fn migrate_ns_moves_renamed_history_and_is_idempotent() {
        let c = mem();
        define(
            &c,
            "soksak-plugin-terminal",
            "command_blocks",
            &["viewId".into()],
            &[],
        )
        .unwrap();
        put(
            &c,
            "soksak-plugin-terminal",
            "command_blocks",
            "proj-a",
            Some("b1".into()),
            &json!({"viewId":"t1","commandLine":"echo hi"}),
        )
        .unwrap();
        // RED 경계 — 개명한 새 id 에선 옛 이력이 안 보인다.
        let before = query(
            &c,
            "soksak-plugin-terminal-xterm",
            "command_blocks",
            Some("proj-a"),
            None,
            None,
            false,
            None,
            None,
            None,
        )
        .unwrap();
        assert!(before.is_empty(), "개명 후 새 id 에서 옛 이력 불가시(재현)");
        // 이관.
        let out = migrate_ns(&c, "soksak-plugin-terminal", "soksak-plugin-terminal-xterm").unwrap();
        assert!(out.migrated);
        // GREEN — 새 ns 에서 보이고 옛 ns 는 비었다.
        let after = query(
            &c,
            "soksak-plugin-terminal-xterm",
            "command_blocks",
            Some("proj-a"),
            None,
            None,
            false,
            None,
            None,
            None,
        )
        .unwrap();
        assert_eq!(after.len(), 1);
        assert_eq!(
            after[0].get("commandLine").and_then(Value::as_str),
            Some("echo hi")
        );
        let old = query(
            &c,
            "soksak-plugin-terminal",
            "command_blocks",
            Some("proj-a"),
            None,
            None,
            false,
            None,
            None,
            None,
        )
        .unwrap();
        assert!(old.is_empty(), "옛 ns 는 이관 후 비어야 한다");
        // 멱등 — 재이관은 source-empty no-op(옛 ns 가 이미 비었다).
        let again =
            migrate_ns(&c, "soksak-plugin-terminal", "soksak-plugin-terminal-xterm").unwrap();
        assert!(!again.migrated);
        assert_eq!(again.reason, "source-empty");
    }

    // 양쪽 다 데이터가 있으면 안전 병합 불가 — 명시 에러(무음 유실 금지).
    #[test]
    fn migrate_ns_refuses_when_both_hold_data() {
        let c = mem();
        define(&c, "old-id", "c", &[], &[]).unwrap();
        put(&c, "old-id", "c", "s", None, &json!({"x":1})).unwrap();
        define(&c, "new-id", "c", &[], &[]).unwrap();
        put(&c, "new-id", "c", "s", None, &json!({"x":2})).unwrap();
        assert!(
            migrate_ns(&c, "old-id", "new-id").is_err(),
            "양쪽 데이터 → 명시 에러"
        );
    }

    // id 는 내장 필드(PK) — 인덱스 선언 없이 where/order 가능(콘텐츠 주소 조회의 정본 경로).
    #[test]
    fn id_is_builtin_for_where_and_order() {
        let c = mem();
        define(&c, "kanban", "prompts", &[], &[]).unwrap();
        put(
            &c,
            "kanban",
            "prompts",
            "app",
            Some("hash-a".into()),
            &json!({"value":"A"}),
        )
        .unwrap();
        put(
            &c,
            "kanban",
            "prompts",
            "app",
            Some("hash-b".into()),
            &json!({"value":"B"}),
        )
        .unwrap();
        let rows = query(
            &c,
            "kanban",
            "prompts",
            Some("app"),
            Some(&json!({"id": "hash-a"})),
            Some("id"),
            false,
            None,
            None,
            None,
        )
        .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].get("value").and_then(Value::as_str), Some("A"));
    }

    // [단계②] put 봉인 경로 — scope 에 active key 등록 후 put 하면 doc 컬럼이 봉인되고(enc=1),
    // 인덱스 필드는 평문 top-level 로 남아 query 가 그대로 탄다(blocker①). 봉인 doc 은 S 로 개봉 가능.
    #[test]
    fn put_seals_when_active_key_present() {
        use super::super::crypto;
        let c = mem();
        define(
            &c,
            "terminal",
            "command_blocks",
            &["viewId".into(), "startTs".into()],
            &["commandLine".into()],
        )
        .unwrap();
        // 평문 baseline — 키 없으면 평문(enc=0).
        let id0 = put(
            &c,
            "terminal",
            "command_blocks",
            "proj-a",
            None,
            &json!({"viewId":"t1","startTs":1,"output":"plain"}),
        )
        .unwrap();
        let (doc0, enc0): (String, i64) = c
            .query_row("SELECT doc, enc FROM records WHERE id=?1", [&id0], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!(enc0, 0, "키 없으면 평문");
        assert!(doc0.contains("plain"), "평문 레코드는 output 노출");
        assert_eq!(
            get(&c, "terminal", "command_blocks", &id0, None, None)
                .unwrap()
                .unwrap()["output"],
            "plain"
        );

        // active key 등록 → put 봉인.
        let (s, p) = crate::secrets::gen_asym_keypair();
        crypto::register_active_key(&c, "proj-a", "key-1", &p, 100).unwrap();
        let id1 = put(&c, "terminal", "command_blocks", "proj-a", None,
            &json!({"viewId":"t2","startTs":1718900000000i64,"commandLine":"export T=sk-XYZ","output":"secret echo"})).unwrap();

        // 저장 형태 검증: enc=1, keyId, 인덱스 평문, 민감 필드 비노출.
        let (doc1, enc1, kid): (String, i64, Option<String>) = c
            .query_row(
                "SELECT doc, enc, keyId FROM records WHERE id=?1",
                [&id1],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(enc1, 1, "active key 있으면 봉인");
        assert_eq!(kid.as_deref(), Some("key-1"));
        assert!(
            doc1.contains("\"viewId\":\"t2\""),
            "인덱스 viewId 평문 유지"
        );
        assert!(doc1.contains("1718900000000"), "인덱스 startTs 평문 유지");
        assert!(!doc1.contains("sk-XYZ"), "자격증명 평문 누출 0");
        assert!(!doc1.contains("secret echo"), "output 평문 누출 0");

        // blocker①: 봉인돼도 평문 인덱스 필터가 탄다(0 아님). count 는 디코드 없이 인덱스만 → R10 평문 프로젝션.
        let n = count(
            &c,
            "terminal",
            "command_blocks",
            Some("proj-a"),
            Some(&json!({"viewId":"t2"})),
        )
        .unwrap();
        assert_eq!(n, 1, "봉인 레코드도 평문 인덱스 필터로 1건(blocker①)");

        // 봉인 doc 을 S 로 개봉하면 원본 복원(쓰기 경로 정합).
        let stored: Value = serde_json::from_str(&doc1).unwrap();
        let aad = crypto::canonical_aad("terminal", "command_blocks", "proj-a", &id1, "key-1");
        let opened = crypto::open_doc(&stored, &s, &aad).unwrap();
        assert_eq!(opened["commandLine"], "export T=sk-XYZ");
        assert_eq!(opened["output"], "secret echo");
        assert_eq!(opened["viewId"], "t2");

        // get 은 복호 경로 미배선이라 정직하게 Err(은닉 오반환 금지).
        assert!(
            get(&c, "terminal", "command_blocks", &id1, None, None).is_err(),
            "복호 resolver 없으면 봉인 레코드 get 게이트"
        );

        // 예약 필드 __enc 를 담은 doc 은 put 거부(convert/회전 안전 불변).
        assert!(
            put(
                &c,
                "terminal",
                "command_blocks",
                "proj-a",
                None,
                &json!({"__enc": 1})
            )
            .is_err(),
            "예약 필드 __enc 거부"
        );
    }

    // [단계②] 읽기 경로 — resolver(S 공급)로 get/query 가 봉인 레코드를 개봉(R12). resolver 가 None(lock)이면
    // 게이트(Err). 평문 레코드는 resolver 무관 동작.
    #[test]
    fn get_query_open_with_resolver() {
        use super::super::crypto;
        let c = mem();
        define(&c, "terminal", "command_blocks", &["viewId".into()], &[]).unwrap();
        let (s, p) = crate::secrets::gen_asym_keypair();
        crypto::register_active_key(&c, "proj-a", "key-1", &p, 100).unwrap();
        let id = put(
            &c,
            "terminal",
            "command_blocks",
            "proj-a",
            None,
            &json!({"viewId":"t1","output":"secret echo","exitCode":0}),
        )
        .unwrap();

        // unlock 모의 — resolver 가 key-1 의 S 를 돌려준다.
        let unlocked = |kid: &str| -> Result<Option<[u8; 32]>, String> {
            if kid == "key-1" {
                Ok(Some(s))
            } else {
                Ok(None)
            }
        };
        // lock 모의 — resolver 가 항상 None(vault locked).
        let locked = |_kid: &str| -> Result<Option<[u8; 32]>, String> { Ok(None) };

        // get: unlock 이면 개봉(원본 복원), lock 이면 Err.
        let got = get(
            &c,
            "terminal",
            "command_blocks",
            &id,
            Some("proj-a"),
            Some(&unlocked),
        )
        .unwrap()
        .unwrap();
        assert_eq!(got["output"], "secret echo", "resolver 로 봉인 레코드 개봉");
        assert_eq!(got["viewId"], "t1");
        assert_eq!(got["exitCode"], 0);
        assert!(
            get(
                &c,
                "terminal",
                "command_blocks",
                &id,
                Some("proj-a"),
                Some(&locked)
            )
            .is_err(),
            "lock 이면 복호 불가 Err"
        );

        // query: unlock 이면 개봉된 doc 반환.
        let hits = query(
            &c,
            "terminal",
            "command_blocks",
            Some("proj-a"),
            None,
            None,
            true,
            None,
            None,
            Some(&unlocked),
        )
        .unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(
            hits[0]["output"], "secret echo",
            "query 도 resolver 로 개봉"
        );
        assert!(
            query(
                &c,
                "terminal",
                "command_blocks",
                Some("proj-a"),
                None,
                None,
                true,
                None,
                None,
                Some(&locked)
            )
            .is_err(),
            "lock query Err"
        );
    }

    // [단계②·R17] 변환 — 기존 평문(enc=0) 레코드를 active key 로 봉인. 멱등(재호출 no-op), 이중봉인 0,
    // created 보존(retention 순서 불변), 봉인 후 인덱스 query·S 개봉 가능, FTS 에서 봉인 필드 제거.
    #[test]
    fn convert_pending_seals_existing_plaintext() {
        use super::super::crypto;
        let c = mem();
        define(
            &c,
            "terminal",
            "command_blocks",
            &["viewId".into()],
            &["commandLine".into()],
        )
        .unwrap();
        // 평문 레코드 3개(키 없을 때 — enc=0).
        let mut ids = Vec::new();
        for i in 0..3 {
            ids.push(put(&c, "terminal", "command_blocks", "proj-a", None,
                &json!({"viewId":format!("t{i}"),"commandLine":format!("cmd{i} secret{i}"),"output":format!("out{i}")})).unwrap());
        }
        // created 기록(변환이 안 바꿔야).
        let created_before: Vec<i64> = ids
            .iter()
            .map(|id| {
                c.query_row("SELECT created FROM records WHERE id=?1", [id], |r| {
                    r.get(0)
                })
                .unwrap()
            })
            .collect();
        // FTS 가 commandLine 평문 색인 중 — search 로 확인.
        assert_eq!(
            search(
                &c,
                "terminal",
                "command_blocks",
                "secret1",
                None,
                None,
                None
            )
            .unwrap()
            .len(),
            1,
            "변환 전 FTS 검색 1건"
        );

        // 암호화 활성 후 변환.
        let (s, p) = crate::secrets::gen_asym_keypair();
        crypto::register_active_key(&c, "proj-a", "key-1", &p, 50).unwrap();
        let n = convert_pending(&c, "terminal", "command_blocks", "proj-a", 100).unwrap();
        assert_eq!(n, 3, "평문 3건 봉인 변환");

        // 멱등 — 재호출 0건(이미 enc=1, WHERE enc=0 → no-op, 이중봉인 0).
        assert_eq!(
            convert_pending(&c, "terminal", "command_blocks", "proj-a", 100).unwrap(),
            0,
            "재변환 no-op"
        );

        for (i, id) in ids.iter().enumerate() {
            let (enc, kid, doc_s, created): (i64, Option<String>, String, i64) = c
                .query_row(
                    "SELECT enc, keyId, doc, created FROM records WHERE id=?1",
                    [id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
                )
                .unwrap();
            assert_eq!(enc, 1, "변환 후 봉인");
            assert_eq!(kid.as_deref(), Some("key-1"));
            assert_eq!(
                created, created_before[i],
                "created 보존(retention 순서 불변)"
            );
            assert!(
                !doc_s.contains(&format!("secret{i}")),
                "commandLine 평문 누출 0"
            );
            assert!(!doc_s.contains(&format!("out{i}")), "output 평문 누출 0");
            // S 로 개봉 → 원본 복원.
            let stored: Value = serde_json::from_str(&doc_s).unwrap();
            let aad = crypto::canonical_aad("terminal", "command_blocks", "proj-a", id, "key-1");
            let opened = crypto::open_doc(&stored, &s, &aad).unwrap();
            assert_eq!(opened["commandLine"], format!("cmd{i} secret{i}"));
        }
        // 봉인 후 FTS 에서 commandLine(봉인 필드) 제거 — search 0건(자격증명 평문 노출 0, R19).
        assert_eq!(
            search(
                &c,
                "terminal",
                "command_blocks",
                "secret1",
                None,
                None,
                None
            )
            .unwrap()
            .len(),
            0,
            "봉인 후 FTS 검색 0건"
        );
        // 인덱스(viewId) query 는 여전히 탄다(blocker①).
        assert_eq!(
            count(
                &c,
                "terminal",
                "command_blocks",
                Some("proj-a"),
                Some(&json!({"viewId":"t1"}))
            )
            .unwrap(),
            1
        );
    }

    // [단계②·R18/B9] 키 회전 re-key — old 로 봉인된 레코드를 new 로 재봉인. 재키 후 new S 로 개봉 가능,
    // old S 로는 불가(전이 완료), keyId 갱신, 잔여 0 → dispose 안전. created 보존.
    #[test]
    fn rekey_scope_migrates_records() {
        use super::super::crypto;
        let c = mem();
        define(&c, "terminal", "command_blocks", &["viewId".into()], &[]).unwrap();
        let (s1, p1) = crate::secrets::gen_asym_keypair();
        crypto::register_active_key(&c, "proj-a", "key-1", &p1, 10).unwrap();
        let mut ids = Vec::new();
        for i in 0..3 {
            ids.push(
                put(
                    &c,
                    "terminal",
                    "command_blocks",
                    "proj-a",
                    None,
                    &json!({"viewId":format!("t{i}"),"output":format!("payload{i}")}),
                )
                .unwrap(),
            );
        }
        let created_before: Vec<i64> = ids
            .iter()
            .map(|id| {
                c.query_row("SELECT created FROM records WHERE id=?1", [id], |r| {
                    r.get(0)
                })
                .unwrap()
            })
            .collect();

        // 회전: 새 키 등록(old retired) → re-key.
        let (s2, p2) = crate::secrets::gen_asym_keypair();
        crypto::register_active_key(&c, "proj-a", "key-2", &p2, 20).unwrap();
        let n = rekey_scope(&c, "proj-a", "key-1", &s1, "key-2", &p2, 100).unwrap();
        assert_eq!(n, 3, "3건 재키");
        // 멱등 — 재호출 0(이미 key-2, WHERE keyId=old → no-op).
        assert_eq!(
            rekey_scope(&c, "proj-a", "key-1", &s1, "key-2", &p2, 100).unwrap(),
            0
        );
        // old 키로 봉인된 잔여 0 → dispose 안전.
        assert_eq!(
            crypto::count_sealed_with_key(&c, "proj-a", "key-1").unwrap(),
            0
        );

        for (i, id) in ids.iter().enumerate() {
            let (kid, doc_s, created): (Option<String>, String, i64) = c
                .query_row(
                    "SELECT keyId, doc, created FROM records WHERE id=?1",
                    [id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .unwrap();
            assert_eq!(kid.as_deref(), Some("key-2"), "keyId 가 new 로 갱신");
            assert_eq!(created, created_before[i], "created 보존");
            let stored: Value = serde_json::from_str(&doc_s).unwrap();
            // new S(s2)로 개봉 성공, old S(s1)로는 실패(전이 완료).
            let aad = crypto::canonical_aad("terminal", "command_blocks", "proj-a", id, "key-2");
            assert_eq!(
                crypto::open_doc(&stored, &s2, &aad).unwrap()["output"],
                format!("payload{i}")
            );
            assert!(
                crypto::open_doc(&stored, &s1, &aad).is_err(),
                "old S 로는 개봉 불가"
            );
        }
    }

    // [R5] incremental_vacuum — auto_vacuum=INCREMENTAL DB 에서 reap(logical delete) 후 free 페이지가
    // 실제 반환(physical reclaim)되는지. in-memory 는 파일 truncate 의미 없어 실파일 open() 경로로.
    #[test]
    fn incremental_vacuum_reclaims_pages() {
        let dir = std::env::temp_dir().join(format!(
            "soksak-vac-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("d.db");
        {
            let c = super::super::open(&path).unwrap(); // auto_vacuum=INCREMENTAL 적용(신규 DB)
            define(&c, "t", "c", &[], &[]).unwrap();
            for i in 0..300 {
                put(
                    &c,
                    "t",
                    "c",
                    "s",
                    None,
                    &json!({"pad": "y".repeat(500), "i": i}),
                )
                .unwrap();
            }
            retention_reap_ttl(&c, "t", "c", i64::MAX).unwrap(); // 전부 삭제(created < MAX)
            let free_before: i64 = c
                .query_row("PRAGMA freelist_count", [], |r| r.get(0))
                .unwrap();
            incremental_vacuum(&c, 100_000).unwrap();
            let free_after: i64 = c
                .query_row("PRAGMA freelist_count", [], |r| r.get(0))
                .unwrap();
            assert!(
                free_before > 0,
                "삭제 후 free 페이지 존재(auto_vacuum=INCREMENTAL)"
            );
            assert!(
                free_after < free_before,
                "incremental_vacuum 이 free 페이지 반환(physical reclaim)"
            );
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn kv_roundtrip() {
        let c = mem();
        assert_eq!(kv_get(&c, "mailbox", "x").unwrap(), None);
        kv_set(&c, "mailbox", "x", &json!({"a":1})).unwrap();
        assert_eq!(kv_get(&c, "mailbox", "x").unwrap(), Some(json!({"a":1})));
        // 네임스페이스 격리.
        assert_eq!(kv_get(&c, "other", "x").unwrap(), None);
        assert!(kv_delete(&c, "mailbox", "x").unwrap());
        assert_eq!(kv_get(&c, "mailbox", "x").unwrap(), None);
    }

    #[test]
    fn records_crud_and_scope() {
        let c = mem();
        define(
            &c,
            "mailbox",
            "messages",
            &["read".into(), "type".into()],
            &["title".into(), "body".into()],
        )
        .unwrap();
        let id1 = put(
            &c,
            "mailbox",
            "messages",
            "projA",
            None,
            &json!({"title":"빌드 완료","body":"성공","read":false,"type":"push"}),
        )
        .unwrap();
        let _id2 = put(
            &c,
            "mailbox",
            "messages",
            "projB",
            None,
            &json!({"title":"테스트","body":"중문 测试","read":true,"type":"info"}),
        )
        .unwrap();

        // get + canonical id 주입.
        let got = get(&c, "mailbox", "messages", &id1, Some("projA"), None)
            .unwrap()
            .unwrap();
        assert_eq!(got.get("id").unwrap().as_str().unwrap(), id1);
        assert_eq!(got.get("title").unwrap(), "빌드 완료");

        // scope 파티션 — projA 조회는 projB 안 섞임.
        let qa = query(
            &c,
            "mailbox",
            "messages",
            Some("projA"),
            None,
            None,
            true,
            None,
            None,
            None,
        )
        .unwrap();
        assert_eq!(qa.len(), 1);
        // where: read=false.
        let unread = query(
            &c,
            "mailbox",
            "messages",
            None,
            Some(&json!({"read":false})),
            None,
            true,
            None,
            None,
            None,
        )
        .unwrap();
        assert_eq!(unread.len(), 1);
        // count.
        assert_eq!(count(&c, "mailbox", "messages", None, None).unwrap(), 2);

        // 네임스페이스 격리 — 다른 ns 의 같은 컬렉션은 빈 결과.
        assert_eq!(count(&c, "other", "messages", None, None).unwrap(), 0);
    }

    // [단계①·R5] retention — cap 초과 시 oldest(created) 축출, 멱등, scope 격리.
    #[test]
    fn retention_trim_evicts_oldest_by_created() {
        let c = mem();
        define(&c, "terminal", "blocks", &["viewId".into()], &[]).unwrap();
        let mut ids = vec![];
        for i in 0..5 {
            ids.push(
                put(
                    &c,
                    "terminal",
                    "blocks",
                    "projA",
                    None,
                    &json!({"viewId":"v1","n":i}),
                )
                .unwrap(),
            );
        }
        assert_eq!(
            count(&c, "terminal", "blocks", Some("projA"), None).unwrap(),
            5
        );
        // cap=3 → oldest 2 축출.
        assert_eq!(
            retention_trim(&c, "terminal", "blocks", "projA", 3).unwrap(),
            2
        );
        assert_eq!(
            count(&c, "terminal", "blocks", Some("projA"), None).unwrap(),
            3
        );
        assert!(get(&c, "terminal", "blocks", &ids[0], Some("projA"), None)
            .unwrap()
            .is_none()); // oldest 삭제
        assert!(get(&c, "terminal", "blocks", &ids[4], Some("projA"), None)
            .unwrap()
            .is_some()); // newest 유지
                         // cap 미만 재호출 → 0(멱등).
        assert_eq!(
            retention_trim(&c, "terminal", "blocks", "projA", 3).unwrap(),
            0
        );
        // scope 격리 — projB 불변.
        put(
            &c,
            "terminal",
            "blocks",
            "projB",
            None,
            &json!({"viewId":"v2"}),
        )
        .unwrap();
        retention_trim(&c, "terminal", "blocks", "projA", 1).unwrap();
        assert_eq!(
            count(&c, "terminal", "blocks", Some("projB"), None).unwrap(),
            1
        );
    }

    // [단계①·R5] TTL reaper — created < cutoff 만 삭제, 신선분 유지. created 를 직접 써 시간 결정성 확보.
    #[test]
    fn retention_reap_ttl_drops_expired_only() {
        let c = mem();
        define(&c, "terminal", "blocks", &[], &[]).unwrap();
        // created 를 명시 주입(테스트 결정성): 오래된 3 + 신선 2.
        for (i, ts) in [(0, 1000_i64), (1, 1000), (2, 1500), (3, 5000), (4, 5000)] {
            let id = put(&c, "terminal", "blocks", "p", None, &json!({"n": i})).unwrap();
            c.execute("UPDATE records SET created=?1 WHERE id=?2", (ts, &id))
                .unwrap();
        }
        assert_eq!(count(&c, "terminal", "blocks", Some("p"), None).unwrap(), 5);
        // cutoff=2000 → created<2000(1000·1000·1500) 3개 삭제, 5000·5000 유지.
        assert_eq!(
            retention_reap_ttl(&c, "terminal", "blocks", 2000).unwrap(),
            3
        );
        assert_eq!(count(&c, "terminal", "blocks", Some("p"), None).unwrap(), 2);
        // 재호출 멱등(이미 정리) → 0.
        assert_eq!(
            retention_reap_ttl(&c, "terminal", "blocks", 2000).unwrap(),
            0
        );
    }

    #[test]
    fn cjk_trigram_search() {
        let c = mem();
        define(
            &c,
            "mailbox",
            "messages",
            &[],
            &["title".into(), "body".into()],
        )
        .unwrap();
        put(
            &c,
            "mailbox",
            "messages",
            "p",
            None,
            &json!({"title":"한글 테스트 메시지","body":"내용"}),
        )
        .unwrap();
        put(
            &c,
            "mailbox",
            "messages",
            "p",
            None,
            &json!({"title":"中文测试","body":"日本語テスト"}),
        )
        .unwrap();

        // 한글 부분일치(≥3).
        let r = search(&c, "mailbox", "messages", "테스트", None, None, None).unwrap();
        assert_eq!(r.len(), 1, "한글 trigram");
        // 중문.
        let r2 = search(&c, "mailbox", "messages", "测试", None, None, None).unwrap();
        assert_eq!(r2.len(), 1, "중문 — 2자라 LIKE 폴백");
        // 일본어 부분.
        let r3 = search(&c, "mailbox", "messages", "本語テ", None, None, None).unwrap();
        assert_eq!(r3.len(), 1, "일본어 trigram");
        // 없음.
        let r4 = search(&c, "mailbox", "messages", "존재안함", None, None, None).unwrap();
        assert_eq!(r4.len(), 0);
    }

    #[test]
    fn update_and_delete_sync_fts() {
        let c = mem();
        define(&c, "mailbox", "messages", &[], &["title".into()]).unwrap();
        let id = put(
            &c,
            "mailbox",
            "messages",
            "p",
            None,
            &json!({"title":"옛제목입니다"}),
        )
        .unwrap();
        assert_eq!(
            search(&c, "mailbox", "messages", "옛제목", None, None, None)
                .unwrap()
                .len(),
            1
        );
        // 갱신 → 옛 텍스트는 더이상 검색 안 됨.
        put(
            &c,
            "mailbox",
            "messages",
            "p",
            Some(id.clone()),
            &json!({"title":"새제목입니다"}),
        )
        .unwrap();
        assert_eq!(
            search(&c, "mailbox", "messages", "옛제목", None, None, None)
                .unwrap()
                .len(),
            0
        );
        assert_eq!(
            search(&c, "mailbox", "messages", "새제목", None, None, None)
                .unwrap()
                .len(),
            1
        );
        // 삭제 → FTS 도 정리.
        assert!(delete(&c, "mailbox", "messages", &id, None).unwrap());
        assert_eq!(
            search(&c, "mailbox", "messages", "새제목", None, None, None)
                .unwrap()
                .len(),
            0
        );
    }

    #[test]
    fn where_builder_rejects_undeclared_and_unknown_op() {
        let c = mem();
        define(&c, "mailbox", "messages", &["read".into()], &[]).unwrap();
        put(
            &c,
            "mailbox",
            "messages",
            "p",
            None,
            &json!({"read":false,"secret":"x"}),
        )
        .unwrap();
        // 선언 안 된 필드 거부.
        assert!(query(
            &c,
            "mailbox",
            "messages",
            None,
            Some(&json!({"secret":"x"})),
            None,
            true,
            None,
            None,
            None
        )
        .is_err());
        // 알 수 없는 연산자 거부.
        assert!(query(
            &c,
            "mailbox",
            "messages",
            None,
            Some(&json!({"read":{"op":"xx","value":1}})),
            None,
            true,
            None,
            None,
            None
        )
        .is_err());
        // injection 문자열은 리터럴(매칭 0, 에러 아님).
        let r = query(
            &c,
            "mailbox",
            "messages",
            None,
            Some(&json!({"read":"false' OR '1'='1"})),
            None,
            true,
            None,
            None,
            None,
        )
        .unwrap();
        assert_eq!(r.len(), 0);
    }

    #[test]
    fn define_idempotent() {
        let c = mem();
        define(
            &c,
            "mailbox",
            "messages",
            &["read".into()],
            &["title".into()],
        )
        .unwrap();
        // 재호출 — 에러 없이 통과(CREATE ... IF NOT EXISTS).
        define(
            &c,
            "mailbox",
            "messages",
            &["read".into(), "type".into()],
            &["title".into()],
        )
        .unwrap();
        put(
            &c,
            "mailbox",
            "messages",
            "p",
            None,
            &json!({"read":true,"type":"x","title":"제목제목"}),
        )
        .unwrap();
        assert_eq!(
            search(&c, "mailbox", "messages", "제목제목", None, None, None)
                .unwrap()
                .len(),
            1
        );
    }
}
