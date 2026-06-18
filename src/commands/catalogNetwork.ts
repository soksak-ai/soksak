// net.* 네트워크 명령 — 코어 범용 capability 를 command registry 로 노출(단일 진실).
// net.udp.send: 임의 host:port 로 UDP 데이터그램 전송(코어 network_udp_send 실행기 위임).
// net.http.request: 임의 출처 HTTP 요청(코어 network_http_request 위임 — runbook api 실행타입).
// webview JS 는 raw UDP/임의출처 HTTP 불가라 코어를 거치는 유일 경로. 특정 용도 락인 0(범용).

import { invoke } from "@tauri-apps/api/core";
import { register } from "./registry";

// hex 문자열 → 바이트 배열. 짝수 길이 + [0-9a-fA-F] 만 허용, 아니면 null(호출자가 INVALID_PARAMS).
function hexToBytes(hex: string): number[] | null {
  const s = hex.trim().replace(/\s+/g, "");
  if (s.length === 0 || s.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(s)) return null;
  const out: number[] = [];
  for (let i = 0; i < s.length; i += 2) out.push(parseInt(s.slice(i, i + 2), 16));
  return out;
}

export function registerNetworkCatalog(): void {
  register("net.udp.send", {
    description:
      "임의 host:port 로 UDP 데이터그램 전송(브로드캐스트 포함 — Wake-on-LAN 등). data 는 hex 문자열. webview JS 가 못 하는 raw UDP 를 코어가 대행",
    params: {
      host: {
        type: "string",
        description: "목표 호스트/브로드캐스트 주소(예: 255.255.255.255)",
        required: true,
      },
      port: { type: "number", description: "목표 UDP 포트(예: 9)", required: true },
      data: {
        type: "string",
        description: "전송 바이트(hex 문자열, 예: ffffffffffff...)",
        required: true,
      },
      broadcast: { type: "boolean", description: "브로드캐스트 허용(255.255.255.255 등)" },
    },
    returns: "{ bytesSent }",
    danger: "inject",
    errors: ["INVALID_PARAMS", "INTERNAL"],
    examples: [
      'sok net.udp.send \'{"host":"255.255.255.255","port":9,"data":"ffffffffffff","broadcast":true}\'',
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
      const bytesSent = await invoke<number>("network_udp_send", {
        host: p.host,
        port: p.port,
        data: bytes,
        broadcast: (p.broadcast as boolean | undefined) ?? null,
      });
      return { bytesSent };
    },
  });

  register("net.http.request", {
    description:
      "임의 출처 HTTP 요청(method/url/headers/query/body) → {status,headers,body}. webview fetch 가 못 하는 임의 출처를 코어가 대행. 시크릿은 ns 볼트에서 Rust 경계 치환(secretSubst=placeholder→key, 평문 무노출). ns 는 명시(CLI/E2E 운영자 신뢰) — 플러그인 런타임은 app.network.http 가 ns 자동주입",
    params: {
      method: { type: "string", description: "GET|POST|PUT|DELETE|PATCH 등", required: true },
      url: { type: "string", description: "요청 URL", required: true },
      headers: { type: "json", description: "요청 헤더 맵" },
      query: { type: "json", description: "쿼리 파라미터 맵" },
      body: { type: "string", description: "요청 바디(문자열)" },
      contentType: { type: "string", description: "Content-Type 헤더" },
      ns: { type: "string", description: "시크릿 해소 네임스페이스(secretSubst 있을 때 필수)" },
      secretSubst: {
        type: "json",
        description: "placeholder→secretKey(ns 볼트에서 Rust 경계 치환, 평문 무노출)",
      },
    },
    returns: "{ status, headers, body }",
    danger: "inject",
    errors: ["INVALID_PARAMS", "INTERNAL"],
    examples: [
      'sok net.http.request \'{"method":"GET","url":"https://api.example.com/v1/ping"}\'',
    ],
    handler: async (p) => {
      if (typeof p.method !== "string" || typeof p.url !== "string") {
        return { ok: false as const, code: "INVALID_PARAMS" as const, message: "method·url 필요" };
      }
      return await invoke<{ status: number; headers: Record<string, string>; body: string }>(
        "network_http_request",
        {
          method: p.method,
          url: p.url,
          headers: (p.headers as Record<string, string> | undefined) ?? null,
          query: (p.query as Record<string, string> | undefined) ?? null,
          body: (p.body as string | undefined) ?? null,
          contentType: (p.contentType as string | undefined) ?? null,
          ns: (p.ns as string | undefined) ?? null,
          secretSubst: (p.secretSubst as Record<string, string> | undefined) ?? null,
        },
      );
    },
  });
}
