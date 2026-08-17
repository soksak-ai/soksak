// net.* network commands — exposes core generic capabilities via the command registry (single source of truth).
// net.udp.send: send a UDP datagram to any host:port (delegates to net_udp_send core executor).
// net.udp.request: send UDP and collect responses on the same socket (SSDP / mDNS / DNS).
// net.http.request: arbitrary-origin HTTP request (delegates to net_http_request — runbook api type).
// Webview JS cannot do raw UDP or cross-origin HTTP; the core is the only path. Zero domain lock-in (generic).

import { invoke } from "../framework";
import { tmsg, key} from "../i18n";
import { register } from "./registry";

// hex string → byte array. Requires even length + [0-9a-fA-F] only; returns null otherwise (caller emits INVALID_PARAMS).
function hexToBytes(hex: string): number[] | null {
  const s = hex.trim().replace(/\s+/g, "");
  if (s.length === 0 || s.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(s)) return null;
  const out: number[] = [];
  for (let i = 0; i < s.length; i += 2) out.push(parseInt(s.slice(i, i + 2), 16));
  return out;
}

function bytesToHex(bytes: number[]): string {
  return bytes.map((b) => (b & 0xff).toString(16).padStart(2, "0")).join("");
}

// bytes → UTF-8 text (lets plugins parse SSDP/HTTP-like responses directly). Returns empty string on decode failure.
function bytesToText(bytes: number[]): string {
  try {
    return new TextDecoder().decode(new Uint8Array(bytes));
  } catch {
    return "";
  }
}

interface CoreUdpPacket {
  address: string;
  port: number;
  data: number[];
}

export function registerNetworkCatalog(): void {
  register("net.udp.send", {
    description: key("cmd.net.udp.send.desc"),
    triggers: { ko: "UDP 전송 네트워크 브로드캐스트 WOL" },
    params: {
      host: {
        type: "string",
        description: key("cmd.net.udp.send.param.host"),
        required: true,
      },
      port: { type: "number", description: key("cmd.net.udp.send.param.port"), required: true },
      data: {
        type: "string",
        description: key("cmd.net.udp.send.param.data"),
        required: true,
      },
      broadcast: { type: "boolean", description: key("cmd.net.udp.send.param.broadcast") },
    },
    // The answer comes from the owner — identical in every window (registry.ts windowScoped).
    windowScoped: false,
    returns: "{ bytesSent }",
    message: (d) => tmsg("msg.net.udp.send", { n: Number(d.bytesSent) }),
    danger: "inject",
    errors: ["INVALID_PARAMS", "INTERNAL"],
    examples: [
      'net.udp.send \'{"host":"255.255.255.255","port":9,"data":"ffffffffffff","broadcast":true}\'',
    ],
    handler: async (p) => {
      const bytes = hexToBytes(p.data as string);
      if (!bytes) {
        return {
          ok: false as const,
          code: "INVALID_PARAMS" as const,
          message: tmsg("msg.net.udp.dataHex"),
        };
      }
      const bytesSent = await invoke<number>("net_udp_send", {
        host: p.host,
        port: p.port,
        data: bytes,
        broadcast: (p.broadcast as boolean | undefined) ?? null,
      });
      return { bytesSent };
    },
  });

  register("net.udp.request", {
    description: key("cmd.net.udp.request.desc"),
    triggers: { ko: "UDP 요청 SSDP mDNS 디스커버리 네트워크검색" },
    params: {
      host: {
        type: "string",
        description: key("cmd.net.udp.request.param.host"),
        required: true,
      },
      port: { type: "number", description: key("cmd.net.udp.request.param.port"), required: true },
      data: { type: "string", description: key("cmd.net.udp.request.param.data"), required: true },
      timeoutMs: { type: "number", description: key("cmd.net.udp.request.param.timeoutMs") },
      maxPackets: { type: "number", description: key("cmd.net.udp.request.param.maxPackets") },
    },
    // The answer comes from the owner — identical in every window (registry.ts windowScoped).
    windowScoped: false,
    returns: "{ packets: [{ address, port, data(hex), text }] }",
    message: (d) => tmsg("msg.net.udp.request", { n: ((d.packets as unknown[]) ?? []).length }),
    danger: "inject",
    errors: ["INVALID_PARAMS", "INTERNAL"],
    examples: [
      'net.udp.request \'{"host":"239.255.255.250","port":1900,"data":"...","timeoutMs":3000}\'',
    ],
    handler: async (p) => {
      const bytes = hexToBytes(p.data as string);
      if (!bytes) {
        return {
          ok: false as const,
          code: "INVALID_PARAMS" as const,
          message: tmsg("msg.net.udp.dataHex"),
        };
      }
      const raw = await invoke<CoreUdpPacket[]>("net_udp_request", {
        host: p.host,
        port: p.port,
        data: bytes,
        timeoutMs: (p.timeoutMs as number | undefined) ?? null,
        maxPackets: (p.maxPackets as number | undefined) ?? null,
      });
      const packets = raw.map((pk) => ({
        address: pk.address,
        port: pk.port,
        data: bytesToHex(pk.data),
        text: bytesToText(pk.data),
      }));
      return { packets };
    },
  });

  register("net.http.request", {
    description: key("cmd.net.http.request.desc"),
    triggers: { ko: "HTTP 요청 API호출 웹요청 GET POST 임퍼소네이션 핑거프린트" },
    params: {
      method: { type: "string", description: key("cmd.net.http.request.param.method"), required: true },
      url: { type: "string", description: key("cmd.net.http.request.param.url"), required: true },
      headers: { type: "json", description: key("cmd.net.http.request.param.headers") },
      query: { type: "json", description: key("cmd.net.http.request.param.query") },
      body: { type: "string", description: key("cmd.net.http.request.param.body") },
      contentType: { type: "string", description: key("cmd.net.http.request.param.contentType") },
      ns: { type: "string", description: key("cmd.net.http.request.param.ns") },
      secretSubst: {
        type: "json",
        description: key("cmd.net.http.request.param.secretSubst"),
      },
      impersonate: {
        type: "string",
        description: key("cmd.net.http.request.param.impersonate"),
      },
    },
    // The answer comes from the owner — identical in every window (registry.ts windowScoped).
    windowScoped: false,
    returns: "{ status, headers, body }",
    message: (d) => tmsg("msg.net.http.request", { status: Number(d.status) }),
    danger: "inject",
    errors: ["INVALID_PARAMS", "INTERNAL"],
    examples: [
      'net.http.request \'{"method":"GET","url":"https://api.example.com/v1/ping"}\'',
      'net.http.request \'{"method":"GET","url":"https://blocked.example.com","impersonate":"chrome"}\'',
    ],
    handler: async (p) => {
      if (typeof p.method !== "string" || typeof p.url !== "string") {
        return { ok: false as const, code: "INVALID_PARAMS" as const, message: tmsg("msg.net.http.methodUrlRequired") };
      }
      return await invoke<{ status: number; headers: Record<string, string>; body: string }>(
        "net_http_request",
        {
          method: p.method,
          url: p.url,
          headers: (p.headers as Record<string, string> | undefined) ?? null,
          query: (p.query as Record<string, string> | undefined) ?? null,
          body: (p.body as string | undefined) ?? null,
          contentType: (p.contentType as string | undefined) ?? null,
          ns: (p.ns as string | undefined) ?? null,
          secretSubst: (p.secretSubst as Record<string, string> | undefined) ?? null,
          impersonate: (p.impersonate as string | undefined) ?? null,
        },
      );
    },
  });
}
