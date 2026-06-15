import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRegistry } from "./registry";
import { REGISTRY_SPEC } from "../plugins/registry";

function remoteJson(ids: string[]) {
  return {
    ok: true,
    json: async () => ({
      spec: REGISTRY_SPEC,
      plugins: ids.map((id) => ({
        id,
        name: id,
        version: "9.9.9",
        description: "원격",
        repo: `https://github.com/soksak-ai/${id}.git`,
      })),
    }),
  };
}

describe("useRegistry — fetch/머지/세션1회", () => {
  beforeEach(() => {
    // 매 테스트 store 초기화(스냅샷 상태로).
    useRegistry.setState({ status: "snapshot", fetchedOnce: false });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("스냅샷으로 즉시 표시(엔트리 존재)", () => {
    expect(useRegistry.getState().entries.length).toBeGreaterThanOrEqual(16);
    expect(useRegistry.getState().status).toBe("snapshot");
  });

  it("원격 성공 → live + 원격 목록 채택", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => remoteJson(["soksak-remote-only"])));
    await useRegistry.getState().refresh();
    expect(useRegistry.getState().status).toBe("live");
    expect(useRegistry.getState().entries.map((p) => p.id)).toEqual(["soksak-remote-only"]);
  });

  it("원격 실패 → error + 스냅샷 엔트리 유지", async () => {
    const before = useRegistry.getState().entries;
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    await useRegistry.getState().refresh();
    expect(useRegistry.getState().status).toBe("error");
    expect(useRegistry.getState().entries).toBe(before); // 불변
  });

  it("세션 1회 — 두 번째 refresh 는 skip, force 면 재시도", async () => {
    const fetchMock = vi.fn(async () => remoteJson(["a"]));
    vi.stubGlobal("fetch", fetchMock);
    await useRegistry.getState().refresh();
    await useRegistry.getState().refresh(); // skip(fetchedOnce)
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await useRegistry.getState().refresh(true); // force
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
