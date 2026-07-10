// secret.* commands — exposes the encrypted secret vault (Rust SecretsState) through command registry
// (single source of truth). Covers CLI/MCP e2e self-verification: vault ops (unlock/lock/backend)
// + ns·key management (set/has/keys/delete).
//
// No get command — the core blocks plaintext readback (secretRef injection via 2b is the only plaintext path).
// All management commands delegate to invoke (vault/crypto are Rust single source of truth).
// Headless e2e opens the vault via SOKSAK_VAULT_KEY auto-unlock or secret.unlock.

import { invoke } from "@tauri-apps/api/core";
import { register } from "./registry";
import { tmsg } from "../i18n";

const NS_PARAM = {
  type: "string",
  description: "Namespace (plugin id or core)",
  required: true,
} as const;

const KEY_PARAM = {
  type: "string",
  description: "Secret key name (alphanumeric, -, _, .)",
  required: true,
} as const;

export function registerSecretsCatalog(): void {
  register("secret.unlock", {
    description:
      "Unlock the secret vault with a master passphrase (creates a new vault if one does not exist). Keeps the KEK in memory only — only ciphertext is on disk. For headless use, set SOKSAK_VAULT_KEY env to auto-unlock.",
    triggers: { ko: "시크릿 볼트 열기 잠금해제 unlock 마스터키" },
    params: { passphrase: { type: "string", description: "Master passphrase for the vault", required: true } },
    returns: "{ ok }",
    message: () => tmsg("msg.secret.unlock"),
    danger: "inject",
    errors: ["INVALID_PARAMS", "INTERNAL"],
    examples: ['sok secret.unlock \'{"passphrase":"correct horse battery staple"}\''],
    handler: async (p) => {
      if (typeof p.passphrase !== "string" || !p.passphrase) {
        return { ok: false as const, code: "INVALID_PARAMS" as const, message: "passphrase 필요" };
      }
      await invoke("secret_unlock", { passphrase: p.passphrase });
      return { ok: true };
    },
  });

  register("secret.lock", {
    description: "Lock the secret vault by zeroing the in-memory KEK. All subsequent operations are rejected until unlock is called again.",
    triggers: { ko: "시크릿 볼트 잠금 lock 닫기" },
    params: {},
    returns: "{ ok }",
    message: () => tmsg("msg.secret.lock"),
    errors: ["INTERNAL"],
    examples: ["sok secret.lock"],
    handler: async () => {
      await invoke("secret_lock");
      return { ok: true };
    },
  });

  register("secret.autolock", {
    description:
      "Set the idle auto-lock timeout in milliseconds (0 disables). When the vault stays idle past this, it locks itself and broadcasts secrets-locked to every window. Activity resets the timer via secret_touch.",
    triggers: { ko: "자동잠금 유휴잠금 오토락 잠금시간" },
    params: { ms: { type: "number", description: "Idle timeout in milliseconds; 0 disables auto-lock", required: true } },
    returns: "{ ms }",
    message: (d) => Number(d.ms) > 0 ? tmsg("msg.secret.autolock.on", { ms: Number(d.ms) }) : tmsg("msg.secret.autolock.off"),
    errors: ["INVALID_PARAMS"],
    examples: ['sok secret.autolock \'{"ms":300000}\''],
    handler: async (p) => {
      const ms = typeof p.ms === "number" ? p.ms : Number(p.ms);
      if (!Number.isFinite(ms) || ms < 0) {
        return { ok: false as const, code: "INVALID_PARAMS" as const, message: "ms 는 0 이상 숫자" };
      }
      await invoke("secret_autolock", { ms: Math.floor(ms) });
      return { ms: Math.floor(ms) };
    },
  });

  register("secret.backend", {
    description: "Query the vault backend type and current lock state. Use to check whether the vault is open before performing secret operations.",
    triggers: { ko: "시크릿 볼트 상태 백엔드 잠금여부" },
    params: {},
    returns: "{ backend, unlocked }",
    message: (d) => d.unlocked ? tmsg("msg.secret.backend.unlocked", { backend: String(d.backend) }) : tmsg("msg.secret.backend.locked", { backend: String(d.backend) }),
    errors: ["INTERNAL"],
    examples: ["sok secret.backend"],
    handler: async () => {
      return await invoke<{ backend: string; unlocked: boolean }>("secret_backend");
    },
  });

  register("secret.set", {
    description:
      "Store a sensitive value under ns/key using envelope encryption (per-item DEK wrapped by the KEK). Overwrites the existing value if the key already exists. Rejected if the vault is locked.",
    triggers: { ko: "시크릿 저장 설정 키 값 저장 set 보관" },
    params: { ns: NS_PARAM, key: KEY_PARAM, value: { type: "string", description: "Sensitive value to store", required: true } },
    returns: "{ ok }",
    message: () => tmsg("msg.secret.set"),
    danger: "inject",
    errors: ["INVALID_PARAMS", "INTERNAL"],
    examples: ['sok secret.set \'{"ns":"soksak-plugin-<id>","key":"anthropicKey","value":"sk-ant-..."}\''],
    handler: async (p) => {
      if (typeof p.ns !== "string" || typeof p.key !== "string" || typeof p.value !== "string") {
        return { ok: false as const, code: "INVALID_PARAMS" as const, message: "ns·key·value 필요" };
      }
      await invoke("secret_set", { ns: p.ns, key: p.key, value: p.value });
      return { ok: true };
    },
  });

  register("secret.has", {
    description: "Check whether ns/key exists in the vault without exposing the value (plaintext readback is blocked by the core).",
    triggers: { ko: "시크릿 존재 확인 있는지 has 체크" },
    params: { ns: NS_PARAM, key: KEY_PARAM },
    returns: "{ has }",
    message: (d) => d.has ? tmsg("msg.secret.has.present") : tmsg("msg.secret.has.absent"),
    errors: ["INVALID_PARAMS", "INTERNAL"],
    examples: ['sok secret.has \'{"ns":"soksak-plugin-<id>","key":"anthropicKey"}\''],
    handler: async (p) => {
      if (typeof p.ns !== "string" || typeof p.key !== "string") {
        return { ok: false as const, code: "INVALID_PARAMS" as const, message: "ns·key 필요" };
      }
      const has = await invoke<boolean>("secret_has", { ns: p.ns, key: p.key });
      return { has };
    },
  });

  register("secret.keys", {
    description: "List the secret key names stored under a namespace (values are never returned). Use to audit what is stored in a namespace.",
    triggers: { ko: "시크릿 목록 키 리스트 조회" },
    params: { ns: NS_PARAM },
    returns: "{ keys: string[] }",
    message: (d) => tmsg("msg.secret.keys", { n: ((d.keys as unknown[]) ?? []).length }),
    errors: ["INVALID_PARAMS", "INTERNAL"],
    examples: ['sok secret.keys \'{"ns":"soksak-plugin-<id>"}\''],
    handler: async (p) => {
      if (typeof p.ns !== "string") {
        return { ok: false as const, code: "INVALID_PARAMS" as const, message: "ns 필요" };
      }
      const keys = await invoke<string[]>("secret_keys", { ns: p.ns });
      return { keys };
    },
  });

  register("secret.remove", {
    description: "Remove ns/key from the vault (removed=true if the key existed). Rejected if the vault is locked.",
    triggers: { ko: "시크릿 삭제 제거 지우기 delete" },
    params: { ns: NS_PARAM, key: KEY_PARAM },
    returns: "{ removed }",
    message: (d) => d.removed ? tmsg("msg.secret.remove.removed") : tmsg("msg.secret.remove.absent"),
    danger: "destructive",
    errors: ["INVALID_PARAMS", "INTERNAL"],
    examples: ['sok secret.remove \'{"ns":"soksak-plugin-<id>","key":"anthropicKey"}\''],
    handler: async (p) => {
      if (typeof p.ns !== "string" || typeof p.key !== "string") {
        return { ok: false as const, code: "INVALID_PARAMS" as const, message: "ns·key 필요" };
      }
      const removed = await invoke<boolean>("secret_delete", { ns: p.ns, key: p.key });
      return { removed };
    },
  });
}
