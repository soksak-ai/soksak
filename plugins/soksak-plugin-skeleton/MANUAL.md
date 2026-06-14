# soksak 플러그인 개발 매뉴얼 (완전판)

soksak 플러그인을 처음부터 끝까지 만드는 데 필요한 **모든 지식**을 담는다.
실제 스펙(`src/plugins/spec.ts`)과 런타임 API(`src/plugins/api.ts`)에서 검증한 내용이다.

세 가지 질문으로 읽어라:
- **무엇이 가능한가**(능력) → §3 권한, §4 기여, §5 API
- **무엇을 할 수 있는가**(패턴) → §10 고급 패턴
- **무엇을 해야 하는가**(의무) → §7 생명주기, §8 규율, §11 퍼포먼스, §13 체크리스트

---

## 0. 한눈에

- 플러그인 = **git 저장소 하나**. 루트에 `plugin.json`(매니페스트) + `main.js`(단일 ESM 번들).
- 설치 = `~/.soksak/plugins/<id>/` 로 clone. 개발 = `sok plugin.dev.load '{"path":"..."}'`.
- 코드 = `export default { activate(ctx) {…}, deactivate() {} }`. **import 문 금지**(블롭 로드).
- 능력은 **권한(permissions)**으로 선언하고, **기여(contributes)**로 UI/명령/포매터 등을 등록한다.
- 등록물은 전부 **Disposable**(`{dispose()}`)이고 `ctx.subscriptions` 에 넣으면 비활성/리로드 시 자동 해제된다.
- 신뢰 모델 = **full-trust**. 권한은 강제 샌드박스가 아니라 **고지**다. 동의는 사람만 한다.

---

## 1. 플러그인이란 / 배포 모델

- 플러그인은 git 저장소(또는 디렉토리) **하나**다. 루트에:
  - `plugin.json` — 매니페스트(필수)
  - `main.js` — 진입 번들(기본; `entry` 로 변경 가능). **단일 파일**이어야 한다.
  - `README.md` — 설명(공식 플러그인은 필수)
- 설치는 `~/.soksak/plugins/<id>/` 로 clone 된다. **디렉토리 이름 = 플러그인 id**.
- `main.js` 는 **번들된 단일 ESM**이다. 호스트가 blob 으로 로드하므로 **상대/bare import 를 해석하지 못한다** → `import` 문을 쓰면 안 된다(필요한 외부 코드는 번들 시점에 인라인).
- 테마(`~/.soksak/themes`)·플러그인 데이터(`~/.soksak/plugins-data/<id>/`)와 같은 계층이다.

---

## 2. `plugin.json` 매니페스트 — 전 필드

```json
{
  "spec": "soksak-plugin-spec@1",        // 고정값. 스펙 버전
  "id": "soksak-example",                 // 설치 디렉토리명과 일치. 전역 고유
  "name": "예제 플러그인",                // 표시명
  "version": "1.0.0",                     // semver
  "description": "한 줄 설명",
  "entry": "main.js",                     // 진입 번들(생략 시 main.js)
  "permissions": ["ui", "commands"],      // §3
  "contributes": { … }                    // §4
}
```

규칙:
- 선언 안 된 키는 **거부**된다(오타 조기 발견). 위 키만 허용.
- `id` 는 설치 디렉토리명과 같아야 한다(공식 플러그인 테스트가 강제).
- `description`/`name` 등 문자열은 비공백 필수.

---

## 3. 권한 (permissions) — 무엇이 가능한가

권한을 선언해야 그 능력의 API 가 **존재**한다(미선언 시 `app.<area>` 자체가 `undefined`).
full-trust 모델이라 기술적 샌드박스는 아니지만, 동의 화면 고지 + API 게이트의 단일 진실이다.

