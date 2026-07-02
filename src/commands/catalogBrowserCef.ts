// browser.cef.* — 코어의 인프로세스 CEF(Chromium) 엔진 표면. 엔진 플러그인
// (soksak-plugin-browser-cef)이 이 커맨드로 자기 pane 슬롯에 네이티브 Chromium child 를 붙인다
// (set_as_child, JS 미경유 = 네이티브 크롬 속도). 코어는 엔진과 강결합하지 않는다 — 이 커맨드는
// cef-browser feature + SOKSAK_CEF env 게이트 뒤에서만 실동작하고, 미빌드 시 명확한 에러를 돌려준다.
// rect 은 부모 NSView(창 contentView) 좌표계의 DIP(포인트) — 슬롯 정렬은 호출측(플러그인)이 ui.slot 로
// 잰 rect 을 dpr/원점 규칙에 맞춰 넘긴다.
import { invoke } from "@tauri-apps/api/core";
import { register } from "./registry";

export function registerBrowserCefCatalog(): void {
  register("browser.cef.create", {
    description:
      "Embed an in-process Chromium (CEF) child view in the calling window at a rect (parent NSView DIP/points). Returns an engine-local browser id. Requires the core built with the cef-browser feature and SOKSAK_CEF=1; otherwise returns INTERNAL with a clear message. The rect is the caller's present-target — an engine plugin measures its slot via ui.slot and passes device-independent coords here.",
    triggers: { ko: "크롬 CEF 브라우저 임베드 생성 엔진 chromium" },
    params: {
      x: { type: "number", description: "Child x in parent-view points", required: true },
      y: { type: "number", description: "Child y in parent-view points", required: true },
      w: { type: "number", description: "Child width in points", required: true },
      h: { type: "number", description: "Child height in points", required: true },
      url: { type: "string", description: "Initial URL to load", required: true },
    },
    returns: "{ id } — engine-local browser id",
    errors: ["INTERNAL", "INVALID_PARAMS"],
    examples: [
      'sok browser.cef.create \'{"x":100,"y":100,"w":600,"h":450,"url":"https://example.com"}\'',
    ],
    handler: async (p) => {
      const n = (v: unknown, d: number): number => (typeof v === "number" && Number.isFinite(v) ? v : d);
      const url = typeof p.url === "string" && p.url ? p.url : "about:blank";
      const id = await invoke<number>("cef_browser_create", {
        x: Math.round(n(p.x, 0)),
        y: Math.round(n(p.y, 0)),
        w: Math.round(n(p.w, 1)),
        h: Math.round(n(p.h, 1)),
        url,
      });
      return { id };
    },
  });
}
