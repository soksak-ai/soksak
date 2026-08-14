// net.udp.send contract test — registration/danger/params, and hex decode before delegating to
// the core invoke. Tauri invoke is mocked.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("../framework", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../framework")>()),
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

describe("net.udp.send registration", () => {
  it("declares danger:inject and requires host/port/data", () => {
    const spec = getSpec("net.udp.send");
    expect(spec).toBeDefined();
    expect(spec!.danger).toBe("inject");
    expect(spec!.params.host.required).toBe(true);
    expect(spec!.params.port.required).toBe(true);
    expect(spec!.params.data.required).toBe(true);
  });
});

describe("net.udp.send execution", () => {
  it("decodes hex data into a byte array and calls net_udp_send", async () => {
    invoke.mockResolvedValueOnce(3);
    const r = await execute(
      "net.udp.send",
      { host: "255.255.255.255", port: 9, data: "ff0102", broadcast: true },
      {},
    );
    expect(r).toEqual({ ok: true, code: "OK", message: tmsg("msg.net.udp.send", { n: 3 }), data: { bytesSent: 3 }, window: "" });
    expect(invoke).toHaveBeenCalledWith("net_udp_send", {
      host: "255.255.255.255",
      port: 9,
      data: [255, 1, 2],
      broadcast: true,
    });
  });

  it("passes null when broadcast is omitted", async () => {
    invoke.mockResolvedValueOnce(2);
    await execute("net.udp.send", { host: "127.0.0.1", port: 9, data: "00ff" }, {});
    expect(invoke).toHaveBeenCalledWith("net_udp_send", {
      host: "127.0.0.1",
      port: 9,
      data: [0, 255],
      broadcast: null,
    });
  });

  it("refuses odd-length or non-hex data with INVALID_PARAMS (invoke is not called)", async () => {
    const r = await execute("net.udp.send", { host: "127.0.0.1", port: 9, data: "xyz" }, {});
    expect(r).toMatchObject({ ok: false, code: "INVALID_PARAMS" });
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("net.udp.request registration and execution", () => {
  it("declares danger:inject and requires host/port/data", () => {
    const spec = getSpec("net.udp.request");
    expect(spec).toBeDefined();
    expect(spec!.danger).toBe("inject");
    expect(spec!.params.host.required).toBe(true);
    expect(spec!.params.port.required).toBe(true);
    expect(spec!.params.data.required).toBe(true);
  });

  it("sends hex and returns the response packet data as hex (delegated to the core)", async () => {
    // The core returns raw byte-array packets; convert them to a hex string and return.
    invoke.mockResolvedValueOnce([
      { address: "192.168.0.10", port: 1900, data: [72, 73] }, // "HI"
    ]);
    const r = await execute(
      "net.udp.request",
      { host: "239.255.255.250", port: 1900, data: "4d2d", timeoutMs: 800 },
      {},
    );
    expect(invoke).toHaveBeenCalledWith("net_udp_request", {
      host: "239.255.255.250",
      port: 1900,
      data: [0x4d, 0x2d],
      timeoutMs: 800,
      maxPackets: null,
    });
    expect(r).toEqual({
      ok: true,
      code: "OK",
      message: tmsg("msg.net.udp.request", { n: 1 }),
      data: { packets: [{ address: "192.168.0.10", port: 1900, data: "4849", text: "HI" }] },
      window: "",
    });
  });

  it("refuses odd-length or non-hex data with INVALID_PARAMS (invoke is not called)", async () => {
    const r = await execute("net.udp.request", { host: "127.0.0.1", port: 9, data: "zz" }, {});
    expect(r).toMatchObject({ ok: false, code: "INVALID_PARAMS" });
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("net.http.request registration and impersonate wiring", () => {
  it("declares danger:inject, requires method/url, and declares the impersonate parameter", () => {
    const spec = getSpec("net.http.request");
    expect(spec).toBeDefined();
    expect(spec!.danger).toBe("inject");
    expect(spec!.params.method.required).toBe(true);
    expect(spec!.params.url.required).toBe(true);
    // The impersonate toggle is exposed in the schema (absent = off — optional, so not required).
    expect(spec!.params.impersonate).toBeDefined();
    expect(spec!.params.impersonate.required).toBeFalsy();
  });

  it("passes null (= the off backend) when impersonate is omitted", async () => {
    invoke.mockResolvedValueOnce({ status: 200, headers: {}, body: "ok" });
    await execute("net.http.request", { method: "GET", url: "https://api.example/x" }, {});
    expect(invoke).toHaveBeenCalledWith("net_http_request", {
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

  it('passes impersonate:"chrome" straight to the core (selects the impersonation backend)', async () => {
    invoke.mockResolvedValueOnce({ status: 200, headers: {}, body: "ok" });
    await execute(
      "net.http.request",
      { method: "GET", url: "https://blocked.example", impersonate: "chrome" },
      {},
    );
    expect(invoke).toHaveBeenCalledWith(
      "net_http_request",
      expect.objectContaining({ impersonate: "chrome" }),
    );
  });
});
