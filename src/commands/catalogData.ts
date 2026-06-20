// data.* commands — core surface for the generic data store (Rust DbState). Exposes
// backup/restore/export/import and read-only queries to CLI/MCP (single source of truth).
// Plugins use the app.data surface; these commands are for ops and inspection.
// Write mutations (put/delete/define) are intentionally excluded — plugin responsibility.

import { invoke } from "@tauri-apps/api/core";
import { register } from "./registry";

const NS_PARAM = {
  type: "string",
  description: "Namespace: plugin id or 'core'",
  required: true,
} as const;

const COLL_PARAM = {
  type: "string",
  description: "Collection name",
  required: true,
} as const;

export function registerDataCatalog(): void {
  register("data.backup", {
    description:
      "Snapshot the entire data store to a single .db file via VACUUM INTO (absorbs WAL). Omit path to write a timestamped file under ~/.soksak/backups/.",
    triggers: { ko: "백업 스냅샷 데이터백업" },
    params: { path: { type: "string", description: "Destination path; defaults to backup folder" } },
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
      "Restore the entire data store from a backup .db file: validates, safely copies the current store, then atomically swaps. Irreversible — use with caution.",
    triggers: { ko: "복원 데이터복원 되돌리기" },
    params: { path: { type: "string", description: "Path to the backup .db file to restore from", required: true } },
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
      "Export data as JSONL (meta + record + kv rows). Scope by ns/coll; omit both for a full export. Use for partial backups or migrating data between instances.",
    triggers: { ko: "내보내기 익스포트 데이터이식" },
    params: {
      ns: { type: "string", description: "Limit to this namespace; omit for all" },
      coll: { type: "string", description: "Limit to this collection; omit for all" },
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
    description:
      "Import JSONL produced by data.export: meta rows call define, record rows upsert, kv rows set. Existing ids are overwritten.",
    triggers: { ko: "가져오기 임포트 데이터이식 복구" },
    params: { jsonl: { type: "string", description: "JSONL string output from data.export", required: true } },
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
    description:
      "Query a collection (read-only). Filter fields must be declared as indexes in define. Use to read or filter stored records.",
    triggers: { ko: "데이터 조회 쿼리 검색 목록" },
    params: {
      ns: NS_PARAM,
      coll: COLL_PARAM,
      scope: { type: "string", description: "Scope partition key (e.g. projectId)" },
      where: { type: "json", description: "{field: value} or {field: {op, value}}" },
      order: { type: "string", description: "Sort field: created, updated, or any index field" },
      desc: { type: "boolean", description: "Sort descending (default true)" },
      limit: { type: "number", description: "Max rows to return (default 200)" },
      offset: { type: "number", description: "Rows to skip" },
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
    description:
      "Full-text search a collection using FTS5 trigram (CJK-aware). Queries shorter than 3 code points fall back to LIKE.",
    triggers: { ko: "검색 전문검색 찾기 텍스트검색" },
    params: {
      ns: NS_PARAM,
      coll: COLL_PARAM,
      query: { type: "string", description: "Search query string", required: true },
      scope: { type: "string", description: "Scope partition key" },
      limit: { type: "number", description: "Max rows to return (default 50)" },
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
    description:
      "Count records in a collection (read-only). Narrow the count with an optional where filter.",
    triggers: { ko: "카운트 개수 레코드수 건수" },
    params: {
      ns: NS_PARAM,
      coll: COLL_PARAM,
      scope: { type: "string", description: "Scope partition key" },
      where: { type: "json", description: "Filter condition (same shape as data.query where)" },
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
