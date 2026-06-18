# soksak 플러그인 DB 메뉴얼 — `app.data`

플러그인이 데이터를 영속화하는 **유일한** 정공법은 코어의 `app.data` capability 다.
이 문서는 그 사용법·계약·금기의 단일 기준이다. 검증 출처:
`src/plugins/api.ts`(플러그인 표면)·`src-tauri/src/data/store.rs`(실제 의미론)·
`src-tauri/src/data/commands.rs`(ns 주입·전 창 브로드캐스트).

---

## 0. 철칙 (왜 이 문서가 있나)

- **raw SQL·쿼리문을 직접 작성하거나 노출하지 않는다.** `app.data` 는 DB-agnostic —
  플러그인 코드에 `SELECT`/`INSERT`/`prepare`/테이블명/컬럼명이 **단 한 글자도** 없어야 한다.
- **컬럼 순서·인덱스에 의존하지 않는다.** 레코드는 JSON 문서다. 필드는 이름으로만 다룬다.
  (CommandBar 레거시의 `SELECT *` + 컬럼 인덱스 0~29 하드코딩이 정확히 금지 대상이다.)
- **격리는 코어가 강제한다.** 네임스페이스(ns)는 항상 호출 플러그인 id 로 코어가 주입한다 —
  다른 플러그인 데이터에 접근하는 것은 구조적으로 불가능하다.
- **기준 미달이면 코드를 고친다.** 이 계약(선언 필드만 질의, 주입 안전)은 약화 대상이 아니다.

---

## 1. 권한

`plugin.json` 의 `permissions` 에 `"data"` 를 선언해야 한다.
미선언이면 `app.data` 는 **`undefined`** 다(권한 = API 표면 게이트).

```json
{ "permissions": ["data"] }
```

동의 화면 고지: "공용 임베디드 DB(SQLite)의 이 플러그인 전용 네임스페이스에 레코드를
저장·검색합니다(CJK 전문검색 포함). 다른 플러그인 데이터에는 접근하지 못합니다."

---

## 2. 두 저장 모델

| 모델 | 용도 | 표면 |
|---|---|---|
| **kv** | 설정·소량 상태(즐겨찾기 토글, 마지막 페이지 등) | `app.data.kv.*` |
| **컬렉션(collection)** | 구조화 레코드(질의·검색·정렬·페이지네이션) | `app.data.define/put/get/query/search/count/delete/watch` |

레코드가 "목록·검색·필터"의 대상이면 컬렉션, 단일 값이면 kv.

---

## 3. kv — 단순 키-값

```js
await app.data.kv.set("ui.pageSize", 50);        // JSON 직렬화 저장
const v = await app.data.kv.get("ui.pageSize");  // 없으면 null
await app.data.kv.delete("ui.pageSize");          // 있었으면 true
const keys = await app.data.kv.keys("ui.");       // prefix 필터(생략=전체), 정렬됨
```

- 값은 임의 JSON. ns 격리(다른 플러그인 kv 안 보임).

---

## 4. 컬렉션 — `define` (먼저, 멱등)

레코드를 쓰기 전에 컬렉션을 선언한다. `activate(ctx)` 에서 **1회**, 멱등이라 재호출 안전.

```js
await app.data.define("commands", {
  indexes: ["groupId", "favorite", "type", "createdAt"], // 질의·정렬 가능 필드
  fts:     ["label", "command"],                          // CJK 전문검색 필드
});
```

- **`indexes`** = `query`/`count` 의 `where` 와 `order` 에 **쓸 수 있는 필드의 화이트리스트**.
  선언하지 않은 필드로 `where`/`order` 하면 **거부**된다(`store.rs` `build_where`).
  (코어가 `json_extract` 표현식 인덱스를 만든다 — 빠르고 주입 안전.)
- **`fts`** = `search` 의 trigram 전문검색 대상 필드(여러 개면 공백 연결).
- 내장 필드 **`created`·`updated`**(저장 시각, ms)는 선언 없이도 항상 `where`/`order` 가능.
- 스키마 변경(인덱스 추가)은 `define` 을 다시 호출하면 된다(멱등 upsert).

---

## 5. `put` — upsert(생성·갱신 동일 경로)

```js
// 생성 — id 미지정 → 코어가 생성해 반환. doc 에 canonical id 가 주입된다.
const id = await app.data.put("commands", { label: "배포", command: "make deploy", type: "script" }, { scope });

// 갱신 — 같은 id 로 다시 put(전체 교체). rowid·FTS 자동 동기화.
await app.data.put("commands", { label: "배포", command: "make deploy", type: "script", favorite: true }, { scope, id });
```

- 반환 = 레코드 id. 저장된 doc 의 `id` 필드는 항상 레코드 id 와 일치(코어가 주입).
- `put` 은 **전체 문서 교체**다(부분 패치 아님) — 갱신 시 기존 필드를 모두 포함시켜라.
- `scope` = 파티션 키(§11). 생략 가능하지만 프로젝트별 데이터면 항상 지정.

---

## 6. `get` / `delete`

```js
const doc = await app.data.get("commands", id, { scope });   // 없으면 null
const removed = await app.data.delete("commands", id, { scope }); // 있었으면 true(FTS도 정리)
```

---

## 7. `query` — 구조 질의 (정공법, raw SQL 대체)

```js
const rows = await app.data.query("commands", {
  scope,
  where: { groupId: "g1", favorite: true },        // 스칼라 = 같음(eq)
  order: "createdAt",                               // 선언 인덱스 또는 created/updated
  desc:  true,
  limit: 50,                                        // 기본 200, 최대 5000
  offset: 0,
});
```

**`where` 연산자** (스칼라는 `eq` 약식, 명시형은 `{ op, value }`):