| 권한 | 능력 |
|---|---|
| `ui` | 콘텐츠/사이드바 뷰 등록(호스트가 배치 소유 — 안전), 아이콘 셋 |
| `ui:statusbar` | 상태바에 항목 추가(크롬 영역) — `app.ui.statusBarItem` |
| `ui:overlay:pane` | 콘텐츠 패널 하나를 덮는 오버레이(그 패널 본문만 가림 — 패널 위 GUI) |
| `ui:overlay:screen` | 앱 전체를 덮는 레이어(크롬·전 패널 위 — 마스코트 효과 등 가장 침습적) |
| `programs` | 메뉴 프로그램 등록(선택 시 터미널 명령 자동 실행 포함) |
| `commands` | registry 명령 실행(danger 없는 것) + **자기 명령 등록** |
| `commands:destructive` | `danger:"destructive"` 명령 실행(닫기·제거) |
| `commands:inject` | `danger:"inject"` 명령 실행(term.send/exec, browser.eval …) |
| `editor` | CM6 확장/언어 매핑/포매터 + 활성 버퍼 읽기/쓰기 |
| `storage` | 전용 저장소(`~/.soksak/plugins-data/<id>/`) 읽기/쓰기 |
| `fs:read` | 임의 경로 파일 읽기 |
| `fs:write` | 임의 경로 파일 쓰기 |
| `terminal` | 터미널 명령 생명주기 관찰(`command.started`/`command.finished` — 명령라인·cwd) + `app.terminal.runningCommands()` |
| `terminal:write` | 터미널 PTY 에 입력 전송 — `app.terminal.sendText(paneId, text)`(관찰보다 강함, 별도 권한) |
| `git:read` | git log/show/diff/status(읽기 전용) |
| `network` | fetch 사용 **고지**(기술 강제 불가 — full-trust, 동의 화면 표기용) |

선언과 기여는 **정합**해야 한다: 예) `contributes.views` 가 있으면 `ui` 권한 필수.

---

## 4. contributes (기여)

선언형으로 호스트에 무엇을 더할지 등록한다. 허용 키: `views`, `commands`, `formatters`,
`languages`, `iconSets`, `programs`.

### 4.1 views (요구 권한: `ui`)
```json
"views": [{
  "id": "list",                       // ^[a-z0-9][a-z0-9-]*$
  "title": { "en": "List", "ko": "목록" },  // LocalizedText
  "icon": "★",                        // 짧은 글리프 1~2자/이모지 (v1 SVG 미지원)
  "placements": ["sidebar-right"],    // sidebar-right | sidebar-left | content
  "defaultPlacement": "sidebar-right" // placements 중 하나(생략 시 placements[0])
}]
```
전역 뷰 키 = `<pluginId>.<viewId>`. 구현은 §5.3 `ui.registerView`.

### 4.2 commands (요구 권한: `commands`)
```json
"commands": [{
  "name": "ping",                          // ^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)*$
  "title": { "en": "Ping", "ko": "핑" }
}]
```
등록명 = `plugin.<pluginId>.<name>`(예 `sok plugin.soksak-example.ping`). **선언 외 등록은 거부**된다.

### 4.3 그 외
- `formatters` — `editor` 권한. 포매터 id 선언 후 `editor.registerFormatter` 로 핸들러 바인딩.
- `languages` — 확장자 ↔ 언어 매핑.
- `iconSets` — `ui` 권한. 시맨틱 아이콘 셋 선언 후 `ui.registerIconSet` 로 데이터 제공.
- `programs` — `programs` 권한. **완전 선언형**(명령형 API 없음 — loader 가 자동 등록).

---

## 5. 런타임 API

`activate(ctx)` 가 받는 컨텍스트:
```ts
ctx = {
  app,            // SoksakPluginApi — 아래 §5.x
  manifest,       // 파싱된 매니페스트
  dir,            // 설치 경로
  subscriptions,  // Disposable[] — 등록물/정리 콜백을 여기 push (§7)
}
```
`app` 의 영역(`commands`/`ui`/`editor`/`storage`/`fs`/`git`)은 **해당 권한이 있을 때만 존재**한다.
항상 `app.commands?` 처럼 옵셔널 체크하거나, 권한을 선언했다고 신뢰하라.

### 5.0 공통
- `app.appVersion` / `app.pluginId`
- `app.locale()` → 현재 호스트 표시 언어(권한 불요). 변경은 `locale.changed` 이벤트.

