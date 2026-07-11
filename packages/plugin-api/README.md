# @soksak-ai/plugin-api

soksak 플러그인 런타임 API 계약 타입 — `ctx.app.*`, `Plugin`, `PluginContext`. TypeScript 로
플러그인을 짜는 저자를 위한 타입 전용 패키지. **타입만** — 런타임 0.

## Install

```bash
npm i -D @soksak-ai/plugin-api
```

## Use

```ts
import type { Plugin, PluginContext } from "@soksak-ai/plugin-api";

const plugin: Plugin = {
  activate(ctx: PluginContext) {
    ctx.app.ui?.registerView("panel", {
      mount(el) {
        el.textContent = "hello";
      },
      prepareFocusTransfer(el) {
        // Commit this view's transient input synchronously; never inspect another view.
      },
      focus(el, _ctx, { signal }) {
        if (!signal.aborted) el.querySelector("input")?.focus();
      },
    });
  },
};
export default plugin;
```

에디터 자동완성·타입체크용입니다. 강제는 코어가 합니다(설치·등재 시 `parseManifest`) — 이 패키지는
계약을 *보여줄* 뿐입니다. 매니페스트·배치 타입(`PluginManifest`·`ViewPlacement`)은
`@soksak-ai/plugin-spec` 에서 re-export 합니다(중복 0).

단일진실은 soksak 코어이고, 이 패키지는 그 미러입니다. 코어가 `SoksakPluginApi ≡ 이 타입` 양방향
호환을 컴파일로 강제하므로(코어 `apiParity.ts`), 코어 API 가 바뀌면 이 패키지도 반드시 동기됩니다.

## License

MIT
