// media.proxy.* — generic media streaming proxy commands (single source of truth via the registry).
// The webview's hls.js/<video> cannot set a Referer header (forbidden) and is blocked by CORS, so it
// cannot fetch hotlink/CORS-protected media (HLS .m3u8 + binary .ts/fMP4 segments, ranged .mp4). The core
// runs a loopback HTTP proxy that fetches with caller-supplied headers, streams binary with Range support,
// and rewrites m3u8 segment/key URLs back through itself with permissive CORS. Zero site knowledge (generic):
// the caller (plugin) decides which URL + Referer to proxy. Backed by the media_proxy_info core executor.

import { invoke } from "@tauri-apps/api/core";
import { tmsg } from "../i18n";
import { register } from "./registry";

interface ProxyInfo {
  base: string;
  port: number;
  token: string;
}

// Build a proxied URL: {base}/{kind}?url=&referer=&ua= with every value percent-encoded.
function buildProxiedUrl(
  base: string,
  kind: "stream" | "m3u8",
  url: string,
  referer?: string,
  userAgent?: string,
): string {
  let out = `${base}/${kind}?url=${encodeURIComponent(url)}`;
  if (referer) out += `&referer=${encodeURIComponent(referer)}`;
  if (userAgent) out += `&ua=${encodeURIComponent(userAgent)}`;
  return out;
}

export function registerMediaCatalog(): void {
  register("media.proxy.info", {
    description:
      "Return the local media-stream proxy endpoint { base, port, token }. The proxy fetches Referer/CORS-protected media (HLS .m3u8/.ts, ranged .mp4) the webview cannot fetch cross-origin: it injects caller-supplied headers, streams binary with Range support, rewrites m3u8 segment/key URLs, and sets permissive CORS for hls.js / <video>. Build URLs as {base}/m3u8?url=&referer=&ua= or {base}/stream?url=&referer=&ua=.",
    triggers: { ko: "미디어 프록시 스트리밍 엔드포인트 HLS 재생 Referer CORS" },
    params: {},
    returns: "{ base, port, token }",
    message: (d) => tmsg("msg.media.proxy.info", { port: Number(d.port) }),
    danger: "inject",
    errors: ["INTERNAL"],
    examples: ["media.proxy.info"],
    handler: async () => {
      return await invoke<ProxyInfo>("media_proxy_info");
    },
  });

  register("media.proxy.stream", {
    description:
      "Build a proxied URL for a single binary media resource (a .ts/fMP4 segment, key, or ranged .mp4). The proxy forwards Range and injects the given Referer/User-Agent. Returns { url } for use as a <video> src or hls.js segment. Generic: no site knowledge.",
    triggers: { ko: "미디어 프록시 세그먼트 바이너리 스트림 URL" },
    params: {
      url: { type: "string", description: "Upstream media URL to proxy", required: true },
      referer: { type: "string", description: "Referer header to inject (origin is derived from it)" },
      userAgent: { type: "string", description: "User-Agent header to inject (defaults to a browser UA)" },
    },
    returns: "{ url }",
    message: () => tmsg("msg.media.proxy.stream"),
    danger: "inject",
    errors: ["INVALID_PARAMS", "INTERNAL"],
    examples: [
      'media.proxy.stream \'{"url":"https://cdn.example/seg0.ts","referer":"https://page.example/"}\'',
    ],
    handler: async (p) => {
      if (typeof p.url !== "string" || !p.url) {
        return { ok: false as const, code: "INVALID_PARAMS" as const, message: "url 필요" };
      }
      const info = await invoke<ProxyInfo>("media_proxy_info");
      return {
        url: buildProxiedUrl(
          info.base,
          "stream",
          p.url,
          p.referer as string | undefined,
          p.userAgent as string | undefined,
        ),
      };
    },
  });

  register("media.proxy.playlist", {
    description:
      "Build a proxied URL for an HLS playlist (.m3u8). The proxy fetches the playlist with the given Referer/User-Agent and rewrites every segment/key URL back through the proxy so hls.js can play it. Returns { url }. Generic: no site knowledge.",
    triggers: { ko: "미디어 프록시 HLS 플레이리스트 m3u8 URL" },
    params: {
      url: { type: "string", description: "Upstream .m3u8 playlist URL to proxy", required: true },
      referer: { type: "string", description: "Referer header to inject (origin is derived from it)" },
      userAgent: { type: "string", description: "User-Agent header to inject (defaults to a browser UA)" },
    },
    returns: "{ url }",
    message: () => tmsg("msg.media.proxy.playlist"),
    danger: "inject",
    errors: ["INVALID_PARAMS", "INTERNAL"],
    examples: [
      'media.proxy.playlist \'{"url":"https://cdn.example/play.m3u8","referer":"https://page.example/"}\'',
    ],
    handler: async (p) => {
      if (typeof p.url !== "string" || !p.url) {
        return { ok: false as const, code: "INVALID_PARAMS" as const, message: "url 필요" };
      }
      const info = await invoke<ProxyInfo>("media_proxy_info");
      return {
        url: buildProxiedUrl(
          info.base,
          "m3u8",
          p.url,
          p.referer as string | undefined,
          p.userAgent as string | undefined,
        ),
      };
    },
  });
}
