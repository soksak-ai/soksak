// 프리픽스(sok/sok-dev/sok-debug)는 데이터가 아니라 표시자의 정체성이다. 카탈로그 예제와 런타임
// 힌트는 명령 형태만 담고, 이 앱의 CLI 이름은 표시 지점에서 붙는다. 그 계약을 두 축으로 가둔다:
//  (1) 어떤 카탈로그 예제도 바이너리 토큰으로 시작하지 않는다 — 재발 가드(다중-env 나열 부활 차단).
//  (2) 응답 힌트는 실행 시 이 앱의 CLI 이름으로 stamp 된다 — dev 앱의 제안은 sok-dev 로 실행돼야
//      dev 소켓에 닿는다.
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { catalogJson, execute } from "./registry";
import { registerCatalog } from "./catalog";
import { registerDebugCatalog } from "./catalogDebug";
import { registerOrchestratorCatalog } from "./catalogOrchestrator";
import { registerRemoteCatalog } from "./catalogRemote";
import { registerRemoteConfirmDevCatalog } from "./catalogRemoteConfirmDev";
import { __setCliNameForTest, cliName } from "../lib/cliIdentity";

// 첫 토큰이 정확히 sok / sok-dev / sok-debug 인 경우만 — soksak-* 같은 다른 이름·문중 등장은 제외.
const LEADING_BIN = /^sok(-dev|-debug)?( |$)/;

beforeAll(() => {
  // executor.startExecutor 와 같은 등록 시퀀스 — 전 코어 표면(+dev·orchestrator)을 카탈로그에 올린다.
  registerCatalog();
  registerRemoteCatalog();
  registerRemoteConfirmDevCatalog();
  registerDebugCatalog();
  registerOrchestratorCatalog();
});

describe("CLI 프리픽스 = 표시자 정체성 (데이터 아님)", () => {
  it("어떤 카탈로그 예제도 바이너리 토큰으로 시작하지 않는다", () => {
    const offenders: string[] = [];
    for (const spec of catalogJson()) {
      for (const ex of spec.examples) {
        if (LEADING_BIN.test(ex)) offenders.push(`${spec.name}: ${ex}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("기본 CLI 이름은 sok (부팅 로드 전·비-Tauri 폴백)", () => {
    expect(cliName()).toBe("sok");
  });
});

describe("런타임 힌트는 이 앱 CLI 이름으로 stamp", () => {
  afterEach(() => __setCliNameForTest("sok"));

  it("표준 오류 힌트가 이 앱 이름 프리픽스로 나온다", async () => {
    __setCliNameForTest("sok-dev");
    // 미지 명령 → UNKNOWN_COMMAND → 표준 안내 힌트(형태-only)가 중앙 지점에서 stamp 된다.
    const r = await execute("definitely.not.a.real.command", {}, {});
    expect(r.ok).toBe(false);
    expect(r.hint?.length ?? 0).toBeGreaterThan(0);
    for (const h of r.hint ?? []) {
      expect(h.cmd.startsWith("sok-dev ")).toBe(true);
    }
  });

  it("release 앱(sok)에서는 같은 힌트가 sok 프리픽스", async () => {
    __setCliNameForTest("sok");
    const r = await execute("definitely.not.a.real.command", {}, {});
    for (const h of r.hint ?? []) {
      expect(h.cmd.startsWith("sok ")).toBe(true);
      expect(h.cmd.startsWith("sok-")).toBe(false);
    }
  });
});
