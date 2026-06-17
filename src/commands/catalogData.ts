// data.* 명령 — 범용 데이터 스토어(Rust DbState)의 코어 표면. 백업/복원/이식 + 읽기 조회를
// CLI/MCP 에 노출(단일 진실). 플러그인은 app.data 표면을 쓰고, 이 명령들은 운영·점검용.
// 쓰기 조회(put/delete/define)는 플러그인 소관이라 노출하지 않는다(범위 최소화).

import { invoke } from "@tauri-apps/api/core";
import { register } from "./registry";

const NS_PARAM = {
  type: "string",
  description: "네임스페이스(플러그인 id 또는 core)",
  required: true,
} as const;

const COLL_PARAM = {
  type: "string",
  description: "컬렉션 이름",
  required: true,
} as const;

export function registerDataCatalog(): void {
  register("data.backup", {
    description:
      "전체 데이터 스토어를 단일 .db 스냅샷으로 백업(VACUUM INTO — WAL 흡수). path 생략 시 ~/.soksak/backups/ 에 타임스탬프 파일",
    params: { path: { type: "string", description: "저장 경로(생략 시 기본 백업 폴더)" } },
    returns: "{ path }",
    errors: ["INTERNAL"],
    examples: ["sok data.backup", 'sok data.backup \'{"path":"/tmp/soksak.db"}\''],
    handler: async (p) => {
      const path = await invoke<string>("data_backup", {
        path: typeof p.path === "string" ? p.path : null,
      });
      return { path };
    },
  });

  register("data.restore", {
    description:
      "백업 .db 로 전체 데이터 스토어 복원(검증→현재본 안전복사→원자 스왑). 되돌릴 수 없으니 주의",
    params: { path: { type: "string", description: "복원할 백업 .db 경로", required: true } },
    returns: "{ ok }",
    danger: "destructive",
    errors: ["INVALID_PARAMS", "INTERNAL"],
    examples: ['sok data.restore \'{"path":"/tmp/soksak.db"}\''],
    handler: async (p) => {
      if (typeof p.path !== "string" || !p.path.trim()) {
        return { ok: false as const, code: "INVALID_PARAMS" as const, message: "path 필요" };
      }
      await invoke("data_restore", { path: p.path });
      return { ok: true };
    },
  });

  register("data.export", {
    description:
      "데이터를 JSONL 로 내보내기(meta+record+kv). ns/coll 로 범위 한정(생략 시 전체). 부분 백업·이식용",
    params: {
      ns: { type: "string", description: "네임스페이스로 한정(생략 시 전체)" },
      coll: { type: "string", description: "컬렉션으로 한정(생략 시 전체)" },
    },
    returns: "{ jsonl }",
    errors: ["INTERNAL"],
    examples: ['sok data.export \'{"ns":"soksak-plugin-mailbox"}\''],
    handler: async (p) => {
      const jsonl = await invoke<string>("data_export", {
        ns: typeof p.ns === "string" ? p.ns : null,
        coll: typeof p.coll === "string" ? p.coll : null,
      });
      return { jsonl };
    },
  });

  register("data.import", {
    description: "JSONL 데이터 이식(meta→define, record→upsert, kv→set). 기존 id 는 덮어씀",
    params: { jsonl: { type: "string", description: "data.export 출력 JSONL", required: true } },
    returns: "{ applied }",
    danger: "destructive",
    errors: ["INVALID_PARAMS", "INTERNAL"],
    examples: ['sok data.import \'{"jsonl":"..."}\''],
    handler: async (p) => {
      if (typeof p.jsonl !== "string") {
        return { ok: false as const, code: "INVALID_PARAMS" as const, message: "jsonl 필요" };
      }
      const applied = await invoke<number>("data_import", { jsonl: p.jsonl });
      return { applied };
    },
  });

  // ── 읽기 조회(점검용) ──────────────────────────────────────────────────────

  register("data.query", {
    description: "컬렉션 구조 질의(읽기). where 필드는 define 의 indexes 로 선언돼야 함",
    params: {
      ns: NS_PARAM,
      coll: COLL_PARAM,
      scope: { type: "string", description: "스코프 파티션(예: projectId)" },
      where: { type: "json", description: "{field: value} 또는 {field:{op,value}}" },
      order: { type: "string", description: "정렬 필드(created/updated 또는 인덱스 필드)" },
      desc: { type: "boolean", description: "내림차순(기본 true)" },
      limit: { type: "number", description: "최대 건수(기본 200)" },
      offset: { type: "number", description: "건너뛸 건수" },
    },
    returns: "{ rows }",
    errors: ["INVALID_PARAMS", "INTERNAL"],
    examples: ['sok data.query \'{"ns":"soksak-plugin-mailbox","coll":"messages","scope":"projA"}\''],
    handler: async (p) => {
      const rows = await invoke<unknown[]>("data_query", {
        ns: p.ns,
        coll: p.coll,
        scope: p.scope ?? null,
        filter: p.where ?? null,
        order: p.order ?? null,
        desc: p.desc ?? null,
        limit: p.limit ?? null,
        offset: p.offset ?? null,
      });
      return { rows };
    },
  });

  register("data.search", {
    description: "컬렉션 CJK 전문검색(FTS5 trigram). 쿼리 <3 코드포인트는 LIKE 폴백",
    params: {
      ns: NS_PARAM,
      coll: COLL_PARAM,
      query: { type: "string", description: "검색어", required: true },
      scope: { type: "string", description: "스코프 파티션" },
      limit: { type: "number", description: "최대 건수(기본 50)" },
    },
    returns: "{ rows }",
    errors: ["INVALID_PARAMS", "INTERNAL"],
    examples: ['sok data.search \'{"ns":"soksak-plugin-mailbox","coll":"messages","query":"빌드 실패"}\''],
    handler: async (p) => {
      const rows = await invoke<unknown[]>("data_search", {
        ns: p.ns,
        coll: p.coll,
        query: p.query,
        scope: p.scope ?? null,
        limit: p.limit ?? null,
      });
      return { rows };
    },
  });

  register("data.count", {
    description: "컬렉션 레코드 수(읽기). where 로 조건 한정",
    params: {
      ns: NS_PARAM,
      coll: COLL_PARAM,
      scope: { type: "string", description: "스코프 파티션" },
      where: { type: "json", description: "조건(query 와 동일)" },
    },
    returns: "{ count }",
    errors: ["INVALID_PARAMS", "INTERNAL"],
    examples: ['sok data.count \'{"ns":"soksak-plugin-mailbox","coll":"messages"}\''],
    handler: async (p) => {
      const count = await invoke<number>("data_count", {
        ns: p.ns,
        coll: p.coll,
        scope: p.scope ?? null,
        filter: p.where ?? null,
      });
      return { count };
    },
  });
}
