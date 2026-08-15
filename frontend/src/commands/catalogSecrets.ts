// secret.* commands — exposes the encrypted secret vault (core SecretsState) through command registry
// (single source of truth). Covers CLI/MCP e2e self-verification: vault status (status/backend)
// + ns·key management (set/has/keys/delete).
//
// Transparent unlock — the KEK comes from the OS key store (os_key), so there is no daily passphrase
// unlock/lock/autolock command. no-secret-service (headless/no D-Bus) surfaces as seal_available=false
// (sealing impossible), never a silent plaintext fallback.
//
// No get command — the core blocks plaintext readback (secretRef injection via 2b is the only plaintext path).
// All management commands delegate to invoke (vault/crypto are the core single source of truth).

import { invoke } from "../framework";
import { register } from "./registry";
import { tmsg } from "../i18n";

const NS_PARAM = {
  type: "string",
  description: tmsg("cmd.secret.param.ns"),
  required: true,
} as const;

const KEY_PARAM = {
  type: "string",
  description: tmsg("cmd.secret.param.key"),
  required: true,
} as const;

export function registerSecretsCatalog(): void {
  register("secret.status", {
    description:
      "Query the transparent-unlock status: KEK backend label, seal_available (whether the OS key store is reachable, so sealing/opening works), expect_vault (app.data envelope keys registered), and the stored app.data key ids. Use to check whether secrets can be sealed before performing operations.",
    triggers: { ko: "시크릿 볼트 상태 백엔드 봉인가능 status" },
    params: {},
    // The answer comes from the owner — identical whichever window runs it (registry.ts windowScoped).
    windowScoped: false,
    returns: "{ backend, seal_available, expect_vault, data_key_ids }",
    message: (d) =>
      d.seal_available
        ? tmsg("msg.secret.backend.unlocked", { backend: String(d.backend) })
        : tmsg("msg.secret.backend.locked", { backend: String(d.backend) }),
    errors: ["INTERNAL"],
    examples: ["secret.status"],
    handler: async () => {
      return await invoke<{
        backend: string;
        seal_available: boolean;
        expect_vault: boolean;
        data_key_ids: string[];
      }>("secret_status");
    },
  });

  register("secret.backend", {
    description:
      "Query the KEK backend label and whether sealing is available (compat shim over secret.status; unlocked = seal_available). Prefer secret.status.",
    triggers: { ko: "시크릿 볼트 상태 백엔드 봉인가능" },
    params: {},
    // The answer comes from the owner — identical whichever window runs it (registry.ts windowScoped).
    windowScoped: false,
    returns: "{ backend, unlocked }",
    message: (d) => d.unlocked ? tmsg("msg.secret.backend.unlocked", { backend: String(d.backend) }) : tmsg("msg.secret.backend.locked", { backend: String(d.backend) }),
    errors: ["INTERNAL"],
    examples: ["secret.backend"],
    handler: async () => {
      return await invoke<{ backend: string; unlocked: boolean }>("secret_backend");
    },
  });

  register("secret.set", {
    description:
      "Store a sensitive value under ns/key using envelope encryption (per-item DEK wrapped by the device KEK). Overwrites the existing value if the key already exists. Rejected when the OS key store is unavailable (no secret service).",
    triggers: { ko: "시크릿 저장 설정 키 값 저장 set 보관" },
    params: { ns: NS_PARAM, key: KEY_PARAM, value: { type: "string", description: "Sensitive value to store", required: true } },
    // The answer comes from the owner — identical whichever window runs it (registry.ts windowScoped).
    windowScoped: false,
    returns: "{ ok }",
    message: () => tmsg("msg.secret.set"),
    danger: "inject",
    errors: ["INVALID_PARAMS", "INTERNAL"],
    examples: ['secret.set \'{"ns":"soksak-plugin-<id>","key":"anthropicKey","value":"sk-ant-..."}\''],
    handler: async (p) => {
      if (typeof p.ns !== "string" || typeof p.key !== "string" || typeof p.value !== "string") {
        return { ok: false as const, code: "INVALID_PARAMS" as const, message: tmsg("msg.secret.set.paramsRequired") };
      }
      await invoke("secret_set", { ns: p.ns, key: p.key, value: p.value });
      return { ok: true };
    },
  });

  register("secret.has", {
    description: tmsg("cmd.secret.has.desc"),
    triggers: { ko: "시크릿 존재 확인 있는지 has 체크" },
    params: { ns: NS_PARAM, key: KEY_PARAM },
    // The answer comes from the owner — identical whichever window runs it (registry.ts windowScoped).
    windowScoped: false,
    returns: "{ has }",
    message: (d) => d.has ? tmsg("msg.secret.has.present") : tmsg("msg.secret.has.absent"),
    errors: ["INVALID_PARAMS", "INTERNAL"],
    examples: ['secret.has \'{"ns":"soksak-plugin-<id>","key":"anthropicKey"}\''],
    handler: async (p) => {
      if (typeof p.ns !== "string" || typeof p.key !== "string") {
        return { ok: false as const, code: "INVALID_PARAMS" as const, message: tmsg("msg.secret.keyRequired") };
      }
      const has = await invoke<boolean>("secret_has", { ns: p.ns, key: p.key });
      return { has };
    },
  });

  register("secret.keys", {
    description: tmsg("cmd.secret.keys.desc"),
    triggers: { ko: "시크릿 목록 키 리스트 조회" },
    params: { ns: NS_PARAM },
    // The answer comes from the owner — identical whichever window runs it (registry.ts windowScoped).
    windowScoped: false,
    returns: "{ keys: string[] }",
    message: (d) => tmsg("msg.secret.keys", { n: ((d.keys as unknown[]) ?? []).length }),
    errors: ["INVALID_PARAMS", "INTERNAL"],
    examples: ['secret.keys \'{"ns":"soksak-plugin-<id>"}\''],
    handler: async (p) => {
      if (typeof p.ns !== "string") {
        return { ok: false as const, code: "INVALID_PARAMS" as const, message: tmsg("msg.secret.nsRequired") };
      }
      const keys = await invoke<string[]>("secret_keys", { ns: p.ns });
      return { keys };
    },
  });

  register("secret.remove", {
    description: tmsg("cmd.secret.remove.desc"),
    triggers: { ko: "시크릿 삭제 제거 지우기 delete" },
    params: { ns: NS_PARAM, key: KEY_PARAM },
    returns: "{ removed }",
    message: (d) => d.removed ? tmsg("msg.secret.remove.removed") : tmsg("msg.secret.remove.absent"),
    danger: "destructive",
    errors: ["INVALID_PARAMS", "INTERNAL"],
    examples: ['secret.remove \'{"ns":"soksak-plugin-<id>","key":"anthropicKey"}\''],
    handler: async (p) => {
      if (typeof p.ns !== "string" || typeof p.key !== "string") {
        return { ok: false as const, code: "INVALID_PARAMS" as const, message: tmsg("msg.secret.keyRequired") };
      }
      const removed = await invoke<boolean>("secret_delete", { ns: p.ns, key: p.key });
      return { removed };
    },
  });
}
