// data.* commands — core surface for the generic data store (core DbState). Exposes
// backup/restore/export/import, read-only queries, and the kv rows to CLI/MCP.
// Record mutations (put/delete/define) stay excluded — plugin responsibility. kv IS
// exposed for writes here because the native plugin runtime opens the world through
// the registry only (commands.execute); without a kv surface a runtime plugin has no
// durable state at all. ns is explicit — callers own their partition, nothing is implied.

import { invoke } from "../framework";
import { register, type CommandBrokerSpec, type CommandMachineObjectSchema } from "./registry";
import { tmsg, key} from "../i18n";

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
  description: key("cmd.data.param.ns"),
  required: true,
} as const;

const COLL_PARAM = {
  type: "string",
  description: key("cmd.data.param.collection"),
  required: true,
} as const;

const KV_BATCH_MAX = 4_096;

export function registerDataCatalog(): void {
  // kv public surface — the only durable path for a native runtime plugin (see file header). ns is required.
  register("data.kv.get", {
    description: key("cmd.data.kv.get.desc"),
    triggers: { ko: "키값 조회" },
    params: {
      ns: NS_PARAM,
      key: { type: "string", required: true, description: key("cmd.data.kv.get.param.key") },
    },
    broker: kvBroker(["commands"], {
      // value is arbitrary JSON — left as an open field instead of pinned to a machine schema primitive.
      type: "object",
      properties: { ns: { type: "string" }, key: { type: "string" } },
      required: ["ns", "key"],
      additionalProperties: true,
    }),
    // The owner determines the answer — identical in every window (registry.ts windowScoped).
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
    description: key("cmd.data.kv.set.desc"),
    triggers: { ko: "키값 저장" },
    params: {
      ns: NS_PARAM,
      key: { type: "string", required: true, description: key("cmd.data.kv.set.param.key") },
      value: { type: "json", required: true, description: key("cmd.data.kv.set.param.value") },
    },
    broker: kvBroker(["commands"], {
      type: "object",
      properties: { ns: { type: "string" }, key: { type: "string" } },
      required: ["ns", "key"],
      additionalProperties: false,
    }),
    // The owner determines the answer — identical in every window (registry.ts windowScoped).
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
    description: key("cmd.data.kv.delete.desc"),
    triggers: { ko: "키값 삭제" },
    params: {
      ns: NS_PARAM,
      key: { type: "string", required: true, description: key("cmd.data.kv.delete.param.key") },
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
    // The owner determines the answer — identical in every window (registry.ts windowScoped).
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
    description: key("cmd.data.kv.keys.desc"),
    triggers: { ko: "키 목록" },
    params: {
      ns: NS_PARAM,
      prefix: { type: "string", required: false, description: key("cmd.data.kv.keys.param.prefix") },
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
    // The owner determines the answer — identical in every window (registry.ts windowScoped).
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
    description: key("cmd.data.kv.entries.desc"),
    triggers: { ko: "키 값 일괄 조회 스냅샷" },
    params: {
      ns: NS_PARAM,
      prefix: { type: "string", required: false, description: key("cmd.data.kv.entries.param.prefix") },
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
    description: key("cmd.data.kv.deleteMany.desc"),
    triggers: { ko: "키값 일괄 exact 삭제" },
    params: {
      ns: NS_PARAM,
      keys: { type: "string[]", required: true, description: key("cmd.data.kv.deleteMany.param.keys") },
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
    description: key("cmd.data.ns.remove.desc"),
    triggers: { ko: "데이터 네임스페이스 삭제 회수" },
    params: { ns: { type: "string", required: true, description: key("cmd.data.ns.remove.param.ns") } },
    danger: "destructive",
    // The owner determines the answer — identical in every window (registry.ts windowScoped).
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
    description: key("cmd.data.stats.desc"),
    triggers: { ko: "데이터 저장소 상태 통계 메모리 한도" },
    params: {},
    // The owner determines the answer — identical in every window (registry.ts windowScoped).
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
    description: key("cmd.data.verify.desc"),
    triggers: { ko: "데이터 무결성 점검 손상 확인" },
    params: {},
    // The owner determines the answer — identical in every window (registry.ts windowScoped).
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
    description: key("cmd.data.canary.desc"),
    triggers: { ko: "데이터 쓰기 확인 저장 가능" },
    params: {},
    // The owner determines the answer — identical in every window (registry.ts windowScoped).
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
    description: key("cmd.data.reclaim.desc"),
    triggers: { ko: "백업 임시 파일 회수 정리 공간" },
    params: {},
    // The owner determines the answer — identical in every window (registry.ts windowScoped).
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
    description: key("cmd.data.repair.desc"),
    triggers: { ko: "데이터 복구 인덱스 재생성 치유" },
    params: {},
    danger: "destructive",
    // The owner determines the answer — identical in every window (registry.ts windowScoped).
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
    description: key("cmd.data.backup.desc"),
    triggers: { ko: "백업 스냅샷 데이터백업" },
    params: { path: { type: "string", description: key("cmd.data.backup.param.path") } },
    // The owner determines the answer — identical in every window (registry.ts windowScoped).
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
    description: key("cmd.data.restore.desc"),
    triggers: { ko: "복원 데이터복원 되돌리기" },
    params: { path: { type: "string", description: key("cmd.data.restore.param.path"), required: true } },
    // The owner determines the answer — identical in every window (registry.ts windowScoped).
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
    description: key("cmd.data.export.desc"),
    triggers: { ko: "내보내기 익스포트 데이터이식" },
    params: {
      ns: { type: "string", description: key("cmd.data.export.param.ns") },
      coll: { type: "string", description: key("cmd.data.export.param.coll") },
    },
    // The owner determines the answer — identical in every window (registry.ts windowScoped).
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
    description: key("cmd.data.import.desc"),
    triggers: { ko: "가져오기 임포트 데이터이식 복구" },
    params: { jsonl: { type: "string", description: key("cmd.data.import.param.jsonl"), required: true } },
    // The owner determines the answer — identical in every window (registry.ts windowScoped).
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
    description: key("cmd.data.query.desc"),
    triggers: { ko: "데이터 조회 쿼리 검색 목록" },
    params: {
      ns: NS_PARAM,
      coll: COLL_PARAM,
      scope: { type: "string", description: key("cmd.data.query.param.scope") },
      where: { type: "json", description: key("cmd.data.query.param.where") },
      order: { type: "string", description: key("cmd.data.query.param.order") },
      desc: { type: "boolean", description: key("cmd.data.query.param.desc") },
      limit: { type: "number", description: key("cmd.data.query.param.limit") },
      offset: { type: "number", description: key("cmd.data.query.param.offset") },
    },
    // The owner determines the answer — identical in every window (registry.ts windowScoped).
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
    description: key("cmd.data.search.desc"),
    triggers: { ko: "검색 전문검색 찾기 텍스트검색" },
    params: {
      ns: NS_PARAM,
      coll: COLL_PARAM,
      query: { type: "string", description: key("cmd.data.search.param.query"), required: true },
      scope: { type: "string", description: key("cmd.data.search.param.scope") },
      limit: { type: "number", description: key("cmd.data.search.param.limit") },
    },
    // The owner determines the answer — identical in every window (registry.ts windowScoped).
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
    description: key("cmd.data.count.desc"),
    triggers: { ko: "카운트 개수 레코드수 건수" },
    params: {
      ns: NS_PARAM,
      coll: COLL_PARAM,
      scope: { type: "string", description: key("cmd.data.count.param.scope") },
      where: { type: "json", description: key("cmd.data.count.param.where") },
    },
    // The owner determines the answer — identical in every window (registry.ts windowScoped).
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
    description: key("cmd.data.encrypt.status.desc"),
    triggers: { ko: "암호화상태 암호화확인 봉인상태" },
    params: { scope: { type: "string", description: key("cmd.data.encrypt.status.param.scope"), required: true } },
    // The owner determines the answer — identical in every window (registry.ts windowScoped).
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
    description: key("cmd.data.encrypt.enable.desc"),
    triggers: { ko: "암호화활성 암호화켜기 봉인활성" },
    params: { scope: { type: "string", description: key("cmd.data.encrypt.enable.param.scope"), required: true } },
    // The owner determines the answer — identical in every window (registry.ts windowScoped).
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
    description: key("cmd.data.encrypt.recover.desc"),
    triggers: { ko: "암호화복구 키복구 복구코드" },
    params: {
      scope: { type: "string", description: key("cmd.data.encrypt.recover.param.scope"), required: true },
      recoveryCode: { type: "string", description: key("cmd.data.encrypt.recover.param.recoveryCode"), required: true },
    },
    // The owner determines the answer — identical in every window (registry.ts windowScoped).
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
    description: key("cmd.data.encrypt.rotate.desc"),
    triggers: { ko: "키회전 키교체 암호화회전" },
    params: { scope: { type: "string", description: key("cmd.data.encrypt.rotate.param.scope"), required: true } },
    // The owner determines the answer — identical in every window (registry.ts windowScoped).
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
    description: key("cmd.data.encrypt.changeRecovery.desc"),
    triggers: { ko: "복구코드변경 복구코드재발급 복구코드교체" },
    params: { scope: { type: "string", description: key("cmd.data.encrypt.changeRecovery.param.scope"), required: true } },
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
    description: key("cmd.data.encrypt.convert.desc"),
    triggers: { ko: "암호화변환 봉인변환 기존암호화" },
    params: {
      ns: NS_PARAM,
      coll: COLL_PARAM,
      scope: { type: "string", description: key("cmd.data.encrypt.convert.param.scope"), required: true },
    },
    // The owner determines the answer — identical in every window (registry.ts windowScoped).
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