### 5.1 commands (권한: `commands`)
```ts
app.commands.register(name, {
  description, params?, returns?, examples?, danger?, handler
}): Disposable
app.commands.execute(name, params?): Promise<CommandOutcome>  // { ok, ... }
```
- `name` 은 contributes.commands 에 선언돼 있어야 한다.
- `handler(params) => object | Promise<object>` — 반환 객체가 결과로 직렬화된다.
- `params: Record<string, ParamSpec>` — §6.2.
- 다른 명령 호출: `execute`. danger 명령은 `commands:destructive`/`commands:inject` 권한 필요.

### 5.2 events
```ts
app.events.on(event, (payload) => {…}): Disposable
```
- 호스트 이벤트 구독. 예: `locale.changed`, `bookmarks.changed` 등(PluginEventMap).
- 콜백은 try/catch 경계 안에서 호출된다(실패가 호스트를 죽이지 않음).
- **터미널 명령 생명주기 소켓(권한 `terminal`)** — 폴링 없음(셸 통합 OSC 기반). 코어는
  도메인을 모르고, "특정 명령이 떴는지"로 동작하는 플러그인(예: claude-GUI)이 소유한다:
```ts
app.events.on("command.started", ({ paneId, commandLine, cwd }) => {…})  // 명령 시작(명령라인·cwd)
app.events.on("command.finished", ({ paneId }) => {…})                   // 명령 종료
```
  패널 DOM 은 `document.querySelector('[data-pane-id="<paneId>"]')` 로 찾아 오버레이를 붙인다.
  `terminal` 미선언 시 `command.*` 구독은 거부된다(동의 화면이 이 접근을 표시).

### 5.3 ui (권한: `ui`)
```ts
app.ui.registerView(viewId, {
  mount(container: HTMLElement, ctx: { projectId, root }) {…},
  unmount?(container) {…},
}): Disposable
app.ui.openView(viewId, placement?): Promise<CommandOutcome>
app.ui.registerIconSet(setId, data): Disposable
app.ui.statusBarItem({ id, paneId, label, title?, active?, onClick }): Disposable
```
- 뷰는 **React 비요구** — 호스트가 준 `container` DOM 에 직접 그린다.
- `statusBarItem` — 그 `paneId` 가 활성 터미널인 그룹의 상태바에 항목을 띄운다(같은 `id`
  재호출 = 교체, `active` 토글로 강조 갱신). 토글형 진입점에 쓴다(예: claude-GUI 의 "gui").
- `mount` 는 재호출될 수 있다(재배치/재구성). 이벤트 구독은 `activate` 에서 1회, 마운트별 상태는 `mount` 에서.
- 스타일은 테마 변수(`var(--fg)`, `var(--bg)`, `var(--inset)` …)를 쓰면 테마를 자동 추종한다.
- 외부 데이터는 `textContent` 로(절대 `innerHTML` 로 해석시키지 말 것).

### 5.4 editor (권한: `editor`)
```ts
app.editor.modules           // 호스트의 @codemirror 모듈: { view, state, language }
app.editor.registerEditor({ extension, languages? }): Disposable
app.editor.registerFormatter({ id, format(text, { path, ext }) }): Disposable
```
- **CodeMirror 를 자체 번들하지 말 것** — 인스턴스 이중화로 깨진다. 반드시 `app.editor.modules` 를 쓴다.

### 5.5 storage (권한: `storage`)
```ts
app.storage.read(key): Promise<unknown>
app.storage.write(key, value): Promise<void>
app.storage.list(): Promise<string[]>
```
전용 저장소 `~/.soksak/plugins-data/<id>/`. JSON 직렬화 가능한 값.

### 5.6 fs (권한: `fs:read` / `fs:write`)
```ts
app.fs.read(path)   // fs:read
app.fs.write(path, content)  // fs:write
app.fs.list(path)   // fs:read
```

### 5.7 git (권한: `git:read`)
```ts
app.git.log({…}) / app.git.show(path, commit) / app.git.diff({…}) / app.git.status(path)
```

