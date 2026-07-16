import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({
  invoke: vi.fn(async (..._a: unknown[]): Promise<unknown> => undefined),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...a: unknown[]) => invoke(...a),
}));

import { registerUnitDevCatalog } from "./catalogUnitDev";
import { execute, getSpec, unregister } from "./registry";
import { usePlugins } from "../state/plugins";

beforeEach(() => {
  invoke.mockReset();
  registerUnitDevCatalog();
});

afterEach(() => {
  for (const name of ["unit.dev.list", "unit.dev.set", "unit.dev.remove"]) unregister(name);
});

describe("unit.dev.* — 모든 core identity가 공유하는 개발 source 표면", () => {
  it("형태-only 예제를 노출하고 빈 config를 official로 보고", async () => {
    invoke.mockResolvedValueOnce([]);
    const spec = getSpec("unit.dev.list");
    // 예제는 명령 형태만 — 세 env 나열은 표시자(각 바이너리)가 자기 이름을 붙이므로 중복이었다.
    expect(spec?.examples).toEqual(["unit.dev.list"]);
    const r = await execute("unit.dev.list", {}, {});
    expect(r).toMatchObject({ ok: true, data: { unitMode: "official", units: [] } });
  });

  it("sidecar/kit source 선택은 generic core config에 위임", async () => {
    invoke.mockResolvedValueOnce({ kind: "kit", id: "browser-common", source: "/work/kit" });
    const r = await execute(
      "unit.dev.set",
      { kind: "kit", id: "browser-common", source: "/work/kit" },
      {},
    );
    expect(invoke).toHaveBeenCalledWith("unit_dev_set", {
      kind: "kit",
      id: "browser-common",
      source: "/work/kit",
    });
    expect(r).toMatchObject({ ok: true, data: { kind: "kit", id: "browser-common" } });
  });

  it("core 경로 검증 거부를 INVALID_PARAMS로 그대로 드러낸다", async () => {
    invoke.mockRejectedValueOnce(new Error("개발 source는 절대경로여야 합니다"));
    const r = await execute(
      "unit.dev.set",
      { kind: "sidecar", id: "speech", source: "relative/path" },
      {},
    );
    expect(r).toMatchObject({
      ok: false,
      code: "INVALID_PARAMS",
      message: expect.stringContaining("절대경로"),
    });
  });

  it("plugin source 해제 뒤 loader를 재계산해 공식 설치본 복귀를 반영", async () => {
    const reload = vi.fn(async () => {});
    usePlugins.setState({ reload });
    invoke.mockResolvedValueOnce(true);
    const r = await execute("unit.dev.remove", { kind: "plugin", id: "weather" }, {});
    expect(invoke).toHaveBeenCalledWith("unit_dev_remove", { kind: "plugin", id: "weather" });
    expect(reload).toHaveBeenCalledOnce();
    expect(r).toMatchObject({ ok: true, data: { removed: true } });
  });
});
