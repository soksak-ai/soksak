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
    returns: "{ browserId } — engine-local browser id (use as id in browser.cef.* control commands)",
    errors: ["INTERNAL", "INVALID_PARAMS"],
    examples: [
      'sok browser.cef.create \'{"x":100,"y":100,"w":600,"h":450,"url":"https://example.com"}\'',
    ],
    handler: async (p) => {
      const url = typeof p.url === "string" && p.url ? p.url : "about:blank";
      const browserId = await invoke<number>("cef_browser_create", {
        x: int(p.x, 0),
        y: int(p.y, 0),
        w: int(p.w, 1),
        h: int(p.h, 1),
        url,
      });
      return { browserId };
    },
  });

  const ID_PARAM = { type: "number", description: "Engine-local browser id from browser.cef.create", required: true } as const;

  register("browser.cef.bounds", {
    description:
      "Move/resize a CEF child to a rect (parent-view DIP, top-left origin). Call on pane resize/move so the native Chromium view tracks its slot. Missing id is a no-op (browser may be closed).",
    triggers: { ko: "크롬 CEF 위치 크기 bounds 이동 리사이즈" },
    params: {
      id: ID_PARAM,
      x: { type: "number", description: "x in points (top-left origin)", required: true },
      y: { type: "number", description: "y in points (top-left origin)", required: true },
      w: { type: "number", description: "width in points", required: true },
      h: { type: "number", description: "height in points", required: true },
    },
    returns: "{ ok }",
    errors: ["INTERNAL", "INVALID_PARAMS"],
    examples: ['sok browser.cef.bounds \'{"id":1,"x":150,"y":100,"w":600,"h":450}\''],
    handler: async (p) => {
      await invoke("cef_browser_bounds", { id: int(p.id, 0), x: int(p.x, 0), y: int(p.y, 0), w: int(p.w, 1), h: int(p.h, 1) });
      return { ok: true };
    },
  });

  register("browser.cef.load", {
    description: "Navigate a CEF child to a URL (address-bar go).",
    triggers: { ko: "크롬 CEF 주소 이동 navigate 로드 URL" },
    params: { id: ID_PARAM, url: { type: "string", description: "URL to load", required: true } },
    returns: "{ ok }",
    errors: ["INTERNAL", "INVALID_PARAMS"],
    examples: ['sok browser.cef.load \'{"id":1,"url":"https://example.org"}\''],
    handler: async (p) => {
      await invoke("cef_browser_load", { id: int(p.id, 0), url: typeof p.url === "string" ? p.url : "about:blank" });
      return { ok: true };
    },
  });

  register("browser.cef.reload", {
    description: "Reload a CEF child (ignoreCache=true bypasses the cache).",
    triggers: { ko: "크롬 CEF 새로고침 reload 리로드" },
    params: { id: ID_PARAM, ignoreCache: { type: "boolean", description: "Bypass cache (hard reload)" } },
    returns: "{ ok }",
    errors: ["INTERNAL", "INVALID_PARAMS"],
    examples: ['sok browser.cef.reload \'{"id":1}\''],
    handler: async (p) => {
      await invoke("cef_browser_reload", { id: int(p.id, 0), ignoreCache: p.ignoreCache === true });
      return { ok: true };
    },
  });

  register("browser.cef.back", {
    description: "Go back in a CEF child's history (no-op if none).",
    triggers: { ko: "크롬 CEF 뒤로 back 이전" },
    params: { id: ID_PARAM },
    returns: "{ ok }",
    errors: ["INTERNAL", "INVALID_PARAMS"],
    examples: ['sok browser.cef.back \'{"id":1}\''],
    handler: async (p) => {
      await invoke("cef_browser_back", { id: int(p.id, 0) });
      return { ok: true };
    },
  });

  register("browser.cef.forward", {
    description: "Go forward in a CEF child's history (no-op if none).",
    triggers: { ko: "크롬 CEF 앞으로 forward 다음" },
    params: { id: ID_PARAM },
    returns: "{ ok }",
    errors: ["INTERNAL", "INVALID_PARAMS"],
    examples: ['sok browser.cef.forward \'{"id":1}\''],
    handler: async (p) => {
      await invoke("cef_browser_forward", { id: int(p.id, 0) });
      return { ok: true };
    },
  });

  register("browser.cef.hidden", {
    description:
      "Hide or show a CEF child's native view (hidden=true when its tab is inactive). Frees compositing while hidden without destroying the browser.",
    triggers: { ko: "크롬 CEF 숨김 표시 hidden 탭전환" },
    params: { id: ID_PARAM, hidden: { type: "boolean", description: "true=hide, false=show", required: true } },
    returns: "{ ok }",
    errors: ["INTERNAL", "INVALID_PARAMS"],
    examples: ['sok browser.cef.hidden \'{"id":1,"hidden":true}\''],
    handler: async (p) => {
      await invoke("cef_browser_hidden", { id: int(p.id, 0), hidden: p.hidden === true });
      return { ok: true };
    },
  });

  register("browser.cef.focus", {
    description: "Give keyboard focus to a CEF child.",
    triggers: { ko: "크롬 CEF 포커스 focus 입력" },
    params: { id: ID_PARAM },
    returns: "{ ok }",
    errors: ["INTERNAL", "INVALID_PARAMS"],
    examples: ['sok browser.cef.focus \'{"id":1}\''],
    handler: async (p) => {
      await invoke("cef_browser_focus", { id: int(p.id, 0) });
      return { ok: true };
    },
  });

  register("browser.cef.close", {
    description: "Close and destroy a CEF child. Call on view close.",
    triggers: { ko: "크롬 CEF 닫기 close 종료 파괴" },
    params: { id: ID_PARAM },
    returns: "{ ok }",
    errors: ["INTERNAL", "INVALID_PARAMS"],
    examples: ['sok browser.cef.close \'{"id":1}\''],
    handler: async (p) => {
      await invoke("cef_browser_close", { id: int(p.id, 0) });
      return { ok: true };
    },
  });

  register("browser.cef.popupmode", {
    description:
      "Set how new links (target=_blank / window.open) open across all CEF browsers: asWindow=true → native new OS window, false → cancel the popup and route the URL to a new in-app tab. Reflects the plugin's browserNewWindow setting.",
    triggers: { ko: "크롬 CEF 새링크 새창 새탭 팝업 정책" },
    params: { asWindow: { type: "boolean", description: "true=new OS window, false=new in-app tab", required: true } },
    returns: "{ ok }",
    errors: ["INTERNAL", "INVALID_PARAMS"],
    examples: ['sok browser.cef.popupmode \'{"asWindow":false}\''],
    handler: async (p) => {
      await invoke("cef_browser_popup_mode", { asWindow: p.asWindow === true });
      return { ok: true };
    },
  });
}

// 숫자 파라미터 정규화(정수, 비유한값→기본).
function int(v: unknown, d: number): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.round(v) : d;
}