> 참고: 플러그인은 **원시 `invoke`(Tauri)를 직접 받지 않는다**. 큐레이션된 위 API 만 받는다.
> full-trust 라 `window`/`document` 는 기술적으로 접근 가능하지만(§10 오버레이 패턴이 그 예),
> 가능하면 큐레이션 API 를 써라.

---

## 6. 핵심 타입

### 6.1 Disposable
```ts
interface Disposable { dispose(): void }
```
모든 `register*`/`on` 은 Disposable 을 돌려준다. 직접 만든 정리도 `{ dispose() {…} }` 로.

### 6.2 ParamSpec (명령 파라미터)
```ts
{ type: "string" | "number" | "boolean" | "string[]" | "number[]" | "json",
  description?: string, required?: boolean }
```

### 6.3 LocalizedText
```ts
type LocalizedText = string | Record<string, string>   // "텍스트" 또는 { en, ko, … }
```
객체면 현재 locale 키, 없으면 첫 값을 쓴다.

### 6.4 PluginViewProvider
```ts
{ mount(container: HTMLElement, ctx: { projectId, root: string|null }): void,
  unmount?(container: HTMLElement): void }
```

---

## 7. 생명주기 + 정리 — 무엇을 해야 하는가

```js
export default {
  activate(ctx) {
    // 1) 등록(뷰/명령/이벤트) — 반환 Disposable 을 ctx.subscriptions 에 push
    ctx.subscriptions.push(ctx.app.commands.register("ping", { … }));
    ctx.subscriptions.push(ctx.app.events.on("locale.changed", () => { … }));
    // 2) 직접 만든 리소스(타이머/리스너/DOM)도 dispose 로 정리 등록
    const t = setInterval(…);
    ctx.subscriptions.push({ dispose() { clearInterval(t); } });
  },
  deactivate() { /* subscriptions 는 호스트가 자동 해제 — 보통 빈 함수 */ },
};
```
- **모든 부수효과는 subscriptions 로 되돌릴 수 있어야 한다**(리로드/비활성 시 잔여 0).
- `activate`/`mount`/`format`/이벤트 콜백은 호스트의 try/catch 경계 안에서 돈다 — 던져도 호스트는 안 죽지만 `status:"error"` 로 표시된다.

---

## 8. 규율 (MUST / MUST NOT)

- **[MUST]** `export default { activate }` 단일 ESM. **`import` 문 금지**(블롭 로드).
- **[MUST]** 등록물·부수효과를 `ctx.subscriptions` 로 정리 가능하게.
- **[MUST]** 선언(permissions/contributes)과 사용 정합. 선언 외 명령/뷰 등록은 거부.
- **[MUST NOT]** 침묵 실패. 실패는 에러 텍스트/`status:"error"` 로 드러내라.
- **[MUST NOT]** 자기증식. 플러그인 API 에서 `plugin.*` 관리 명령(enable/install …) 호출은 차단된다.
- **[MUST NOT]** CodeMirror/중복 런타임 자체 번들. `app.editor.modules` 사용.
- **[SHOULD]** 외부 데이터는 `textContent`. 테마 변수로 스타일. 큐레이션 API 우선.

---

## 9. 보안·신뢰·동의 모델

- **full-trust(§0-2)**: 플러그인은 앱과 같은 컨텍스트에서 돈다. 권한은 **샌드박스 강제가 아니라 고지**다. 신뢰할 수 있는 코드만 설치하라.
- **동의는 사람만(§0-5)**: 원격(sok/MCP)의 `plugin.enable` 은 기록된 동의 없으면 `CONSENT_REQUIRED` 로 거부. 플러그인이 스스로 다른 플러그인을 켜는 자기증식은 불가.
- **dev 예외**: 개발자가 로컬 경로를 직접 지정해 적재한 자기 작업물(`plugin.dev.load`, `danger:"inject"`)은 동의 게이트 밖(제3자 위험 고지 대상 아님).
- **실패 격리(§0-4)**: 한 플러그인의 예외가 호스트를 죽이지 못한다.

---

## 10. 고급 패턴

