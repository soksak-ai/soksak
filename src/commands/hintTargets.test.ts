// hint 대상 부패 게이트 — 전 카탈로그(코어+플러그인 관리+원격)의 spec.hint 를 성공/실패 형태로
// 직접 호출해, 나온 cmd 문자열의 "sok " 다음 첫 토큰이 실재하는 대상을 가리키는지 단언한다.
// hint 는 가능성의 제시다(제시 철학) — 제시가 가리키는 목적지가 죽어 있으면 그 자체가 거짓 안내가
// 된다. 명령 개명·삭제 시 그 명령을 겨냥한 hint 가 남아 있으면 이 게이트가 즉시 실패한다.

import { describe, expect, it, vi } from "vitest";

// catalog 가 import 시 zustand persist 미들웨어를 거쳐 localStorage 를 참조한다(layoutApply.test 등과 동일 stub).
const mem = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => mem.clear(),
});

import { registerCatalog } from "./catalog";
import { registerRemoteCatalog } from "./catalogRemote";
import { catalogJson, getSpec, type CommandHint } from "./registry";

registerCatalog(); // 코어 + plugin.* + ui.* + dom.* 전부(registerPluginCatalog/registerDomCatalog 포함).
registerRemoteCatalog(); // remote.confirm — registerCatalog() 밖에서 별도 등록되는 명령.

const ALL_NAMES = new Set(catalogJson().map((c) => c.name));

// ② CLI 가 레지스트리 없이 직접 처리하는 최상위 보조 서브커맨드/플래그.
const CLI_AUX = new Set(["commands", "help", "docs", "--window"]);

// hint 를 성공형/실패형 여러 데이터로 확률(probe)한다. CONSENT_REQUIRED 는 plugin.enable 의
// message 파싱 분기를 함께 태운다(파싱 성공 시 정밀 cmd, 실패 시 빈 배열 폴백 — 둘 다 안전해야 함).
const PROBE_DATA: Record<string, unknown>[] = [
  {},
  { code: "TARGET_NOT_FOUND", message: "대상 없음" },
  { code: "INVALID_PARAMS", message: "잘못된 값" },
  {
    code: "CONSENT_REQUIRED",
    message:
      "활성화 동의 필요: soksak-plugin-x, soksak-plugin-y — 종속 먼저 순서로 동의가 필요합니다",
  },
];

// "sok " 다음 첫 토큰 — 명령 이름 또는 CLI 보조 서브커맨드/플래그.
function firstToken(cmd: string): string | null {
  const m = /^sok\s+(\S+)/.exec(cmd.trim());
  return m ? m[1] : null;
}

describe("hint 대상 부패 게이트", () => {
  it("모든 spec.hint 의 cmd 가 ①실재 명령 ②CLI 보조 서브커맨드 ③plugin.동적 이름 중 하나를 가리킨다", () => {
    const offenders: string[] = [];
    for (const name of ALL_NAMES) {
      const spec = getSpec(name);
      if (!spec?.hint) continue; // hint 미선언 스펙은 대상 아님.
      for (const data of PROBE_DATA) {
        let hints: CommandHint[];
        try {
          hints = spec.hint(data, {});
        } catch {
          continue; // 예외는 이 확률형에서 그 스펙만 건너뛴다(§ registry.execute 와 동일 관용).
        }
        for (const h of hints) {
          const token = firstToken(h.cmd);
          if (!token) continue; // "sok " 로 시작하지 않는 cmd 는 이 게이트 대상이 아니다.
          const known =
            ALL_NAMES.has(token) || CLI_AUX.has(token) || token.startsWith("plugin.");
          if (!known) offenders.push(`${name} → "${h.cmd}"(토큰 "${token}")`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("코어 명령 전부가 hint 없이도 최소 하나의 probe 로 예외 없이 호출된다", () => {
    // hint 자체가 던지는 예외는 위 게이트에서 조용히 건너뛰지만, 그 스펙을 실측 없이 전부
    // 무시하면 게이트가 공허해진다 — 최소한 하나는 안전 경로(성공형 {})로 통과해야 한다.
    const alwaysThrows: string[] = [];
    for (const name of ALL_NAMES) {
      const spec = getSpec(name);
      if (!spec?.hint) continue;
      let allThrew = true;
      for (const data of PROBE_DATA) {
        try {
          spec.hint(data, {});
          allThrew = false;
        } catch {
          /* 다음 probe 시도 */
        }
      }
      if (allThrew) alwaysThrows.push(name);
    }
    expect(alwaysThrows).toEqual([]);
  });
});
