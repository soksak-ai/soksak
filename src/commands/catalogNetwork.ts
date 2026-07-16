// net.* network commands — exposes core generic capabilities via the command registry (single source of truth).
// net.udp.send: send a UDP datagram to any host:port (delegates to net_udp_send core executor).
// net.udp.request: send UDP and collect responses on the same socket (SSDP / mDNS / DNS).
// net.http.request: arbitrary-origin HTTP request (delegates to net_http_request — runbook api type).
// Webview JS cannot do raw UDP or cross-origin HTTP; the core is the only path. Zero domain lock-in (generic).

import { invoke } from "@tauri-apps/api/core";
import { tmsg } from "../i18n";
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
    description:
      "Send a UDP datagram to any host:port, including broadcast addresses (e.g. Wake-on-LAN). data must be a hex string. Core handles raw UDP that webview JS cannot perform.",
    triggers: { ko: "UDP 전송 네트워크 브로드캐스트 WOL" },
    params: {
      host: {
        type: "string",
        description: "Target host or broadcast address (e.g. 255.255.255.255)",
        required: true,
      },
      port: { type: "number", description: "Target UDP port (e.g. 9)", required: true },
      data: {
        type: "string",
        description: "Bytes to send as a hex string (e.g. ffffffffffff...)",
        required: true,
      },
      broadcast: { type: "boolean", description: "Allow broadcast addresses (255.255.255.255 etc.)" },
    },
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
          message: "data 는 짝수 길이 hex 문자열이어야 함",
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
    description:
      "UDP request-response on a single socket: send data (hex) to host:port, then collect replies for timeoutMs (SSDP discover, mDNS, DNS, etc.). Unicast replies return to the sending port. Each packet includes hex and decoded text.",
    triggers: { ko: "UDP 요청 SSDP mDNS 디스커버리 네트워크검색" },
    params: {
      host: {
        type: "string",
        description: "Target host (e.g. 239.255.255.250 for SSDP)",
        required: true,
      },
      port: { type: "number", description: "Target port (e.g. 1900 for SSDP)", required: true },
      data: { type: "string", description: "Bytes to send as a hex string", required: true },
      timeoutMs: { type: "number", description: "Response collection window in ms (default 3000)" },
      maxPackets: { type: "number", description: "Max packets to collect (default 64)" },
    },
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
          message: "data 는 짝수 길이 hex 문자열이어야 함",
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
    description:
      "Send an arbitrary-origin HTTP request (method/url/headers/query/body) → {status,headers,body}. Core handles cross-origin requests that webview fetch cannot. Secrets are substituted at the Rust boundary from the ns vault (secretSubst: placeholder→secretKey, plaintext never exposed). ns must be explicit from CLI/E2E; plugin runtime uses app.network.http which injects ns automatically. impersonate:\"chrome\" routes the request through the browser-fingerprint (JA3/JA4) backend; \"off\" (default) uses the plain native-tls backend. Authorization requests never follow redirects and are rejected with chrome impersonation because that shared client cannot guarantee a per-request no-redirect policy.",
    triggers: { ko: "HTTP 요청 API호출 웹요청 GET POST 임퍼소네이션 핑거프린트" },
    params: {
      method: { type: "string", description: "HTTP method: GET, POST, PUT, DELETE, PATCH, etc.", required: true },
      url: { type: "string", description: "Request URL", required: true },
      headers: { type: "json", description: "Request headers map" },
      query: { type: "json", description: "Query parameter map" },
      body: { type: "string", description: "Request body as a string" },
      contentType: { type: "string", description: "Content-Type header value" },
      ns: { type: "string", description: "Secret resolution namespace (required when secretSubst is provided)" },
      secretSubst: {
        type: "json",
        description: "placeholder→secretKey map; values are resolved from the ns vault at the Rust boundary, never exposed as plaintext",
      },
      impersonate: {
        type: "string",
        description: "Transport backend: \"off\" (default, plain native-tls) or \"chrome\" (browser JA3/JA4 fingerprint via the wreq backend, to pass fingerprint-blocking CDNs). Same response shape, secret/ns/danger gates either way.",
      },
    },
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
        return { ok: false as const, code: "INVALID_PARAMS" as const, message: "method·url 필요" };
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