### 10.1 떠다니는 오버레이 / 마스코트 (브라우저 위)
sidebar/content 뷰 모델에 안 맞는 **자유 위치 오버레이**(HUD·마스코트)는 full-trust 를
활용해 직접 만든다:
```js
const layer = document.createElement("div");
layer.style.cssText =
  "position:fixed;inset:0;z-index:2147483000;pointer-events:none;overflow:hidden;contain:strict";
document.body.appendChild(layer);
// … 안에 내용을 그리고, rAF 로 움직이고, dispose 에서 layer.remove()
```
- **브라우저 패널 위에도 그려진다**: 브라우저 패널은 네이티브 child webview 지만, soksak 의
  **레이어 역전**(메인 webview DOM 이 항상 브라우저 webview 위에 합성됨) 덕에 메인 webview 의
  불투명 DOM 은 브라우저 위에 보인다. (모달·메뉴가 브라우저 위에 뜨는 것과 동일 원리.)
- **`pointer-events:none`** 으로 앱/브라우저 조작을 방해하지 마라. 마우스 반응이 필요하면
  `window` 에 `mousemove` 패시브 리스너로 좌표만 읽어라(브라우저 영역 위에선 이벤트가 안 올 수 있음 — 한계).

### 10.2 명령으로 토글/설정
상태(보임/모드/속도 등)는 `commands.register` 로 노출해 `sok plugin.<id>.<cmd>` 로 제어.

---

## 11. 퍼포먼스 — 부가물은 앱에 영향을 주면 안 된다

- **격리된 합성 레이어**: 오버레이는 `position:fixed` + `contain:strict`, 움직이는 요소는
  `will-change:transform` + `contain:layout style paint`. 그러면 그 레이어만 재합성되고
  **앱 본문(터미널)은 리페인트되지 않는다**. 위치는 `top/left` 가 아니라 `transform` 으로.
- **프레임 상한**: 부가 애니메이션은 30fps 등으로 캡(rAF 누적 + 임계). 비용 절반.
- **안 보일 때 정지**: `visibilitychange` + 토글 off 시 `cancelAnimationFrame` 으로 **완전 정지**.
  (WebKit 은 가려진 창의 rAF 를 throttle 하므로 자연 절감도 있음.)
- **매 프레임 레이아웃 읽기 0**: `innerWidth/Height`·`getBoundingClientRect` 를 루프에서 읽지 마라 — 캐시하고 `resize` 때만 갱신.
- **리스너는 필요할 때만 + passive**: 예) 반응형 모드일 때만 `mousemove` 부착.

---

## 12. 개발·테스트·설치 흐름

```
# 개발 로드(동의 게이트 밖, 핫 반영은 plugin.reload)
sok plugin.dev.load '{"path":"/abs/path/to/your-plugin"}'
sok plugin.reload                      # 전체 재적재(디렉토리 재스캔 + 활성 재활성화)

# 명령 호출
sok plugin.<id>.<command> '{"arg":1}'

# 배포: 이 폴더를 git 저장소로 두고, 사용자는 ~/.soksak/plugins/<id>/ 로 clone
```
검증: 매니페스트가 `parseManifest` 를 통과해야 하고(거부 사유 0), `main.js` 는 `import` 없는
단일 ESM(`export default` 포함)이어야 한다.

---

## 13. 출시 전 체크리스트

- [ ] `plugin.json` 의 `id` = 디렉토리명, 허용 키만, 권한·기여 정합.
- [ ] `main.js` 에 `import` 문 없음, `export default { activate }` 있음, 단일 파일.
- [ ] 모든 등록물·부수효과가 `ctx.subscriptions` 로 정리됨(리로드 시 잔여 0).
- [ ] 실패를 침묵하지 않음(에러 표면화).
- [ ] (UI/오버레이면) 테마 변수 사용, `textContent`, 퍼포먼스 격리(§11).
- [ ] `README.md` 존재.

---

이 매뉴얼은 `main.js`(동작하는 최소 예제)와 함께 본다. 예제가 §5~§7 을 코드로 보여준다.
