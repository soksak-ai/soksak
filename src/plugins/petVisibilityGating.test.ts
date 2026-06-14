import { afterEach, describe, expect, it, vi } from "vitest";

// 플러그인 main.js 는 선언형 single-file(d.ts 없음) — 동적 import 형태만 단언.
type PetModule = { default: { activate(ctx: unknown): void } };

// 펫 플러그인(상어/벚꽃) 회귀 가드 — "안 볼 때 멈춘다"는 visibility 로 판정해야 한다(focus 가 아니라).
//
// 버그: 게이팅이 document.hasFocus()/window blur 에 걸려 있었다. 내장 브라우저는 메인 webview 와
// 별개인 네이티브 child webview 라, 브라우저로 포커스가 가면 메인 창에 blur 가 뜬다 → 펫이 멈췄다.
// 그러나 사용자는 같은 soksak 창을 보고 있으므로 멈추면 안 된다. "보고 있나"의 옳은 신호는
// Page Visibility(document.visibilityState) 이지 키보드 포커스가 아니다.
//
// RED(수정 전): blur 에 cancelAnimationFrame 이 불려 정지 → 첫 테스트 실패.
// GREEN(수정 후): blur 무시(visibility 만 본다) → 첫 테스트 통과. 둘째 테스트(가려지면 정지)는 불변 가드.

let hidden = false;
let origGetContext: typeof HTMLCanvasElement.prototype.getContext;

function installEnv() {
  let id = 0;
  const raf = vi.fn(() => ++id); // 자동 호출 안 함 — 게이팅 배선(start/stop)만 검증.
  const caf = vi.fn();
  vi.stubGlobal("requestAnimationFrame", raf);
  vi.stubGlobal("cancelAnimationFrame", caf);
  vi.stubGlobal("Path2D", class {}); // jsdom 미구현 — 벚꽃 잎 패스 스텁.
  // jsdom 미구현 canvas 2d → 모든 메서드/프로퍼티 no-op 스텁.
  origGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = (() =>
    new Proxy({}, { get: () => () => {} })) as unknown as typeof origGetContext;
  // 기본 환경: 보임 + 포커스 있음.
  hidden = false;
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => (hidden ? "hidden" : "visible"),
  });
  document.hasFocus = () => true;
  return { raf, caf };
}

function setHidden(v: boolean) {
  hidden = v;
  document.dispatchEvent(new Event("visibilitychange"));
}

// ctx.app.events.on 으로 등록된 핸들러를 잡아 테스트에서 직접 트리거(app.focus 등).
function mockCtx() {
  const disp = { dispose() {} };
  const handlers = new Map<string, (p: unknown) => void>();
  const ctx = {
    subscriptions: [] as unknown[],
    app: {
      commands: { register: () => disp },
      events: {
        on: (event: string, fn: (p: unknown) => void) => {
          handlers.set(event, fn);
          return disp;
        },
      },
    },
  };
  return { ctx, fire: (event: string, p: unknown) => handlers.get(event)?.(p) };
}

const plugins = [
  // @ts-expect-error 플러그인 main.js 는 선언형 single-file(d.ts 없음) — 런타임 동적 import 만.
  { name: "shark", load: () => import("../../plugins/soksak-shark/main.js") as Promise<PetModule> },
  // @ts-expect-error 위와 동일.
  { name: "sakura", load: () => import("../../plugins/soksak-sakura/main.js") as Promise<PetModule> },
];

describe.each(plugins)("$name 펫 — visibility 게이팅", ({ load }) => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    HTMLCanvasElement.prototype.getContext = origGetContext;
    delete (document as unknown as Record<string, unknown>).hidden;
    delete (document as unknown as Record<string, unknown>).visibilityState;
  });

  it("내장 브라우저 포커스(window blur)에도 계속 돈다", async () => {
    const env = installEnv();
    const mod = (await load()) as PetModule;
    mod.default.activate(mockCtx().ctx);
    expect(env.raf).toHaveBeenCalled(); // activate 시 구동(보임+활성)
    const cancelsBefore = env.caf.mock.calls.length;
    window.dispatchEvent(new Event("blur")); // 내장 브라우저로 포커스 이동(DOM blur)
    expect(env.caf.mock.calls.length).toBe(cancelsBefore); // 정지 안 함
  });

  it("창이 가려지면(visibilitychange→hidden) 멈춘다", async () => {
    const env = installEnv();
    const mod = (await load()) as PetModule;
    mod.default.activate(mockCtx().ctx);
    setHidden(true);
    expect(env.caf).toHaveBeenCalled(); // 안 보이면 0비용 정지(불변 가드)
  });

  it("앱이 비활성(app.focus=false)이면 멈추고, 재활성이면 재개한다", async () => {
    const env = installEnv();
    const mod = (await load()) as PetModule;
    const { ctx, fire } = mockCtx();
    mod.default.activate(ctx);
    expect(env.raf).toHaveBeenCalled(); // 시작 시 활성 가정 → 구동
    fire("app.focus", { focused: false }); // 다른 앱으로 전환(메인 창 key 잃음)
    expect(env.caf).toHaveBeenCalled(); // 안 보니 정지
    const startsBefore = env.raf.mock.calls.length;
    fire("app.focus", { focused: true }); // soksak 으로 복귀
    expect(env.raf.mock.calls.length).toBeGreaterThan(startsBefore); // 재개
  });
});
