// plugin.implementers — L2 계약-핀(C3) 발견 커맨드 통합. 첫 소비자 시나리오(수용 기준):
// 같은 계약을 implements 한 픽스처 플러그인 2개 → 발견 커맨드가 둘 다 반환한다.
// 발견은 구현체 무차별 — 소비자는 계약 id 로만 찾고 플러그인 id 를 하드코딩하지 않는다(L1 금지).
import { beforeEach, describe, expect, it, vi } from "vitest";

// catalog 가 import 시 settings(localStorage)를 참조할 수 있어 stub 을 먼저.
const mem = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => mem.clear(),
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => undefined),
}));

import { registerPluginCatalog } from "./catalogPlugins";
import { execute, getSpec } from "./registry";
import { usePlugins, type PluginRuntime } from "../state/plugins";
import { parseManifest } from "../plugins/spec";

registerPluginCatalog();

// 픽스처 런타임 — 실 스키마 게이트(parseManifest)를 통과시킨다(implements 는 스펙이 검증하는 필드).
function fixtureRuntime(
  id: string,
  implementsIds: string[],
  status: PluginRuntime["status"] = "enabled",
): PluginRuntime {
  const { manifest, validation } = parseManifest(
    {
      spec: "soksak-plugin-spec@1",
      id,
      name: "픽스처",
      version: "1.0.0",
      description: "계약 픽스처",
      permissions: [],
      ...(implementsIds.length > 0 ? { implements: implementsIds } : {}),
    },
    id,
  );
  if (!manifest) throw new Error(`픽스처 매니페스트 불량: ${validation.errors.join("; ")}`);
  return { manifest, dir: `/tmp/${id}`, source: "dev", status };
}

const ALPHA = "soksak-plugin-fixture-alpha";
const BETA = "soksak-plugin-fixture-beta";
const GAMMA = "soksak-plugin-fixture-gamma";

beforeEach(() => {
  usePlugins.setState({
    plugins: {
      [ALPHA]: fixtureRuntime(ALPHA, ["fixture-notes-spec@1"]),
      [BETA]: fixtureRuntime(BETA, ["fixture-notes-spec@1", "fixture-board-spec@2"]),
      [GAMMA]: fixtureRuntime(GAMMA, []),
    },
  });
});

describe("plugin.implementers — 등록(발견성)", () => {
  it("영문 description·contract 파라미터·examples 를 선언한다(카탈로그 관례)", () => {
    const spec = getSpec("plugin.implementers");
    expect(spec).toBeDefined();
    expect(spec!.params.contract).toBeDefined();
    expect(spec!.params.contract.required).not.toBe(true); // 생략 = 전체 계약 지도
    expect(spec!.examples?.length).toBeGreaterThan(0);
  });
});

describe("plugin.implementers — 계약 지정 발견", () => {
  it("[수용 기준] 같은 계약을 선언한 픽스처 2개를 둘 다 반환한다", async () => {
    const r = (await execute("plugin.implementers", { contract: "fixture-notes-spec@1" }, {})) as unknown as {
      ok: boolean;
      data: { contract: string; implementers: { id: string; version: string; status: string }[] };
    };
    expect(r.ok).toBe(true);
    expect(r.data.contract).toBe("fixture-notes-spec@1");
    expect(r.data.implementers.map((i) => i.id)).toEqual([ALPHA, BETA]);
    expect(r.data.implementers[0]).toEqual({ id: ALPHA, version: "1.0.0", status: "enabled" });
  });

  it("판까지 정확 일치 — @1 조회는 @2 선언을 잡지 않는다", async () => {
    const r = (await execute("plugin.implementers", { contract: "fixture-board-spec@1" }, {})) as unknown as {
      data: { implementers: unknown[] };
    };
    expect(r.data.implementers).toEqual([]);
  });

  it("contract 생략 → 선언된 전체 계약 지도", async () => {
    const r = (await execute("plugin.implementers", {}, {})) as unknown as {
      ok: boolean;
      data: { contracts: { contract: string; implementers: string[] }[] };
    };
    expect(r.ok).toBe(true);
    expect(r.data.contracts).toEqual([
      { contract: "fixture-board-spec@2", implementers: [BETA] },
      { contract: "fixture-notes-spec@1", implementers: [ALPHA, BETA] },
    ]);
  });

  it("계약 id 문법 위반 파라미터 → INVALID_PARAMS(문법을 답에 알려준다)", async () => {
    const r = (await execute("plugin.implementers", { contract: "not-a-contract" }, {})) as unknown as {
      ok: boolean;
      code: string;
      message: string;
    };
    expect(r.ok).toBe(false);
    expect(r.code).toBe("INVALID_PARAMS");
    expect(r.message).toContain("<scope>-spec@<major>");
  });
});

describe("plugin.conformance — implements 절", () => {
  it("선언 목록과 generic 위반(현행 픽스처는 0)을 보고한다", async () => {
    const r = (await execute("plugin.conformance", { id: BETA }, {})) as unknown as {
      ok: boolean;
      data: { implements: { declared: string[]; violations: unknown[] } };
    };
    expect(r.ok).toBe(true);
    expect(r.data.implements.declared).toEqual([
      "fixture-notes-spec@1",
      "fixture-board-spec@2",
    ]);
    expect(r.data.implements.violations).toEqual([]);
  });
});
