// net.udp.send 계약 테스트 — 등록/danger/params + hex 디코드 후 코어 invoke 위임. Tauri invoke 는 mock.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...a: unknown[]) => invoke(...a),
}));

import { registerNetworkCatalog } from "./catalogNetwork";
import { execute, getSpec, unregister } from "./registry";

beforeEach(() => {
  invoke.mockClear();
  registerNetworkCatalog();
});
afterEach(() => {
  unregister("net.udp.send");
  unregister("net.udp.request");
  unregister("net.http.request");
});

describe("net.udp.send 등록", () => {
  it("danger:inject + host/port/data 필수 선언", () => {
    const spec = getSpec("net.udp.send");
    expect(spec).toBeDefined();
    expect(spec!.danger).toBe("inject");
    expect(spec!.params.host.required).toBe(true);
    expect(spec!.params.port.required).toBe(true);
    expect(spec!.params.data.required).toBe(true);
  });
});

describe("net.udp.send 실행", () => {
  it("hex data 를 바이트 배열로 디코드해 network_udp_send 호출", async () => {
    invoke.mockResolvedValueOnce(3);
    const r = await execute(
      "net.udp.send",
      { host: "255.255.255.255", port: 9, data: "ff0102", broadcast: true },
      {},
    );
    expect(r).toEqual({ ok: true, code: "OK", message: "OK", data: { bytesSent: 3 } });
    expect(invoke).toHaveBeenCalledWith("network_udp_send", {
      host: "255.255.255.255",
      port: 9,
      data: [255, 1, 2],
      broadcast: true,
    });
  });

  it("broadcast 생략 시 null 로 전달", async () => {
    invoke.mockResolvedValueOnce(2);
    await execute("net.udp.send", { host: "127.0.0.1", port: 9, data: "00ff" }, {});
    expect(invoke).toHaveBeenCalledWith("network_udp_send", {
      host: "127.0.0.1",
      port: 9,
      data: [0, 255],
      broadcast: null,
    });
  });

  it("홀수 길이/비-hex data 는 INVALID_PARAMS (invoke 미호출)", async () => {
    const r = await execute("net.udp.send", { host: "127.0.0.1", port: 9, data: "xyz" }, {});
    expect(r).toMatchObject({ ok: false, code: "INVALID_PARAMS" });
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("net.udp.request 등록/실행", () => {
  it("danger:inject + host/port/data 필수", () => {
    const spec = getSpec("net.udp.request");
    expect(spec).toBeDefined();
    expect(spec!.danger).toBe("inject");
    expect(spec!.params.host.required).toBe(true);
    expect(spec!.params.port.required).toBe(true);
    expect(spec!.params.data.required).toBe(true);
  });

  it("hex 송신 + 응답 패킷 data 를 hex 로 반환(코어 위임)", async () => {
    // 코어가 raw 바이트 배열 패킷을 주면, hex 문자열로 변환해 반환.
    invoke.mockResolvedValueOnce([
      { address: "192.168.0.10", port: 1900, data: [72, 73] }, // "HI"
    ]);
    const r = await execute(
      "net.udp.request",
      { host: "239.255.255.250", port: 1900, data: "4d2d", timeoutMs: 800 },
      {},
    );
    expect(invoke).toHaveBeenCalledWith("network_udp_request", {
      host: "239.255.255.250",
      port: 1900,
      data: [0x4d, 0x2d],
      timeoutMs: 800,
      maxPackets: null,
    });
    expect(r).toEqual({
      ok: true,
      code: "OK",
      message: "OK",
      data: { packets: [{ address: "192.168.0.10", port: 1900, data: "4849", text: "HI" }] },
    });
  });

  it("홀수 길이/비-hex data 는 INVALID_PARAMS (invoke 미호출)", async () => {
    const r = await execute("net.udp.request", { host: "127.0.0.1", port: 9, data: "zz" }, {});
    expect(r).toMatchObject({ ok: false, code: "INVALID_PARAMS" });
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("net.http.request 등록/impersonate 배선", () => {
  it("danger:inject + method/url 필수 + impersonate 파라미터 선언", () => {
    const spec = getSpec("net.http.request");
    expect(spec).toBeDefined();
    expect(spec!.danger).toBe("inject");
    expect(spec!.params.method.required).toBe(true);
    expect(spec!.params.url.required).toBe(true);
    // impersonate 토글이 스키마에 노출됨(없으면 off — 선택적이라 required 아님).
    expect(spec!.params.impersonate).toBeDefined();
    expect(spec!.params.impersonate.required).toBeFalsy();
  });

  it("impersonate 생략 시 null(=off 백엔드) 로 전달", async () => {
    invoke.mockResolvedValueOnce({ status: 200, headers: {}, body: "ok" });
    await execute("net.http.request", { method: "GET", url: "https://api.example/x" }, {});
    expect(invoke).toHaveBeenCalledWith("network_http_request", {
      method: "GET",
      url: "https://api.example/x",
      headers: null,
      query: null,
      body: null,
      contentType: null,
      ns: null,
      secretSubst: null,
      impersonate: null,
    });
  });

  it('impersonate:"chrome" 를 코어로 그대로 전달(위장 백엔드 선택)', async () => {
    invoke.mockResolvedValueOnce({ status: 200, headers: {}, body: "ok" });
    await execute(
      "net.http.request",
      { method: "GET", url: "https://blocked.example", impersonate: "chrome" },
      {},
    );
    expect(invoke).toHaveBeenCalledWith(
      "network_http_request",
      expect.objectContaining({ impersonate: "chrome" }),
    );
  });
});
