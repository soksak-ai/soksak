// data.* commands — core surface for the generic data store (Rust DbState). Exposes
// backup/restore/export/import, read-only queries, and the kv rows to CLI/MCP.
// Record mutations (put/delete/define) stay excluded — plugin responsibility. kv IS
// exposed for writes here because the native plugin runtime reaches the world through
// the registry only (commands.execute); without a kv surface a runtime plugin has no
// durable state at all. ns is explicit — callers own their partition, nothing is implied.

import { invoke } from "@tauri-apps/api/core";
import { register, type CommandBrokerSpec, type CommandMachineObjectSchema } from "./registry";
import { tmsg } from "../i18n";

// kv 4종은 native 런타임 플러그인의 유일한 영속 통로 — broker 로 플러그인 호출을 연다.
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

export function registerDataCatalog(): void {
  // kv 4종 — native 런타임 플러그인의 유일한 영속 통로(파일 머리말 참조). ns 명시 필수.
  register("data.kv.get", {
    description: "Read one kv value from a namespace. Returns null when absent.",
    triggers: { ko: "키값 조회" },
    params: {
      ns: NS_PARAM,
      key: { type: "string", required: true, description: "Key" },
    },
    broker: kvBroker(["commands"], {
      // value 는 임의 JSON — 기계 스키마 프리미티브로 못 박지 않고 개방 필드로 둔다.
      type: "object",
      properties: { ns: { type: "string" }, key: { type: "string" } },
      required: ["ns", "key"],
      additionalProperties: true,
    }),
    returns: "{ ns, key, value }",
    message: (d) => `kv ${d.ns}:${d.key}`,
    errors: ["INVALID_PARAMS", "INTERNAL"],
    examples: ['data.kv.get \'{"ns":"soksak-plugin-tmux-fake","key":"team:t1"}\''],
    handler: async (p) => {
      if (typeof p.ns !== "string" || !p.ns || typeof p.key !== "string" || !p.key) {
        return { ok: false as const, code: "INVALID_PARAMS" as const, message: "ns, key 필요" };
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
    returns: "{ ns, key }",
    message: (d) => `kv ${d.ns}:${d.key} saved`,
    errors: ["INVALID_PARAMS", "INTERNAL"],
    examples: ['data.kv.set \'{"ns":"soksak-plugin-tmux-fake","key":"team:t1","value":{"agents":[]}}\''],
    handler: async (p) => {
      if (typeof p.ns !== "string" || !p.ns || typeof p.key !== "string" || !p.key) {
        return { ok: false as const, code: "INVALID_PARAMS" as const, message: "ns, key 필요" };
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
    returns: "{ ns, key, deleted }",
    message: (d) => `kv ${d.ns}:${d.key} ${d.deleted ? "deleted" : "absent"}`,
    errors: ["INVALID_PARAMS", "INTERNAL"],
    examples: ['data.kv.delete \'{"ns":"soksak-plugin-tmux-fake","key":"team:t1"}\''],
    handler: async (p) => {
      if (typeof p.ns !== "string" || !p.ns || typeof p.key !== "string" || !p.key) {
        return { ok: false as const, code: "INVALID_PARAMS" as const, message: "ns, key 필요" };
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
    returns: "{ ns, keys }",
    message: (d) => `${(d.keys as unknown[]).length} key(s) in ${d.ns}`,
    errors: ["INVALID_PARAMS", "INTERNAL"],
    examples: ['data.kv.keys \'{"ns":"soksak-plugin-tmux-fake","prefix":"team:"}\''],
    handler: async (p) => {
      if (typeof p.ns !== "string" || !p.ns) {
        return { ok: false as const, code: "INVALID_PARAMS" as const, message: "ns 필요" };
      }
      const keys = (await invoke("data_kv_keys", {
        ns: p.ns,
        prefix: typeof p.prefix === "string" ? p.prefix : null,
      })) as string[];
      return { ns: p.ns, keys };
    },
  });

  // ns 회수 — 만드는 길이 있으면 걷는 길도 있어야 한다. 이 표면이 없어서 시험(e2e·프로빙)이 만든
  // 네임스페이스를 걷을 수 없었고, 회수 3축의 데이터 축이 뚫려 있었다.
  register("data.ns.remove", {
    description:
      "Remove a data namespace and everything it made: its records, kv rows, collection definitions, FTS tables and expression indexes. Other namespaces are untouched. Removing a namespace that does not exist is not a failure — it reports zeros.",
    triggers: { ko: "데이터 네임스페이스 삭제 회수" },
    params: { ns: { type: "string", required: true, description: "Namespace to remove" } },
    danger: "destructive",
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
        return { ok: false as const, code: "INVALID_PARAMS" as const, message: "ns 필요" };
      }
      return invoke<{ ns: string; collections: number; records: number; kv: number }>(
        "data_ns_remove",
        { ns: p.ns },
      );
    },
  });

  // 저장소 실황 — 앱 **안의** SQLite 가 답한다. `out of memory` 가 났을 때 무엇이 굶겼는지는 프로세스
  // 안의 한도·메모리로만 가려진다(밖에서 파일을 열어 보면 판이 달라 답이 갈린다).
  register("data.stats", {
    description:
      "Report the data store as the app's own SQLite sees it: version, heap limits, memory used and highwater, page cache settings, page/freelist counts, and how many indexes sit on the shared records table. Read-only. Use this when a store call answers out of memory — the limits and memory figures say what starved it.",
    triggers: { ko: "데이터 저장소 상태 통계 메모리 한도" },
    params: {},
    returns:
      "{ sqliteVersion, softHeapLimit, hardHeapLimit, memoryUsed, memoryHighwater, cacheSize, pageSize, pageCount, freelistCount, recordsIndexes }",
    message: (d) => tmsg("msg.data.stats", { n: Number(d.memoryUsed) }),
    errors: ["INTERNAL"],
    examples: ["data.stats"],
    handler: async () => {
      const s = await invoke<{
        sqlite_version: string;
        soft_heap_limit: number;
        hard_heap_limit: number;
        memory_used: number;
        memory_highwater: number;
        cache_size: number;
        page_size: number;
        page_count: number;
        freelist_count: number;
        records_indexes: number;
      }>("data_stats");
      return {
        sqliteVersion: s.sqlite_version,
        softHeapLimit: s.soft_heap_limit,
        hardHeapLimit: s.hard_heap_limit,
        memoryUsed: s.memory_used,
        memoryHighwater: s.memory_highwater,
        cacheSize: s.cache_size,
        pageSize: s.page_size,
        pageCount: s.page_count,
        freelistCount: s.freelist_count,
        recordsIndexes: s.records_indexes,
      };
    },
  });

  // 저장소 자기 진단 — 부팅 게이트(quick_check)는 인덱스↔테이블 대조를 하지 않아 인덱스 손상을
  // 통과시킨다. 그 상태의 저장소는 읽기는 멀쩡하고 쓰기만 무너진다(실측). 그래서 전수 대조를
  // 사람과 에이전트가 부를 수 있는 표면으로 둔다.
  register("data.verify", {
    description:
      "Check the data store for corruption (full integrity check — it cross-checks every index against the table, which the boot check does not). Read-only. Returns the problems SQLite reports; an empty list means the store is sound.",
    triggers: { ko: "데이터 무결성 점검 손상 확인" },
    params: {},
    returns: "{ ok, problems: string[] }",
    message: (d) => tmsg("msg.data.verify", { n: Number(d.count) }),
    errors: ["INTERNAL"],
    examples: ["data.verify"],
    handler: async () => {
      const problems = await invoke<string[]>("data_verify");
      return { sound: problems.length === 0, problems, count: problems.length };
    },
  });

  // 치유 — 인덱스를 테이블에서 다시 만든다(REINDEX). 데이터 행은 건드리지 않으므로 파괴적이지
  // 않지만, 저장소를 고쳐 쓰는 일이라 danger 로 둔다(원격 호출은 권한 게이트를 지난다).
  register("data.repair", {
    description:
      "Rebuild the data store's indexes from the table rows (REINDEX) and report the problems before and after. Rows are neither created nor deleted. Use when data.verify reports index problems — a store whose indexes are broken reads fine and fails on write.",
    triggers: { ko: "데이터 복구 인덱스 재생성 치유" },
    params: {},
    danger: "destructive",
    returns: "{ before: string[], after: string[], healed }",
    message: (d) => tmsg("msg.data.repair", { n: (d.after as string[]).length }),
    errors: ["INTERNAL"],
    examples: ["data.repair"],
    handler: async () => {
      const r = await invoke<{ before: string[]; after: string[] }>("data_repair");
      return { ...r, healed: r.before.length - r.after.length };
    },
  });

  register("data.backup", {
    description:
      "Snapshot the entire data store to a single .db file via VACUUM INTO (absorbs WAL). Omit path to write a timestamped file under ~/.soksak/backups/.",
    triggers: { ko: "백업 스냅샷 데이터백업" },
    params: { path: { type: "string", description: "Destination path; defaults to backup folder" } },
    returns: "{ path }",
    message: (d) => tmsg("msg.data.backup", { path: String(d.path) }),
    errors: ["INTERNAL"],
    examples: ["data.backup", 'data.backup \'{"path":"/tmp/soksak.db"}\''],
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
    message: () => tmsg("msg.data.restore"),
    danger: "destructive",
    errors: ["INVALID_PARAMS", "INTERNAL"],
    examples: ['data.restore \'{"path":"/tmp/soksak.db"}\''],
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
    returns: "{ applied }",
    message: (d) => tmsg("msg.data.import", { n: Number(d.applied) }),
    danger: "destructive",
    errors: ["INVALID_PARAMS", "INTERNAL"],
    examples: ['data.import \'{"jsonl":"..."}\''],
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
    returns: "{ rows }",
    message: (d) => tmsg("msg.data.search", { n: ((d.rows as unknown[]) ?? []).length }),
    errors: ["INVALID_PARAMS", "INTERNAL"],
    examples: ['data.search \'{"ns":"soksak-plugin-<id>","coll":"messages","query":"빌드 실패"}\''],
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

  // ── 암호화(단계② — scope 단위 봉투 키, R0 투명 노출) ────────────────────────

  register("data.encrypt.status", {
    description:
      "Report encryption state for a scope: enabled (an active key = sealing trigger), keyId, algo, whether the vault is unlocked (decryption possible), tampered (publicKey no longer matches the vault private key), and keyMissing (the public key exists but its private key is gone from the vault — sealed records are unrecoverable).",
    triggers: { ko: "암호화상태 암호화확인 봉인상태" },
    params: { scope: { type: "string", description: "Scope partition key (e.g. projectId)", required: true } },
    returns: "{ enabled, keyId, algo, unlocked, tampered, keyMissing }",
    message: (d) => d.enabled ? tmsg("msg.data.encrypt.status.on") : tmsg("msg.data.encrypt.status.off"),
    errors: ["INVALID_PARAMS", "INTERNAL"],
    examples: ['data.encrypt.status \'{"scope":"projA"}\''],
    handler: async (p) => {
      if (typeof p.scope !== "string" || !p.scope.trim()) {
        return { ok: false as const, code: "INVALID_PARAMS" as const, message: "scope 필요" };
      }
      return await invoke("data_encrypt_status", { scope: p.scope });
    },
  });

  register("data.encrypt.enable", {
    description:
      "Enable encryption for a scope: generate an X25519 keypair, wrap the private key in the vault (requires the vault to be unlocked first) AND under a one-time recovery code, then register the public key so every subsequent write is sealed. Returns the recovery code ONCE — store it safely; it is the only way to recover the data if the passphrase is lost, and it is never retrievable again. Run data.encrypt.convert afterward to seal records already stored.",
    triggers: { ko: "암호화활성 암호화켜기 봉인활성" },
    params: { scope: { type: "string", description: "Scope partition key to encrypt", required: true } },
    returns: "{ keyId, recoveryCode }",
    message: () => tmsg("msg.data.encrypt.enable"),
    danger: "destructive",
    errors: ["INVALID_PARAMS", "INTERNAL"],
    examples: ['data.encrypt.enable \'{"scope":"projA"}\''],
    handler: async (p) => {
      if (typeof p.scope !== "string" || !p.scope.trim()) {
        return { ok: false as const, code: "INVALID_PARAMS" as const, message: "scope 필요" };
      }
      const r = await invoke<{ key_id: string; recovery_code: string }>("data_encrypt_enable", { scope: p.scope });
      return { keyId: r.key_id, recoveryCode: r.recovery_code };
    },
  });

  register("data.encrypt.recover", {
    description:
      "Recover a scope's encryption private key from its one-time recovery code after a lost passphrase. Unlock the vault with a NEW passphrase first; this re-stores the recovered key under it. The recovered key must match the registered public key or recovery is refused. After success the scope's sealed records decrypt again.",
    triggers: { ko: "암호화복구 키복구 복구코드" },
    params: {
      scope: { type: "string", description: "Scope partition key to recover", required: true },
      recoveryCode: { type: "string", description: "The recovery code issued at enable", required: true },
    },
    returns: "{ ok }",
    message: () => tmsg("msg.data.encrypt.recover"),
    danger: "destructive",
    errors: ["INVALID_PARAMS", "INTERNAL"],
    examples: ['data.encrypt.recover \'{"scope":"projA","recoveryCode":"XXXX-XXXX-..."}\''],
    handler: async (p) => {
      if (typeof p.scope !== "string" || !p.scope.trim() || typeof p.recoveryCode !== "string" || !p.recoveryCode.trim()) {
        return { ok: false as const, code: "INVALID_PARAMS" as const, message: "scope·recoveryCode 필요" };
      }
      await invoke("data_encrypt_recover", { scope: p.scope, recoveryCode: p.recoveryCode });
      return { ok: true };
    },
  });

  register("data.encrypt.rotate", {
    description:
      "Rotate a scope's encryption key: generate a new keypair, re-seal every record from the old key to the new one (one transaction each, resumable), then dispose the old key only once nothing references it. Requires the vault unlocked.",
    triggers: { ko: "키회전 키교체 암호화회전" },
    params: { scope: { type: "string", description: "Scope partition key to rotate", required: true } },
    returns: "{ oldKeyId, newKeyId, rekeyed, oldDisposed }",
    message: (d) => tmsg("msg.data.encrypt.rotate", { n: Number(d.rekeyed) }),
    danger: "destructive",
    errors: ["INVALID_PARAMS", "INTERNAL"],
    examples: ['data.encrypt.rotate \'{"scope":"projA"}\''],
    handler: async (p) => {
      if (typeof p.scope !== "string" || !p.scope.trim()) {
        return { ok: false as const, code: "INVALID_PARAMS" as const, message: "scope 필요" };
      }
      return await invoke("data_encrypt_rotate", { scope: p.scope });
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
    returns: "{ converted }",
    message: (d) => tmsg("msg.data.encrypt.convert", { n: Number(d.converted) }),
    danger: "destructive",
    errors: ["INVALID_PARAMS", "INTERNAL"],
    examples: ['data.encrypt.convert \'{"ns":"soksak-plugin-<id>","coll":"command_blocks","scope":"projA"}\''],
    handler: async (p) => {
      if (typeof p.scope !== "string" || !p.scope.trim()) {
        return { ok: false as const, code: "INVALID_PARAMS" as const, message: "scope 필요" };
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
