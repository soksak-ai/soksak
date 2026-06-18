// net.* 네트워크 명령 — 코어 범용 capability 를 command registry 로 노출(단일 진실).
// net.udp.send: 임의 host:port 로 UDP 데이터그램 전송(코어 network_udp_send 실행기 위임).
// webview JS 는 raw UDP 불가라 코어를 거치는 유일 경로. LG 전용 아님(WoL·디스커버리·IoT 등 범용).

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

function bytesToHex(bytes: number[]): string {
  return bytes.map((b) => (b & 0xff).toString(16).padStart(2, "0")).join("");
}

// 바이트 → UTF-8 텍스트(SSDP/HTTP-like 응답을 플러그인이 바로 파싱하게). 디코드 실패 시 빈 문자열.
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

  register("net.udp.request", {
    description:
      "UDP 요청-응답 — 한 소켓에서 host:port 로 data(hex) 전송 후 timeoutMs 동안 응답을 수집(SSDP discover·mDNS·DNS 등). 같은 소켓이라 유니캐스트 응답이 송신 포트로 돌아온다. 응답은 hex+text 동반",
    params: {
      host: {
        type: "string",
        description: "목표 호스트(SSDP 는 239.255.255.250)",
        required: true,
      },
      port: { type: "number", description: "목표 포트(SSDP 는 1900)", required: true },
      data: { type: "string", description: "전송 바이트(hex 문자열)", required: true },
      timeoutMs: { type: "number", description: "응답 수집 시간(ms, 기본 3000)" },
      maxPackets: { type: "number", description: "최대 수신 패킷 수(기본 64)" },
    },
    returns: "{ packets: [{ address, port, data(hex), text }] }",
    danger: "inject",
    errors: ["INVALID_PARAMS", "INTERNAL"],
    examples: [
      'sok net.udp.request \'{"host":"239.255.255.250","port":1900,"data":"...","timeoutMs":3000}\'',
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
      const raw = await invoke<CoreUdpPacket[]>("network_udp_request", {
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
}