| op | 의미 | 예 |
|---|---|---|
| `eq` | 같음(기본) | `{ favorite: true }` 또는 `{ favorite: { op: "eq", value: true } }` |
| `ne` | 다름 | `{ type: { op: "ne", value: "schedule" } }` |
| `lt`·`lte`·`gt`·`gte` | 대소 | `{ createdAt: { op: "gte", value: 1700000000000 } }` |
| `like` | SQL LIKE 패턴 | `{ label: { op: "like", value: "배포%" } }` |
| `in` | 목록 포함 | `{ type: { op: "in", value: ["script", "api"] } }` |

규칙:
- `where`/`order` 필드는 **`indexes` 선언 또는 `created`/`updated`** 여야 한다(아니면 에러).
- 값은 전부 파라미터 바인딩 — **주입 안전**(예: `"x' OR '1'='1"` 은 리터럴로 취급, 매칭 0).
- 기본 정렬 = `updated DESC`. 페이지네이션은 `limit`+`offset`.

> 부분일치 텍스트 검색은 `where`/`like` 가 아니라 **`search`(§9)** 를 쓴다 — CJK·관련도·인덱스 활용.

---

## 8. `count`

```js
const unread = await app.data.count("messages", { scope, where: { read: false } });
```

배지·집계에. `where` 규칙은 `query` 와 동일.

---

## 9. `search` — CJK 전문검색

```js
const hits = await app.data.search("clips", "테스트", { scope, limit: 50 }); // 기본 50, 최대 2000
```

- 쿼리가 **3 코드포인트 이상 + 컬렉션에 `fts` 선언** → FTS5 **trigram** MATCH(한·중·일 부분일치).
- 3 미만이거나 `fts` 미선언 → doc 전체 `LIKE` 폴백(소량). 정렬 = `updated DESC`.
- `put`/`delete` 시 FTS 색인은 **자동 동기화**된다(갱신 시 옛 텍스트는 더 이상 검색 안 됨).

---

## 10. `watch` — 전 창 실시간 구독 (폴링 0)

```js
const sub = app.data.watch("commands", { scope }, (e) => {
  // e: { ns, coll, scope, op, id } — 이 ns·coll(+scope)의 put/delete 마다 전 창에 발화
  void refresh();
});
ctx.subscriptions.push(sub); // 비활성/리로드 시 자동 해지
```

- 코어 Rust 싱글톤이 `data-change` 를 **전 창 브로드캐스트** → 같은 프로젝트 다중 창 일관.
- **절대 `setInterval` 로 재조회하지 말 것.** 변경 통지는 `watch` 가 정공법.

---

## 11. 스코프(scope) 규칙

- `scope` = 프로젝트 단위 파티션(예: 프로젝트 루트). 같은 컬렉션을 프로젝트별로 분리.
- 스코프 키는 **창 무관 안정 식별자**를 쓴다 — 뷰 컨텍스트의 `ctx.root`(권장).
  `projectId`(창-로컬)는 멀티윈도우에서 갈라지므로 스코프 키로 쓰지 않는다.
- 전역(프로젝트 무관) 데이터면 scope 생략.

---

## 12. CommandBar 레거시 → `app.data` 매핑

| 레거시(Swift, 금지) | v1 정공법 |
|---|---|
| `SELECT *` + 컬럼 인덱스 0~29 파싱 | `query` + doc 필드 이름 접근 |
| `content LIKE '%q%'` 풀스캔 | `define({fts})` + `search`(trigram CJK) |
| `Set<Int>`/`Dict` 를 JSON 문자열 컬럼에 저장 | 그냥 doc 의 배열/객체 필드(JSON 네이티브) |
| `migrateHistoryTable()` 동적 `ALTER ADD` | `define` 재호출(멱등 인덱스 추가) |
| 수동 `INSERT OR REPLACE` 루프 | `put`(upsert) |
| 0.5초 타이머로 목록 재로드 | `watch` 구독 |
| 한국어 enum raw value 를 컬럼에 저장 | 영문 안정키 + i18n 분리(doc 에 `"type":"schedule"`) |

---

## 13. 안티패턴 (금지)

- ❌ 플러그인/프론트에서 raw SQL·`rusqlite`·`prepare` 사용.
- ❌ 선언하지 않은 필드로 `where`/`order`(런타임 거부).
- ❌ `fts` 없이 대량 데이터를 `like` 로 부분검색(풀스캔).
- ❌ `setInterval` 재조회(→ `watch`).
- ❌ `projectId`(창-로컬)를 scope 키로 사용(→ `ctx.root`).
- ❌ `put` 갱신 시 일부 필드만 보내기(전체 교체이므로 필드 유실).

---

## 14. RED → GREEN 검증

- **권한 게이트(vitest)**: `"data"` 미선언 → `app.data === undefined`; 선언 → 표면 존재.
  선례: `src/plugins/api.test.ts`(가짜 deps 주입).
- **의미론(cargo, 코어)**: `src-tauri/src/data/store.rs` 의 테스트(ns 격리·scope 파티션·
  trigram CJK·미선언 필드 거부·주입 안전)가 계약을 못박는다 — 신 컬렉션도 동형으로.
- **E2E(소켓 하니스)**: 플러그인 기능을 커맨드로 노출하고 `SOKSAK_SOCKET` JSON-RPC 로
  `data.query`/`data.count`/`data.search` 를 직접 단언(합성 scope 로 실데이터 격리).
  RED(미구현/계약위반 실패) → 구현 → GREEN.

---

출처: `src/plugins/api.ts:166-225,715-796`(표면·권한 게이트·ns 주입),
`src-tauri/src/data/store.rs`(define/put/get/delete/query/where 연산자/count/search/FTS 동기화),
`src-tauri/src/data/commands.rs`(전 창 `data-change` 브로드캐스트).
