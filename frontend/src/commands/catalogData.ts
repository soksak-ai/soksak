// data.* commands — core surface for the generic data store (core DbState). Exposes
// backup/restore/export/import, read-only queries, and the kv rows to CLI/MCP.
// Record mutations (put/delete/define) stay excluded — plugin responsibility. kv IS
// exposed for writes here because the native plugin runtime reaches the world through
// the registry only (commands.execute); without a kv surface a runtime plugin has no
// durable state at all. ns is explicit — callers own their partition, nothing is implied.

import { invoke } from "../framework";
import { register, type CommandBrokerSpec, type CommandMachineObjectSchema } from "./registry";
import { tmsg } from "../i18n";

// The four kv commands are the only durable path for a native runtime plugin — broker opens the plugin call.
const kvBroker = (
  permissions: CommandBrokerSpec["permissions"],
  result: CommandMachineObjectSchema,
): CommandBrokerSpec => ({
  permissions,
  contracts: { requires: [], provides: [] },
  authority: [],
  result,
});

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

const KV_BATCH_MAX = 4_096;

export function registerDataCatalog(): void {
  // kv public surface — the only durable path for a native runtime plugin (see file header). ns is required.
  register("data.kv.get", {
    description: "Read one kv value from a namespace. Returns null when absent.",
    triggers: { ko: "키값 조회" },
    params: {
      ns: NS_PARAM,
      key: { type: "string", required: true, description: "Key" },
    },
    broker: kvBroker(["commands"], {
      // value is arbitrary JSON — left as an open field instead of pinned to a machine schema primitive.
      type: "object",
      properties: { ns: { type: "string" }, key: { type: "string" } },
      required: ["ns", "key"],
      additionalProperties: true,
    }),
    // The owner produces the answer — it is the same from whichever window it runs
    // (registry.ts windowScoped).
    windowScoped: false,
    returns: "{ ns, key, value }",
    message: (d) => `kv ${d.ns}:${d.key}`,
    errors: ["INVALID_PARAMS", "INTERNAL"],
    examples: ['data.kv.get \'{"ns":"soksak-plugin-<id>","key":"team:t1"}\''],
    handler: async (p) => {
      if (typeof p.ns !== "string" || !p.ns || typeof p.key !== "string" || !p.key) {
        return { ok: false as const, code: "INVALID_PARAMS" as const, message: tmsg("msg.data.kv.nsKeyRequired") };
      }
      const value = await invoke("data_kv_get", { ns: p.ns, key: p.key });
      return { ns: p.ns, key: p.key, value: value ?? null };
    },
  });

  register("data.kv.set", {
    description:
      "Write one kv value (JSON) into a namespace. The store is a core SQLite singleton — the row survives app restart and window close.",
    triggers: { ko: "키값 저장" },
    params: {
      ns: NS_PARAM,
      key: { type: "string", required: true, description: "Key" },
      value: { type: "json", required: true, description: "JSON value to store" },
    },
    broker: kvBroker(["commands"], {
      type: "object",
      properties: { ns: { type: "string" }, key: { type: "string" } },
      required: ["ns", "key"],
      additionalProperties: false,
    }),
    // The owner produces the answer — it is the same from whichever window it runs
    // (registry.ts windowScoped).
    windowScoped: false,
    returns: "{ ns, key }",
    message: (d) => `kv ${d.ns}:${d.key} saved`,
    errors: ["INVALID_PARAMS", "INTERNAL"],
    examples: ['data.kv.set \'{"ns":"soksak-plugin-<id>","key":"team:t1","value":{"agents":[]}}\''],
    handler: async (p) => {
      if (typeof p.ns !== "string" || !p.ns || typeof p.key !== "string" || !p.key) {
        return { ok: false as const, code: "INVALID_PARAMS" as const, message: tmsg("msg.data.kv.nsKeyRequired") };
      }
      await invoke("data_kv_set", { ns: p.ns, key: p.key, value: p.value ?? null });
      return { ns: p.ns, key: p.key };
    },
  });

  register("data.kv.delete", {
    description: "Delete one kv row from a namespace. Deleting an absent key reports deleted:false.",
    triggers: { ko: "키값 삭제" },
    params: {
      ns: NS_PARAM,
      key: { type: "string", required: true, description: "Key" },
    },
    danger: "destructive",
    broker: kvBroker(["commands", "commands:destructive"], {
      type: "object",
      properties: {
        ns: { type: "string" },
        key: { type: "string" },
        deleted: { type: "boolean" },
      },
      required: ["ns", "key", "deleted"],
      additionalProperties: false,
    }),
    // The owner produces the answer — it is the same from whichever window it runs
    // (registry.ts windowScoped).
    windowScoped: false,
    returns: "{ ns, key, deleted }",
    message: (d) => `kv ${d.ns}:${d.key} ${d.deleted ? "deleted" : "absent"}`,
    errors: ["INVALID_PARAMS", "INTERNAL"],
    examples: ['data.kv.delete \'{"ns":"soksak-plugin-<id>","key":"team:t1"}\''],
    handler: async (p) => {
      if (typeof p.ns !== "string" || !p.ns || typeof p.key !== "string" || !p.key) {
        return { ok: false as const, code: "INVALID_PARAMS" as const, message: tmsg("msg.data.kv.nsKeyRequired") };
      }
      const deleted = (await invoke("data_kv_delete", { ns: p.ns, key: p.key })) as boolean;
      return { ns: p.ns, key: p.key, deleted };
    },
  });

  register("data.kv.keys", {
    description: "List kv keys in a namespace, optionally filtered by prefix.",
    triggers: { ko: "키 목록" },
    params: {
      ns: NS_PARAM,
      prefix: { type: "string", required: false, description: "Key prefix filter" },
    },
    broker: kvBroker(["commands"], {
      type: "object",
      properties: {
        ns: { type: "string" },
        keys: { type: "array", items: { type: "string" } },
      },
      required: ["ns", "keys"],
      additionalProperties: false,
    }),
    // The owner produces the answer — it is the same from whichever window it runs
    // (registry.ts windowScoped).
    windowScoped: false,
    returns: "{ ns, keys }",
    message: (d) => `${(d.keys as unknown[]).length} key(s) in ${d.ns}`,
    errors: ["INVALID_PARAMS", "INTERNAL"],
    examples: ['data.kv.keys \'{"ns":"soksak-plugin-<id>","prefix":"team:"}\''],
    handler: async (p) => {
      if (typeof p.ns !== "string" || !p.ns) {
        return { ok: false as const, code: "INVALID_PARAMS" as const, message: tmsg("msg.data.nsRequired") };
      }
      const keys = (await invoke("data_kv_keys", {
        ns: p.ns,
        prefix: typeof p.prefix === "string" ? p.prefix : null,
      })) as string[];
      return { ns: p.ns, keys };
    },
  });

  register("data.kv.entries", {
    description:
      "Read a namespace key/value snapshot in one store call, optionally filtered by a literal prefix. Use this instead of keys followed by N gets when values must belong to one observed generation.",
    triggers: { ko: "키 값 일괄 조회 스냅샷" },
    params: {
      ns: NS_PARAM,
      prefix: { type: "string", required: false, description: "Literal key prefix" },
    },
    broker: kvBroker(["commands"], {
      type: "object",
      properties: {
        ns: { type: "string" },
        entries: {
          type: "array",
          items: {
            type: "object",
            // value is arbitrary JSON, so it is an open field. key is machine-checked.
            properties: { key: { type: "string" }, value: { type: "json" } },
            required: ["key", "value"],
            additionalProperties: true,
          },
        },
      },
      required: ["ns", "entries"],
      additionalProperties: false,
    }),
    windowScoped: false,
    returns: "{ ns, entries: { key, value }[] }",
    message: (d) => `${(d.entries as unknown[]).length} kv entr${(d.entries as unknown[]).length === 1 ? "y" : "ies"} in ${d.ns}`,
    errors: ["INVALID_PARAMS", "INTERNAL"],
    examples: ['data.kv.entries \'{"ns":"core","prefix":"window"}\''],
    handler: async (p) => {
      if (
        typeof p.ns !== "string" || !p.ns ||
        (p.prefix !== undefined && typeof p.prefix !== "string")
      ) {
        return { ok: false as const, code: "INVALID_PARAMS" as const, message: tmsg("msg.data.kv.entriesParams") };
      }
      return invoke<{ ns: string; entries: { key: string; value: unknown }[] }>(
        "data_kv_entries",
        { ns: p.ns, prefix: p.prefix ?? null },
      );
    },
  });

  register("data.kv.deleteMany", {
    description:
      "Delete 1..4096 explicitly named exact kv keys in one store transaction. Duplicate keys are collapsed; this command never performs prefix deletion.",
    triggers: { ko: "키값 일괄 exact 삭제" },
    params: {
      ns: NS_PARAM,
      keys: { type: "string[]", required: true, description: "1..4096 exact non-empty keys" },
    },
    danger: "destructive",
    broker: kvBroker(["commands", "commands:destructive"], {
      type: "object",
      properties: {
        ns: { type: "string" },
        requested: { type: "integer", minimum: 1, maximum: KV_BATCH_MAX },
        deleted: { type: "integer", minimum: 0, maximum: KV_BATCH_MAX },
        absent: { type: "integer", minimum: 0, maximum: KV_BATCH_MAX },
      },
      required: ["ns", "requested", "deleted", "absent"],
      additionalProperties: false,
    }),
    windowScoped: false,
    returns: "{ ns, requested, deleted, absent }",
    // One command run, one activity message. No per-key message.
    message: (d) =>
      `kv ${d.ns}: ${d.requested} requested, ${d.deleted} deleted, ${d.absent} absent`,
    errors: ["INVALID_PARAMS", "INTERNAL"],
    examples: ['data.kv.deleteMany \'{"ns":"core","keys":["window/w-1","window/w-1#prev"]}\''],
    handler: async (p) => {
      if (
        typeof p.ns !== "string" || !p.ns ||
        !Array.isArray(p.keys) || p.keys.length === 0 || p.keys.length > KV_BATCH_MAX ||
        p.keys.some((key) => typeof key !== "string" || key.length === 0)
      ) {
        return {
          ok: false as const,
          code: "INVALID_PARAMS" as const,
          message: tmsg("msg.data.kv.deleteManyParams", { max: KV_BATCH_MAX }),
        };
      }
      const keys = [...new Set(p.keys as string[])];
      return invoke<{ ns: string; requested: number; deleted: number; absent: number }>(
        "data_kv_delete_many",
        { ns: p.ns, keys },
      );
    },
  });

  // ns reclaim — whatever can be created must also be removable. Without this surface the namespaces made by
  // tests (e2e, probing) could not be removed, and the data axis of the 3-axis reclaim was left open.
  register("data.ns.remove", {
    description:
      "Remove a data namespace and everything it made: its records, kv rows, collection definitions, FTS tables and expression indexes. Other namespaces are untouched. Removing a namespace that does not exist is not a failure — it reports zeros.",
    triggers: { ko: "데이터 네임스페이스 삭제 회수" },
    params: { ns: { type: "string", required: true, description: "Namespace to remove" } },
    danger: "destructive",
    // The owner produces the answer — it is the same from whichever window it runs
    // (registry.ts windowScoped).
    windowScoped: false,
    returns: "{ ns, collections, records, kv }",
    message: (d) =>
      tmsg("msg.data.ns.remove", {
        ns: String(d.ns),
        n: Number(d.records) + Number(d.kv),
      }),
    errors: ["INVALID_PARAMS", "INTERNAL"],
    examples: ['data.ns.remove \'{"ns":"plugin:probe-lane"}\''],
    handler: async (p) => {
      if (typeof p.ns !== "string" || !p.ns) {
        return { ok: false as const, code: "INVALID_PARAMS" as const, message: tmsg("msg.data.nsRequired") };
      }
      return invoke<{ ns: string; collections: number; records: number; kv: number }>(
        "data_ns_remove",
        { ns: p.ns },
      );
    },
  });

  // Live store figures — answered by the SQLite **inside** the app. After `out of memory`, only the in-process
  // limits and memory separate out what starved it (opening the file from outside is a different board and a
  // different answer).
  register("data.stats", {
    description:
      "Report the data store as the app's own SQLite sees it: the boot write-gate verdict, version, heap limits, memory used and highwater, page cache settings, page/freelist counts, and how many indexes sit on the shared records table. Read-only. Use this when a store call answers out of memory — bootGate says whether writes worked at startup, and the limits and memory figures say what starved it.",
    triggers: { ko: "데이터 저장소 상태 통계 메모리 한도" },
    params: {},
    // The owner produces the answer — it is the same from whichever window it runs
    // (registry.ts windowScoped).
    windowScoped: false,
    returns:
      "{ bootGate, openTimings, sqliteLog, sqliteVersion, softHeapLimit, hardHeapLimit, memoryUsed, memoryHighwater, cacheSize, pageSize, pageCount, freelistCount, recordsIndexes }",
    message: (d) => tmsg("msg.data.stats", { n: Number(d.memoryUsed) }),
    errors: ["INTERNAL"],
    examples: ["data.stats"],
    // The responder fixes the shape — re-listing fields here means a new fact the store answers never crosses
    // when it is absent from that list (measured 2026-08-08: per-stage open timings were added, this
    // hand-written list dropped them, and once the naming convention diverged the whole answer arrived as `{}`).
    handler: async () => await invoke<Record<string, unknown>>("data_stats"),
  });

  // Store self-diagnosis — the boot gate (quick_check) does not cross-check index against table, so it passes
  // index corruption. A store in that state reads fine and fails only on write (measured). The full cross-check
  // is therefore a surface people and agents can call.
  register("data.verify", {
    description:
      "Check the data store for corruption (full integrity check — it cross-checks every index against the table, which the boot check does not). Read-only. Returns the problems SQLite reports; an empty list means the store is sound.",
    triggers: { ko: "데이터 무결성 점검 손상 확인" },
    params: {},
    // The owner produces the answer — it is the same from whichever window it runs
    // (registry.ts windowScoped).
    windowScoped: false,
    returns: "{ ok, problems: string[] }",
    message: (d) => tmsg("msg.data.verify", { n: Number(d.count) }),
    errors: ["INTERNAL"],
    examples: ["data.verify"],
    handler: async () => {
      const problems = await invoke<string[]>("data_verify");
      return { sound: problems.length === 0, problems, count: problems.length };
    },
  });

  // Writability — the diagnosis (integrity_check) only reads, so it misses write failure. Write one row and roll back.
  register("data.canary", {
    description:
      "Check whether the store can actually be written: inserts one row and rolls it back, leaving nothing. The integrity check only reads, so a store that reads fine and fails every write passes it — this is the surface that catches that. Failures carry the diagnosis and the process's memory figures.",
    triggers: { ko: "데이터 쓰기 확인 저장 가능" },
    params: {},
    // The owner produces the answer — it is the same from whichever window it runs
    // (registry.ts windowScoped).
    windowScoped: false,
    returns: "{ writable }",
    message: () => tmsg("msg.data.canary"),
    errors: ["INTERNAL"],
    examples: ["data.canary"],
    handler: async () => {
      await invoke<void>("data_canary");
      return { writable: true };
    },
  });

  // Backup scratch reclaim — one backup builds a file the size of the store, and a run that dies mid-build
  // leaves that size behind. Names are split by pid, so **a live owner's file is never touched** (hence not destructive).
  register("data.reclaim", {
    description:
      "Delete backup scratch files whose owning process is gone, and report how many. Each backup builds a file the size of the store, so a run that dies mid-snapshot leaves that size behind. Scratch files carry their owner's pid, and a live owner's file is never touched. Rotation reclaims on its own schedule; call this when backups are not running or the space is needed now.",
    triggers: { ko: "백업 임시 파일 회수 정리 공간" },
    params: {},
    // The owner produces the answer — it is the same from whichever window it runs
    // (registry.ts windowScoped).
    windowScoped: false,
    returns: "{ reclaimed: number }",
    message: (d) => tmsg("msg.data.reclaim", { n: Number(d.reclaimed) }),
    errors: ["INTERNAL"],
    examples: ["data.reclaim"],
    handler: async () => await invoke<{ reclaimed: number }>("data_reclaim"),
  });

  // Healing — rebuild the indexes from the table (REINDEX). Data rows are untouched, so it is not destructive,
  // but it rewrites the store, so it is marked danger (remote calls pass the permission gate).
  register("data.repair", {
    description:
      "Rebuild the data store's indexes from the table rows (REINDEX) and report the problems before and after. Rows are neither created nor deleted. Use when data.verify reports index problems — a store whose indexes are broken reads fine and fails on write. Healing is attempted even when the diagnosis itself fails; reindexError carries the reason when the rebuild could not run.",
    triggers: { ko: "데이터 복구 인덱스 재생성 치유" },
    params: {},
    danger: "destructive",
    // The owner produces the answer — it is the same from whichever window it runs
    // (registry.ts windowScoped).
    windowScoped: false,
    returns: "{ before: string[], after: string[], healed, reindexError? }",
    message: (d) =>
      d.reindexError
        ? tmsg("msg.data.repair.failed", { error: String(d.reindexError) })
        : tmsg("msg.data.repair", { n: (d.after as string[]).length }),
    errors: ["INTERNAL"],
    examples: ["data.repair"],
    handler: async () => {
      const r = await invoke<{ before: string[]; after: string[]; reindex_error?: string }>(
        "data_repair",
      );
      return {
        before: r.before,
        after: r.after,
        healed: r.before.length - r.after.length,
        ...(r.reindex_error ? { reindexError: r.reindex_error } : {}),
      };
    },
  });

  register("data.backup", {
    description:
      "Snapshot the entire data store to a single .db file via VACUUM INTO (absorbs WAL). Omit path to write a timestamped file under ~/.soksak/backups/.",
    triggers: { ko: "백업 스냅샷 데이터백업" },
    params: { path: { type: "string", description: "Destination path; defaults to backup folder" } },
    // The owner produces the answer — it is the same from whichever window it runs
    // (registry.ts windowScoped).
    windowScoped: false,
    returns: "{ path }",
    message: (d) => tmsg("msg.data.backup", { path: String(d.path) }),
    errors: ["INTERNAL"],
    examples: ["data.backup", 'data.backup \'{"path":"<local-evidence>/soksak.db"}\''],
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
    // The owner produces the answer — it is the same from whichever window it runs
    // (registry.ts windowScoped).
    windowScoped: false,
    returns: "{ ok }",
    message: () => tmsg("msg.data.restore"),
    danger: "destructive",
    errors: ["INVALID_PARAMS", "INTERNAL"],
    examples: ['data.restore \'{"path":"<local-evidence>/soksak.db"}\''],
    handler: async (p) => {
      if (typeof p.path !== "string" || !p.path.trim()) {
        return { ok: false as const, code: "INVALID_PARAMS" as const, message: tmsg("msg.data.pathRequired") };
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
    // The owner produces the answer — it is the same from whichever window it runs
    // (registry.ts windowScoped).
    windowScoped: false,
    returns: "{ jsonl }",
    message: () => tmsg("msg.data.export"),
    errors: ["INTERNAL"],
    examples: ['data.export \'{"ns":"soksak-plugin-<id>"}\''],
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
    // The owner produces the answer — it is the same from whichever window it runs
    // (registry.ts windowScoped).
    windowScoped: false,
    returns: "{ applied }",
    message: (d) => tmsg("msg.data.import", { n: Number(d.applied) }),
    danger: "destructive",
    errors: ["INVALID_PARAMS", "INTERNAL"],
    examples: ['data.import \'{"jsonl":"..."}\''],
    handler: async (p) => {
      if (typeof p.jsonl !== "string") {
        return { ok: false as const, code: "INVALID_PARAMS" as const, message: tmsg("msg.data.jsonlRequired") };
      }
      const applied = await invoke<number>("data_import", { jsonl: p.jsonl });
      return { applied };
    },
  });

  // ── Read-only queries (for inspection) ─────────────────────────────────────

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
    // The owner produces the answer — it is the same from whichever window it runs
    // (registry.ts windowScoped).
    windowScoped: false,
    returns: "{ rows }",
    message: (d) => tmsg("msg.data.query", { n: ((d.rows as unknown[]) ?? []).length }),
    errors: ["INVALID_PARAMS", "INTERNAL"],
    examples: ['data.query \'{"ns":"soksak-plugin-<id>","coll":"messages","scope":"projA"}\''],
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
    // The owner produces the answer — it is the same from whichever window it runs
    // (registry.ts windowScoped).
    windowScoped: false,
    returns: "{ rows }",
    message: (d) => tmsg("msg.data.search", { n: ((d.rows as unknown[]) ?? []).length }),
    errors: ["INVALID_PARAMS", "INTERNAL"],
    examples: ['data.search \'{"ns":"soksak-plugin-<id>","coll":"messages","query":"build failed"}\''],
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
    // The owner produces the answer — it is the same from whichever window it runs
    // (registry.ts windowScoped).
    windowScoped: false,
    returns: "{ count }",
    message: (d) => tmsg("msg.data.count", { n: Number(d.count) }),
    errors: ["INVALID_PARAMS", "INTERNAL"],
    examples: ['data.count \'{"ns":"soksak-plugin-<id>","coll":"messages"}\''],
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

  // ── Encryption (stage ② — per-scope envelope key, R0 transparent exposure) ─

  register("data.encrypt.status", {
    description:
      "Report encryption state for a scope: enabled (an active key = sealing trigger), keyId, algo, whether the vault is unlocked (decryption possible), tampered (publicKey no longer matches the vault private key), and keyMissing (the public key exists but its private key is gone from the vault — sealed records are unrecoverable).",
    triggers: { ko: "암호화상태 암호화확인 봉인상태" },
    params: { scope: { type: "string", description: "Scope partition key (e.g. projectId)", required: true } },
    // The owner produces the answer — it is the same from whichever window it runs
    // (registry.ts windowScoped).
    windowScoped: false,
    returns: "{ enabled, keyId, algo, unlocked, tampered, keyMissing }",
    message: (d) => d.enabled ? tmsg("msg.data.encrypt.status.on") : tmsg("msg.data.encrypt.status.off"),
    errors: ["INVALID_PARAMS", "INTERNAL"],
    examples: ['data.encrypt.status \'{"scope":"projA"}\''],
    handler: async (p) => {
      if (typeof p.scope !== "string" || !p.scope.trim()) {
        return { ok: false as const, code: "INVALID_PARAMS" as const, message: tmsg("msg.data.scopeRequired") };
      }
      return await invoke("data_encrypt_status", { scope: p.scope });
    },
  });

  register("data.encrypt.enable", {
    description:
      "Enable encryption for a scope: generate an X25519 keypair, wrap the private key in the vault (requires the vault to be unlocked first) AND under a one-time recovery code, then register the public key so every subsequent write is sealed. Returns the recovery code ONCE — store it safely; it is the only way to recover the data if the passphrase is lost, and it is never retrievable again. Run data.encrypt.convert afterward to seal records already stored.",
    triggers: { ko: "암호화활성 암호화켜기 봉인활성" },
    params: { scope: { type: "string", description: "Scope partition key to encrypt", required: true } },
    // The owner produces the answer — it is the same from whichever window it runs
    // (registry.ts windowScoped).
    windowScoped: false,
    returns: "{ keyId, recoveryCode }",
    message: () => tmsg("msg.data.encrypt.enable"),
    danger: "destructive",
    errors: ["INVALID_PARAMS", "INTERNAL"],
    examples: ['data.encrypt.enable \'{"scope":"projA"}\''],
    handler: async (p) => {
      if (typeof p.scope !== "string" || !p.scope.trim()) {
        return { ok: false as const, code: "INVALID_PARAMS" as const, message: tmsg("msg.data.scopeRequired") };
      }
      const r = await invoke<{ key_id: string; recovery_code: string }>("data_encrypt_enable", { scope: p.scope });
      return { keyId: r.key_id, recoveryCode: r.recovery_code };
    },
  });

  register("data.encrypt.recover", {
    description:
      "Recover a scope's encryption private key from its one-time recovery code on a machine that lacks it — a fresh install, a different OS, or a lost keychain. Re-stores the key under this device's OS-keychain KEK, which must be reachable. The recovered key must match the registered public key or recovery is refused. After success the scope's sealed records decrypt again on this machine.",
    triggers: { ko: "암호화복구 키복구 복구코드" },
    params: {
      scope: { type: "string", description: "Scope partition key to recover", required: true },
      recoveryCode: { type: "string", description: "The recovery code issued at enable", required: true },
    },
    // The owner produces the answer — it is the same from whichever window it runs
    // (registry.ts windowScoped).
    windowScoped: false,
    returns: "{ ok }",
    message: () => tmsg("msg.data.encrypt.recover"),
    danger: "destructive",
    errors: ["INVALID_PARAMS", "INTERNAL"],
    examples: ['data.encrypt.recover \'{"scope":"projA","recoveryCode":"XXXX-XXXX-..."}\''],
    handler: async (p) => {
      if (typeof p.scope !== "string" || !p.scope.trim() || typeof p.recoveryCode !== "string" || !p.recoveryCode.trim()) {
        return { ok: false as const, code: "INVALID_PARAMS" as const, message: tmsg("msg.data.encrypt.recoverParams") };
      }
      await invoke("data_encrypt_recover", { scope: p.scope, recoveryCode: p.recoveryCode });
      return { ok: true };
    },
  });

  register("data.encrypt.rotate", {
    description:
      "Rotate a scope's encryption key: generate a new keypair, re-seal every record from the old key to the new one (one transaction each, resumable), re-issue the recovery blob under a NEW recovery code, then dispose the old key only once nothing references it. Requires this device's OS-keychain KEK. Returns the new recovery code ONCE — store it; the previous code no longer opens the data.",
    triggers: { ko: "키회전 키교체 암호화회전" },
    params: { scope: { type: "string", description: "Scope partition key to rotate", required: true } },
    // The owner produces the answer — it is the same from whichever window it runs
    // (registry.ts windowScoped).
    windowScoped: false,
    returns: "{ oldKeyId, newKeyId, rekeyed, oldDisposed, recoveryCode }",
    message: (d) => tmsg("msg.data.encrypt.rotate", { n: Number(d.rekeyed) }),
    danger: "destructive",
    errors: ["INVALID_PARAMS", "INTERNAL"],
    examples: ['data.encrypt.rotate \'{"scope":"projA"}\''],
    handler: async (p) => {
      if (typeof p.scope !== "string" || !p.scope.trim()) {
        return { ok: false as const, code: "INVALID_PARAMS" as const, message: tmsg("msg.data.scopeRequired") };
      }
      return await invoke("data_encrypt_rotate", { scope: p.scope });
    },
  });

  register("data.encrypt.changeRecovery", {
    description:
      "Change a scope's recovery code WITHOUT re-encrypting data: re-wrap the active private key under a fresh recovery code and return it once. Use when the old code is lost or exposed. Requires this device's OS-keychain KEK. The previous code stops working; store the new one. Cheaper than rotate — the key and sealed records are untouched, only the recovery blob is replaced.",
    triggers: { ko: "복구코드변경 복구코드재발급 복구코드교체" },
    params: { scope: { type: "string", description: "Scope partition key", required: true } },
    returns: "{ recoveryCode }",
    message: () => tmsg("msg.data.encrypt.changeRecovery"),
    danger: "destructive",
    errors: ["INVALID_PARAMS", "INTERNAL"],
    examples: ['data.encrypt.changeRecovery \'{"scope":"projA"}\''],
    handler: async (p) => {
      if (typeof p.scope !== "string" || !p.scope.trim()) {
        return { ok: false as const, code: "INVALID_PARAMS" as const, message: tmsg("msg.data.scopeRequired") };
      }
      const recoveryCode = await invoke<string>("data_encrypt_change_recovery", { scope: p.scope });
      return { ok: true, recoveryCode };
    },
  });

  register("data.encrypt.convert", {
    description:
      "Seal records already stored plaintext in a scope under the active key (one transaction per record, idempotent, resumable). Run after data.encrypt.enable to protect pre-existing data.",
    triggers: { ko: "암호화변환 봉인변환 기존암호화" },
    params: {
      ns: NS_PARAM,
      coll: COLL_PARAM,
      scope: { type: "string", description: "Scope partition key to convert", required: true },
    },
    // The owner produces the answer — it is the same from whichever window it runs
    // (registry.ts windowScoped).
    windowScoped: false,
    returns: "{ converted }",
    message: (d) => tmsg("msg.data.encrypt.convert", { n: Number(d.converted) }),
    danger: "destructive",
    errors: ["INVALID_PARAMS", "INTERNAL"],
    examples: ['data.encrypt.convert \'{"ns":"soksak-plugin-<id>","coll":"command_blocks","scope":"projA"}\''],
    handler: async (p) => {
      if (typeof p.scope !== "string" || !p.scope.trim()) {
        return { ok: false as const, code: "INVALID_PARAMS" as const, message: tmsg("msg.data.scopeRequired") };
      }
      const converted = await invoke<number>("data_encrypt_convert", {
        ns: p.ns,
        coll: p.coll,
        scope: p.scope,
      });
      return { converted };
    },
  });
}
