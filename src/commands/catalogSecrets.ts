// secret.* 명령 — 암호화 시크릿 볼트(Rust SecretsState)의 코어 표면을 command registry 로 노출
// (단일 진실). CLI/MCP e2e 자가검증용 — unlock/lock/backend 운영 + ns·key 관리(set/has/keys/delete).
//
// get 명령 없음 — 평문 readback 을 코어가 차단한다(2b 의 secretRef 주입만이 평문 경로). 관리 명령은
// 전부 invoke 위임(볼트·crypto 는 Rust 단일 진실). 헤드리스 e2e 는 SOKSAK_VAULT_KEY 자동 unlock 또는
// secret.unlock 으로 연다.

import { invoke } from "@tauri-apps/api/core";
import { register } from "./registry";

const NS_PARAM = {
  type: "string",
  description: "네임스페이스(플러그인 id 또는 core)",
  required: true,
} as const;

const KEY_PARAM = {
  type: "string",
  description: "시크릿 key(영숫자·-·_·.)",
  required: true,
} as const;

export function registerSecretsCatalog(): void {
  register("secret.unlock", {
    description:
      "마스터 passphrase 로 시크릿 볼트 열기(없으면 새 볼트 생성). KEK 를 메모리에만 보관 — 디스크엔 암호문만. 헤드리스는 SOKSAK_VAULT_KEY env 로 자동 unlock",
    params: { passphrase: { type: "string", description: "마스터 passphrase", required: true } },
    returns: "{ ok }",
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
    description: "시크릿 볼트 잠그기 — 메모리의 KEK 를 소거(zeroize). 이후 연산은 unlock 전까지 거부",
    params: {},
    returns: "{ ok }",
    errors: ["INTERNAL"],
    examples: ["sok secret.lock"],
    handler: async () => {
      await invoke("secret_lock");
      return { ok: true };
    },
  });

  register("secret.backend", {
    description: "볼트 백엔드·잠금 상태 조회({ backend:\"vault\", unlocked })",
    params: {},
    returns: "{ backend, unlocked }",
    errors: ["INTERNAL"],
    examples: ["sok secret.backend"],
    handler: async () => {
      return await invoke<{ backend: string; unlocked: boolean }>("secret_backend");
    },
  });

  register("secret.set", {
    description:
      "ns 의 key 에 민감값을 봉인 저장(envelope — 항목별 DEK 를 KEK 로 wrap). 같은 key 면 교체. 볼트가 잠겨 있으면 거부",
    params: { ns: NS_PARAM, key: KEY_PARAM, value: { type: "string", description: "저장할 민감값", required: true } },
    returns: "{ ok }",
    danger: "inject",
    errors: ["INVALID_PARAMS", "INTERNAL"],
    examples: ['sok secret.set \'{"ns":"soksak-plugin-acp","key":"anthropicKey","value":"sk-ant-..."}\''],
    handler: async (p) => {
      if (typeof p.ns !== "string" || typeof p.key !== "string" || typeof p.value !== "string") {
        return { ok: false as const, code: "INVALID_PARAMS" as const, message: "ns·key·value 필요" };
      }
      await invoke("secret_set", { ns: p.ns, key: p.key, value: p.value });
      return { ok: true };
    },
  });

  register("secret.has", {
    description: "ns 의 key 존재 여부(값은 노출하지 않음 — 평문 readback 차단)",
    params: { ns: NS_PARAM, key: KEY_PARAM },
    returns: "{ has }",
    errors: ["INVALID_PARAMS", "INTERNAL"],
    examples: ['sok secret.has \'{"ns":"soksak-plugin-acp","key":"anthropicKey"}\''],
    handler: async (p) => {
      if (typeof p.ns !== "string" || typeof p.key !== "string") {
        return { ok: false as const, code: "INVALID_PARAMS" as const, message: "ns·key 필요" };
      }
      const has = await invoke<boolean>("secret_has", { ns: p.ns, key: p.key });
      return { has };
    },
  });

  register("secret.keys", {
    description: "ns 의 시크릿 key 목록(값 아님). 무엇이 저장돼 있는지 점검용",
    params: { ns: NS_PARAM },
    returns: "{ keys: string[] }",
    errors: ["INVALID_PARAMS", "INTERNAL"],
    examples: ['sok secret.keys \'{"ns":"soksak-plugin-acp"}\''],
    handler: async (p) => {
      if (typeof p.ns !== "string") {
        return { ok: false as const, code: "INVALID_PARAMS" as const, message: "ns 필요" };
      }
      const keys = await invoke<string[]>("secret_keys", { ns: p.ns });
      return { keys };
    },
  });

  register("secret.delete", {
    description: "ns 의 key 삭제(있었으면 removed=true). 볼트가 잠겨 있으면 거부",
    params: { ns: NS_PARAM, key: KEY_PARAM },
    returns: "{ removed }",
    danger: "destructive",
    errors: ["INVALID_PARAMS", "INTERNAL"],
    examples: ['sok secret.delete \'{"ns":"soksak-plugin-acp","key":"anthropicKey"}\''],
    handler: async (p) => {
      if (typeof p.ns !== "string" || typeof p.key !== "string") {
        return { ok: false as const, code: "INVALID_PARAMS" as const, message: "ns·key 필요" };
      }
      const removed = await invoke<boolean>("secret_delete", { ns: p.ns, key: p.key });
      return { removed };
    },
  });
}
